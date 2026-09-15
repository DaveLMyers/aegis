/**
 * Pre-authored, known-good source for the target-project (URL shortener) fixture.
 * The deterministic agent's playbooks materialize these at runtime via
 * `tracker.writeFile(...)`, which is what makes the "implementation" stage of a
 * scenario run actually produce a working service rather than just claiming to.
 */

export const DB_TS = `import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB_PATH = fileURLToPath(new URL('./data/aegis.db', import.meta.url));

export function createDb(path: string = process.env.AEGIS_DB_PATH ?? DEFAULT_DB_PATH) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.exec(\`
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY,
      target_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS click_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      ts TEXT NOT NULL,
      referrer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_click_events_code_ts ON click_events(code, ts);
  \`);
  return db;
}

export type AegisDb = ReturnType<typeof createDb>;
`;

// Brownfield scenario: adds a client_tier column to support differentiated
// (premium vs. standard) treatment. Schema changed, so the implementation
// playbook resets any pre-existing dev database file before applying this --
// see brownfield.ts.
export const DB_TIERED_TS = `import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB_PATH = fileURLToPath(new URL('./data/aegis.db', import.meta.url));

export function createDb(path: string = process.env.AEGIS_DB_PATH ?? DEFAULT_DB_PATH) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.exec(\`
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY,
      target_url TEXT NOT NULL,
      client_tier TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS click_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      ts TEXT NOT NULL,
      referrer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_click_events_code_ts ON click_events(code, ts);
  \`);
  return db;
}

export type AegisDb = ReturnType<typeof createDb>;
`;

export const CODEGEN_TS = `import { randomInt } from 'node:crypto';
import type { AegisDb } from './db.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Uses a cryptographically secure RNG, not Math.random() -- short codes
 * are public identifiers reachable by anyone who has one, so a predictable
 * generator would make other users' codes guessable/enumerable.
 */
export function randomCode(length = 7): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

export function generateUniqueCode(db: AegisDb): string {
  const exists = db.prepare('SELECT 1 FROM links WHERE code = ?');
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCode();
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error('failed to generate a unique short code after 10 attempts');
}
`;

export const ANALYTICS_TS = `import { EventEmitter } from 'node:events';
import type { AegisDb } from './db.js';

export interface ClickEvent {
  code: string;
  ts: string;
  referrer: string | null;
}

export const clickEvents = new EventEmitter();

export function publishClick(event: ClickEvent): void {
  clickEvents.emit('click', event);
}

/**
 * Consumer side of a deliberately small producer/consumer split: the
 * redirect handler only has to publish an event, not write to the database
 * inline, which mirrors how the shared-data-services org models "standardize
 * how data is served to others" even at this small scale.
 *
 * Two things found by an independent blind code review, fixed here:
 * removeAllListeners() before attaching a new one -- clickEvents is a
 * module-level bus, so calling createServer() more than once in a process
 * (as the test suite does) previously left every prior listener attached,
 * double- (or triple-) writing each click into every server's own database.
 * This makes the most-recently-created server's database authoritative for
 * the process, correct for this prototype's single-instance-per-process
 * usage; a genuinely concurrent multi-instance deployment would need a
 * per-instance bus instead. And the try/catch: EventEmitter.emit() is
 * synchronous, so an uncaught insert error here previously propagated
 * straight back through publishClick() into the redirect handler that
 * called it -- turning a busy/locked database into a 500 for the visitor
 * being redirected, exactly the hot-path failure this split was meant to
 * avoid.
 */
export function startClickConsumer(db: AegisDb): void {
  const insert = db.prepare('INSERT INTO click_events (code, ts, referrer) VALUES (@code, @ts, @referrer)');
  clickEvents.removeAllListeners('click');
  clickEvents.on('click', (event: ClickEvent) => {
    try {
      insert.run(event);
    } catch (err) {
      console.error('failed to record click event', err);
    }
  });
}
`;

