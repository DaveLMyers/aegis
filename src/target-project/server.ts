import express from 'express';
import { createTieredRateLimit } from './rateLimit.js';
import { createLinksRouter } from './routes.js';
import { createDb } from './db.js';
import { startClickConsumer } from './analytics.js';

export function createServer(dbPath?: string) {
  const db = createDb(dbPath);
  startClickConsumer(db);
  const app = express();
  app.use(express.json());
  app.use('/:code', createTieredRateLimit(db));
  app.use('/', createLinksRouter(db));
  return app;
}
