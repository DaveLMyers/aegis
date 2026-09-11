import { Router } from 'express';
import type { AegisDb } from './db.js';
import { generateUniqueCode } from './codeGen.js';
import { publishClick } from './analytics.js';

export function createLinksRouter(db: AegisDb): Router {
  const router = Router();

  router.post('/links', (req, res) => {
    const { targetUrl, alias, expiresAt, clientTier } = req.body ?? {};
    if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
      res.status(400).json({ error: 'targetUrl is required' });
      return;
    }
    let code: string = alias;
    if (code) {
      const existing = db.prepare('SELECT 1 FROM links WHERE code = ?').get(code);
      if (existing) {
        res.status(409).json({ error: `alias "${code}" is already taken` });
        return;
      }
    } else {
      code = generateUniqueCode(db);
    }
    const createdAt = new Date().toISOString();
    const tier = clientTier === 'premium' ? 'premium' : 'standard';
    db.prepare(
      'INSERT INTO links (code, target_url, client_tier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(code, targetUrl, tier, createdAt, expiresAt ?? null);
    res.status(201).json({ code, targetUrl, clientTier: tier, createdAt, expiresAt: expiresAt ?? null });
  });

  router.get('/:code', (req, res) => {
    const link = db.prepare('SELECT * FROM links WHERE code = ?').get(req.params.code) as
      | { code: string; target_url: string; expires_at: string | null }
      | undefined;
    if (!link) {
      res.status(404).json({ error: 'short link not found' });
      return;
    }
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      res.status(410).json({ error: 'short link has expired' });
      return;
    }
    publishClick({ code: link.code, ts: new Date().toISOString(), referrer: req.get('referer') ?? null });
    res.redirect(302, link.target_url);
  });

  router.get('/:code/stats', (req, res) => {
    const link = db.prepare('SELECT * FROM links WHERE code = ?').get(req.params.code) as
      | { client_tier: string }
      | undefined;
    if (!link) {
      res.status(404).json({ error: 'short link not found' });
      return;
    }
    const clickCount = db
      .prepare('SELECT COUNT(*) as count FROM click_events WHERE code = ?')
      .get(req.params.code) as { count: number };
    const lastClick = db
      .prepare('SELECT ts FROM click_events WHERE code = ? ORDER BY ts DESC LIMIT 1')
      .get(req.params.code) as { ts: string } | undefined;
    const base = {
      code: req.params.code,
      clientTier: link.client_tier,
      clicks: clickCount.count,
      lastClickAt: lastClick?.ts ?? null,
    };
    if (link.client_tier !== 'premium') {
      res.json(base);
      return;
    }
    const referrerBreakdown = db
      .prepare(
        "SELECT COALESCE(referrer, 'direct') as referrer, COUNT(*) as count FROM click_events WHERE code = ? GROUP BY referrer ORDER BY count DESC",
      )
      .all(req.params.code);
    res.json({ ...base, referrerBreakdown });
  });

  return router;
}