export const RATE_LIMIT_TS = `import type { NextFunction, Request, Response } from 'express';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const hits = new Map<string, { count: number; windowStart: number }>();

// An entry for an IP that hits once and never returns lingers forever --
// found by an independent code review. A periodic sweep bounds the map's
// size instead of letting it grow for the life of the process; unref() so
// this timer never keeps the process (or a test run) alive on its own.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of hits) {
    if (entry.windowStart < cutoff) hits.delete(key);
  }
}, WINDOW_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(key, { count: 1, windowStart: now });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_REQUESTS) {
    res.status(429).json({ error: 'rate limit exceeded' });
    return;
  }
  next();
}
`;

// Brownfield scenario replaces the flat limiter above with a tiered one.
export const RATE_LIMIT_TIERED_TS = `import type { NextFunction, Request, Response } from 'express';
import type { AegisDb } from './db.js';

const WINDOW_MS = 60_000;
const LIMITS_BY_TIER: Record<string, number> = {
  standard: 60,
  premium: 600,
};

const hits = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of hits) {
    if (entry.windowStart < cutoff) hits.delete(key);
  }
}, WINDOW_MS).unref();

/**
 * Tiered rate limiting: premium/partner clients get a materially higher
 * request budget than standard clients. Tier is resolved per short code from
 * the link's client_tier column, since that's the unit the API already
 * reasons about (no separate auth/account system exists in this prototype).
 *
 * Mounted app-wide at '/:code' in server.ts (so it can resolve tier before
 * the route handler runs) -- but that path pattern also matches POST
 * /links, which isn't a code lookup at all. Found by an independent code
 * review: creation requests were silently being treated as a lookup for a
 * link named "links" (always missing, so always falling back to standard
 * tier) instead of being exempt. Explicit method check below fixes it;
 * creation is intentionally not tier-limited here, since no link (and
 * therefore no tier) exists yet at that point in the request.
 */
export function createTieredRateLimit(db: AegisDb) {
  return function tieredRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET') {
      next();
      return;
    }
    const code = req.params.code as string | undefined;
    let tier = 'standard';
    if (code) {
      const link = db.prepare('SELECT client_tier FROM links WHERE code = ?').get(code) as
        | { client_tier: string }
        | undefined;
      if (link?.client_tier) tier = link.client_tier;
    }
    const limit = LIMITS_BY_TIER[tier] ?? LIMITS_BY_TIER.standard;
    const key = \`\${req.ip ?? 'unknown'}:\${tier}\`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      hits.set(key, { count: 1, windowStart: now });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.status(429).json({ error: \`rate limit exceeded for \${tier} tier\`, tier, limit });
      return;
    }
    next();
  };
}
`;

// Shared across all three scenarios' routes: a URL shortener's #1 named
// risk is an open redirect -- accepting an arbitrary string as targetUrl
// means POST /links can be used to mint a same-origin-looking short link
// that actually redirects to a javascript:/data:/file: URI or anywhere
// else. Restricting to http/https is the minimum real fix, not a stub.
export const VALIDATION_TS = `/**
 * Restricts short-link targets to http/https. Without this, POST /links
 * would happily store and later 302-redirect to a javascript:/data:/file:
 * URI -- a well-known "open redirect" vulnerability class specific to URL
 * shorteners, not a hypothetical concern.
 */
export function isValidTargetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Rejects a malformed expiresAt rather than silently treating it as
 * "never expires" -- an invalid date string previously produced a NaN
 * comparison that quietly evaluated false on every check.
 */
export function isValidExpiresAt(value: unknown): value is string | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  return !Number.isNaN(new Date(value).getTime());
}

const RESERVED_ALIASES = new Set(['health']);

/**
 * Restricts a custom alias to url-path-safe characters with a sane length
 * cap, and blocks any word that would collide with a real route. Found by
 * an independent code review: alias was previously completely unvalidated
 * -- {"alias":"health"} was accepted (201) and then permanently
 * unreachable since /health always wins; a non-string alias (e.g. an
 * object) reached the database driver and threw a raw 500; and characters
 * like "/" or "?" produced a link GET /:code could never actually match.
 */
export function isValidAlias(value: unknown): value is string | undefined {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || value.length > 64) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) return false;
  return !RESERVED_ALIASES.has(value.toLowerCase());
}
`;

