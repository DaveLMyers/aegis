import type { NextFunction, Request, Response } from 'express';
import type { AegisDb } from './db.js';

const WINDOW_MS = 60_000;
const LIMITS_BY_TIER: Record<string, number> = {
  standard: 60,
  premium: 600,
};

const hits = new Map<string, { count: number; windowStart: number }>();

/**
 * Tiered rate limiting: premium/partner clients get a materially higher
 * request budget than standard clients. Tier is resolved per short code from
 * the link's client_tier column, since that's the unit the API already
 * reasons about (no separate auth/account system exists in this prototype).
 */
export function createTieredRateLimit(db: AegisDb) {
  return function tieredRateLimit(req: Request, res: Response, next: NextFunction): void {
    const code = req.params.code as string | undefined;
    let tier = 'standard';
    if (code) {
      const link = db.prepare('SELECT client_tier FROM links WHERE code = ?').get(code) as
        | { client_tier: string }
        | undefined;
      if (link?.client_tier) tier = link.client_tier;
    }
    const limit = LIMITS_BY_TIER[tier] ?? LIMITS_BY_TIER.standard;
    const key = `${req.ip ?? 'unknown'}:${tier}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      hits.set(key, { count: 1, windowStart: now });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.status(429).json({ error: `rate limit exceeded for ${tier} tier`, tier, limit });
      return;
    }
    next();
  };
}
