import express from 'express';
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
  return app;
}