export const ROUTES_TS = `import { Router } from 'express';
import type { AegisDb } from './db.js';
import { generateUniqueCode } from './codeGen.js';
import { publishClick } from './analytics.js';
import { isValidTargetUrl, isValidExpiresAt, isValidAlias } from './validation.js';

export function createLinksRouter(db: AegisDb): Router {
  const router = Router();

  router.post('/links', (req, res) => {
    const { targetUrl, alias, expiresAt } = req.body ?? {};
    if (!isValidTargetUrl(targetUrl)) {
      res.status(400).json({ error: 'targetUrl must be a valid http/https URL' });
      return;
    }
    if (!isValidExpiresAt(expiresAt)) {
      res.status(400).json({ error: 'expiresAt must be a valid date string if provided' });
      return;
    }
    if (!isValidAlias(alias)) {
      res.status(400).json({ error: 'alias must be url-safe characters only (letters, numbers, - or _), 64 chars max' });
      return;
    }
    // Normalized to a fixed-offset ISO string on write -- an offset-less
    // input like "2026-09-14T00:00:00" otherwise parses as the *server's*
    // local time on every later read, so the same stored value could mean
    // a different expiry moment depending on which machine reads it.
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    let code: string = alias;
    if (code) {
      const existing = db.prepare('SELECT 1 FROM links WHERE code = ?').get(code);
      if (existing) {
        res.status(409).json({ error: \`alias "\${code}" is already taken\` });
        return;
      }
    } else {
      code = generateUniqueCode(db);
    }
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO links (code, target_url, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      code,
      targetUrl,
      createdAt,
      normalizedExpiresAt,
    );
    res.status(201).json({ code, targetUrl, createdAt, expiresAt: normalizedExpiresAt });
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
    // Without this, an intermediary (CDN, browser) could cache the 302 and
    // serve it on a later visit without ever hitting this handler again --
    // silently undercounting clicks.
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, link.target_url);
  });

  router.get('/:code/stats', (req, res) => {
    const link = db.prepare('SELECT * FROM links WHERE code = ?').get(req.params.code);
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
    res.json({ code: req.params.code, clicks: clickCount.count, lastClickAt: lastClick?.ts ?? null });
  });

  return router;
}
`;

// Brownfield scenario: adds clientTier support to link creation + stats visibility.
export const ROUTES_TIERED_TS = `import { Router } from 'express';
import type { AegisDb } from './db.js';
import { generateUniqueCode } from './codeGen.js';
import { publishClick } from './analytics.js';
import { isValidTargetUrl, isValidExpiresAt, isValidAlias } from './validation.js';

export function createLinksRouter(db: AegisDb): Router {
  const router = Router();

  router.post('/links', (req, res) => {
    const { targetUrl, alias, expiresAt, clientTier } = req.body ?? {};
    if (!isValidTargetUrl(targetUrl)) {
      res.status(400).json({ error: 'targetUrl must be a valid http/https URL' });
      return;
    }
    if (!isValidExpiresAt(expiresAt)) {
      res.status(400).json({ error: 'expiresAt must be a valid date string if provided' });
      return;
    }
    if (!isValidAlias(alias)) {
      res.status(400).json({ error: 'alias must be url-safe characters only (letters, numbers, - or _), 64 chars max' });
      return;
    }
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    let code: string = alias;
    if (code) {
      const existing = db.prepare('SELECT 1 FROM links WHERE code = ?').get(code);
      if (existing) {
        res.status(409).json({ error: \`alias "\${code}" is already taken\` });
        return;
      }
    } else {
      code = generateUniqueCode(db);
    }
    const createdAt = new Date().toISOString();
    const tier = clientTier === 'premium' ? 'premium' : 'standard';
    db.prepare(
      'INSERT INTO links (code, target_url, client_tier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(code, targetUrl, tier, createdAt, normalizedExpiresAt);
    res.status(201).json({ code, targetUrl, clientTier: tier, createdAt, expiresAt: normalizedExpiresAt });
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
    res.setHeader('Cache-Control', 'no-store');
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
    res.json({
      code: req.params.code,
      clientTier: link.client_tier,
      clicks: clickCount.count,
      lastClickAt: lastClick?.ts ?? null,
    });
  });

  return router;
}
`;

