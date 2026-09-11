import Database from 'better-sqlite3';
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
  db.exec(`
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
  `);
  return db;
}

export type AegisDb = ReturnType<typeof createDb>;