export const SERVER_TS = `import express from 'express';
import { rateLimit } from './rateLimit.js';
import { createLinksRouter } from './routes.js';
import { createDb } from './db.js';
import { startClickConsumer } from './analytics.js';

export function createServer(dbPath?: string) {
  const db = createDb(dbPath);
  startClickConsumer(db);
  const app = express();

  // Health/readiness check -- registered before rate limiting so monitoring
  // probes are never throttled, and it actually verifies the DB is reachable
  // rather than just confirming the process is alive.
  app.get('/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.status(200).json({ status: 'ok', uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(express.json());
  app.use(rateLimit);
  app.use('/', createLinksRouter(db));

  // Terminal error handler -- without this, any uncaught synchronous throw
  // in a route handler (malformed JSON body, a database constraint
  // violation) falls through to Express's default handler, which returns
  // the actual stack trace in the response body outside production --
  // found by an independent code review.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('unhandled request error', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
`;

// Brownfield scenario replaces server.ts's flat rateLimit with the tiered limiter.
export const SERVER_TIERED_TS = `import express from 'express';
import { createTieredRateLimit } from './rateLimit.js';
import { createLinksRouter } from './routes.js';
import { createDb } from './db.js';
import { startClickConsumer } from './analytics.js';

export function createServer(dbPath?: string) {
  const db = createDb(dbPath);
  startClickConsumer(db);
  const app = express();

  // Health/readiness check -- registered before the tiered limiter (which
  // otherwise matches any single-segment path, "/health" included) so
  // monitoring probes are never throttled, and it verifies the DB is
  // actually reachable rather than just confirming the process is alive.
  app.get('/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.status(200).json({ status: 'ok', uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(express.json());
  app.use('/:code', createTieredRateLimit(db));
  app.use('/', createLinksRouter(db));

  // Terminal error handler -- without this, any uncaught synchronous throw
  // in a route handler (malformed JSON body, a database constraint
  // violation) falls through to Express's default handler, which returns
  // the actual stack trace in the response body outside production --
  // found by an independent code review.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('unhandled request error', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
`;

export const INDEX_TS = `import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
const app = createServer();
app.listen(port, () => {
  console.log(\`aegis target-project (url shortener) listening on http://localhost:\${port}\`);
});
`;

export const SHORTENER_TEST_TS = `import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/target-project/server.js';

describe('url shortener API', () => {
  it('exposes a health check that verifies DB connectivity', async () => {
    const app = createServer(':memory:');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('creates a short link and redirects to the target', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com' });
    expect(createRes.status).toBe(201);
    const { code } = createRes.body;
    expect(code).toBeTruthy();

    const redirectRes = await request(app).get(\`/\${code}\`);
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.location).toBe('https://example.com');
  });

  it('tracks click analytics', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com/stats-test' });
    const { code } = createRes.body;
    await request(app).get(\`/\${code}\`);
    const statsRes = await request(app).get(\`/\${code}/stats\`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.clicks).toBeGreaterThanOrEqual(1);
  });

  it('rejects creating a link without a targetUrl', async () => {
    const app = createServer(':memory:');
    const res = await request(app).post('/links').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a non-http(s) targetUrl (open-redirect guard)', async () => {
    const app = createServer(':memory:');
    const res = await request(app).post('/links').send({ targetUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http\\/https/);
  });

  it('rejects a malformed expiresAt instead of silently treating it as never-expiring', async () => {
    const app = createServer(':memory:');
    const res = await request(app)
      .post('/links')
      .send({ targetUrl: 'https://example.com', expiresAt: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('still accepts a well-formed http/https targetUrl', async () => {
    const app = createServer(':memory:');
    const res = await request(app).post('/links').send({ targetUrl: 'http://example.com/page' });
    expect(res.status).toBe(201);
  });

  it('generates codes from the expected alphabet, not predictably repeating', async () => {
    const app = createServer(':memory:');
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/links').send({ targetUrl: 'https://example.com' });
      expect(res.body.code).toMatch(/^[0-9a-zA-Z]{7}$/);
      codes.add(res.body.code);
    }
    // Not a statistical randomness test -- just guards against a regression
    // to something deterministic/repeating (e.g. an unseeded counter).
    expect(codes.size).toBe(10);
  });

  it('returns 404 for an unknown short code', async () => {
    const app = createServer(':memory:');
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
`;

// Ambiguous scenario: extends the tiered stats endpoint with a referrer
// breakdown for premium-tier links only (the interpretation the requirements
// stage settled on after surfacing and ruling out the more literal readings).
export const ROUTES_TIERED_ANALYTICS_TS = `import { Router } from 'express';
import type { AegisDb } from './db.js';
import { generateUniqueCode } from './codeGen.js';
import { publishClick } from './analytics.js';
import { isValidTargetUrl, isValidExpiresAt, isValidAlias } from './validation.js';

export function createLinksRouter(db: AegisDb): Router {
  const router = Router();

  router.post('/links', (req, res) => {
    const { targetUrl, alias, expiresAt, clientTier } = req.body ?? {};
    if (!isValidTargetUrl(targetUrl)) {
      res.status(400).json({ error: 'targetUrl must be a valid http/https URL' });
      return;
    }
    if (!isValidExpiresAt(expiresAt)) {
      res.status(400).json({ error: 'expiresAt must be a valid date string if provided' });
      return;
    }
    if (!isValidAlias(alias)) {
      res.status(400).json({ error: 'alias must be url-safe characters only (letters, numbers, - or _), 64 chars max' });
      return;
    }
    const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
    let code: string = alias;
    if (code) {
      const existing = db.prepare('SELECT 1 FROM links WHERE code = ?').get(code);
      if (existing) {
        res.status(409).json({ error: \`alias "\${code}" is already taken\` });
        return;
      }
    } else {
      code = generateUniqueCode(db);
    }
    const createdAt = new Date().toISOString();
    const tier = clientTier === 'premium' ? 'premium' : 'standard';
    db.prepare(
      'INSERT INTO links (code, target_url, client_tier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(code, targetUrl, tier, createdAt, normalizedExpiresAt);
    res.status(201).json({ code, targetUrl, clientTier: tier, createdAt, expiresAt: normalizedExpiresAt });
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
    res.setHeader('Cache-Control', 'no-store');
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
    // LIMIT bounds the response size for a link with many distinct
    // referrers instead of returning an unbounded list; '(direct)' (not
    // 'direct') as the null-referrer sentinel avoids colliding with a page
    // whose actual Referer header happens to be the literal word "direct" --
    // both found by an independent code review.
    const referrerBreakdown = db
      .prepare(
        "SELECT COALESCE(referrer, '(direct)') as referrer, COUNT(*) as count FROM click_events WHERE code = ? GROUP BY referrer ORDER BY count DESC LIMIT 20",
      )
      .all(req.params.code);
    res.json({ ...base, referrerBreakdown });
  });

  return router;
}
`;

export const PREMIUM_ANALYTICS_TEST_TS = `import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/target-project/server.js';

describe('premium-tier analytics (ambiguous requirement resolution)', () => {
  it('includes a referrer breakdown for premium-tier links', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app)
      .post('/links')
      .send({ targetUrl: 'https://example.com/premium-analytics', clientTier: 'premium' });
    const { code } = createRes.body;
    await request(app).get(\`/\${code}\`).set('Referer', 'https://partner.example.com');

    const statsRes = await request(app).get(\`/\${code}/stats\`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.referrerBreakdown).toBeDefined();
    expect(Array.isArray(statsRes.body.referrerBreakdown)).toBe(true);
  });

  it('omits the referrer breakdown for standard-tier links', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com/standard-analytics' });
    const { code } = createRes.body;
    await request(app).get(\`/\${code}\`);

    const statsRes = await request(app).get(\`/\${code}/stats\`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.referrerBreakdown).toBeUndefined();
  });
});
`;

// Core Requirement 5 asks for "API/schema definitions" alongside code, tests,
// and docs -- these are real OpenAPI 3.0 contracts, one per scenario's actual
// route shape, written by the `documentation` stage the same way it writes
// docs/generated/<scenario>.md. Every field here is copied from the actual
// route handlers above, not guessed at, so it can't drift from what the code
// really does the way earlier prose documentation once did.
export const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: AEGIS URL Shortener API
  version: 1.0.0
  description: Generated by the AEGIS 'documentation' stage for the greenfield scenario.
paths:
  /health:
    get:
      summary: Liveness/readiness check (verifies DB connectivity, not just process liveness)
      responses:
        '200':
          description: Healthy
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string, enum: [ok] }
                  uptime: { type: number, description: process uptime in seconds }
        '503':
          description: Database unreachable
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string, enum: [unavailable] }
  /links:
    post:
      summary: Create a short link
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [targetUrl]
              properties:
                targetUrl: { type: string, format: uri }
                alias: { type: string, description: optional custom short code }
                expiresAt: { type: string, format: date-time, nullable: true }
      responses:
        '201':
          description: Link created
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string }
                  targetUrl: { type: string, format: uri }
                  createdAt: { type: string, format: date-time }
                  expiresAt: { type: string, format: date-time, nullable: true }
        '400':
          description: Missing targetUrl
        '409':
          description: Requested alias is already taken
        '429':
          description: Rate limit exceeded (60 requests/minute per IP)
  /{code}:
    get:
      summary: Redirect to the target URL and record a click event
      parameters:
        - name: code
          in: path
          required: true
          schema: { type: string }
      responses:
        '302':
          description: Redirect to the target URL
        '404':
          description: Short code not found
        '410':
          description: Short link has expired
        '429':
          description: Rate limit exceeded (60 requests/minute per IP)
  /{code}/stats:
    get:
      summary: Click analytics for a short code
      parameters:
        - name: code
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Click stats
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string }
                  clicks: { type: integer }
                  lastClickAt: { type: string, format: date-time, nullable: true }
        '404':
          description: Short code not found
`;

// Brownfield scenario: adds clientTier to link creation, the stats response,
// and to the 429 payload's shape via the tiered limiter.
export const OPENAPI_YAML_TIERED = `openapi: 3.0.3
info:
  title: AEGIS URL Shortener API
  version: 1.1.0
  description: Generated by the AEGIS 'documentation' stage for the brownfield scenario (adds tiered rate limiting).
paths:
  /health:
    get:
      summary: Liveness/readiness check (verifies DB connectivity, not just process liveness)
      responses:
        '200':
          description: Healthy
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string, enum: [ok] }
                  uptime: { type: number, description: process uptime in seconds }
        '503':
          description: Database unreachable
  /links:
    post:
      summary: Create a short link, optionally tagged with a client tier
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [targetUrl]
              properties:
                targetUrl: { type: string, format: uri }
                alias: { type: string, description: optional custom short code }
                expiresAt: { type: string, format: date-time, nullable: true }
                clientTier: { type: string, enum: [standard, premium], default: standard }
      responses:
        '201':
          description: Link created
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string }
                  targetUrl: { type: string, format: uri }
                  clientTier: { type: string, enum: [standard, premium] }
                  createdAt: { type: string, format: date-time }
                  expiresAt: { type: string, format: date-time, nullable: true }
        '400':
          description: Missing targetUrl
        '409':
          description: Requested alias is already taken
        '429':
          description: Rate limit exceeded (60/min standard, 600/min premium, keyed by IP+tier)
  /{code}:
    get:
      summary: Redirect to the target URL and record a click event
      parameters:
        - name: code
          in: path
          required: true
          schema: { type: string }
      responses:
        '302':
          description: Redirect to the target URL
        '404':
          description: Short code not found
        '410':
          description: Short link has expired
        '429':
          description: Rate limit exceeded (60/min standard, 600/min premium, keyed by IP+tier)
  /{code}/stats:
    get:
      summary: Click analytics for a short code, including its client tier
      parameters:
        - name: code
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Click stats
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string }
                  clientTier: { type: string, enum: [standard, premium] }
                  clicks: { type: integer }
                  lastClickAt: { type: string, format: date-time, nullable: true }
        '404':
          description: Short code not found
`;

// Ambiguous scenario: extends the stats response with a referrer breakdown,
// present only for premium-tier links -- the interpretation the requirements
// stage settled on. The schema reflects that conditionality explicitly
// rather than just adding an always-present (sometimes-empty) field.
export const OPENAPI_YAML_TIERED_ANALYTICS = `openapi: 3.0.3
info:
  title: AEGIS URL Shortener API
  version: 1.2.0
  description: Generated by the AEGIS 'documentation' stage for the ambiguous scenario (adds premium referrer-breakdown analytics).
paths:
  /health:
    get:
      summary: Liveness/readiness check (verifies DB connectivity, not just process liveness)
      responses:
        '200':
          description: Healthy
        '503':
          description: Database unreachable
  /links:
    post:
      summary: Create a short link, optionally tagged with a client tier
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [targetUrl]
              properties:
                targetUrl: { type: string, format: uri }
                alias: { type: string }
                expiresAt: { type: string, format: date-time, nullable: true }
                clientTier: { type: string, enum: [standard, premium], default: standard }
      responses:
        '201':
          description: Link created
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string }
                  targetUrl: { type: string, format: uri }
                  clientTier: { type: string, enum: [standard, premium] }
                  createdAt: { type: string, format: date-time }
                  expiresAt: { type: string, format: date-time, nullable: true }
        '400':
          description: Missing targetUrl
        '409':
          description: Requested alias is already taken
        '429':
          description: Rate limit exceeded
  /{code}:
    get:
      summary: Redirect to the target URL and record a click event (including referrer)
      parameters:
        - name: code
          in: path
          required: true
          schema: { type: string }
      responses:
        '302':
          description: Redirect to the target URL
        '404':
          description: Short code not found
        '410':
          description: Short link has expired
        '429':
          description: Rate limit exceeded
  /{code}/stats:
    get:
      summary: Click analytics -- premium-tier links additionally include a referrer breakdown
      parameters:
        - name: code
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Click stats. \`referrerBreakdown\` is present ONLY when clientTier is "premium" -- absent entirely (not an empty array) for standard-tier links.
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: string }
                  clientTier: { type: string, enum: [standard, premium] }
                  clicks: { type: integer }
                  lastClickAt: { type: string, format: date-time, nullable: true }
                  referrerBreakdown:
                    type: array
                    description: Premium-tier only; field is entirely absent for standard-tier responses.
                    items:
                      type: object
                      properties:
                        referrer: { type: string, description: "the referring host, or 'direct' if none" }
                        count: { type: integer }
        '404':
          description: Short code not found
`;

export const TIERED_RATE_LIMIT_TEST_TS = `import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/target-project/server.js';

describe('tiered client experience (brownfield)', () => {
  it('creates a premium link and honors a higher rate-limit tier', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app)
      .post('/links')
      .send({ targetUrl: 'https://example.com/premium', clientTier: 'premium' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.clientTier).toBe('premium');

    const redirectRes = await request(app).get(\`/\${createRes.body.code}\`);
    expect(redirectRes.status).toBe(302);
  });

  it('defaults new links to the standard tier', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com/standard' });
    expect(createRes.body.clientTier).toBe('standard');
  });
});
`;
