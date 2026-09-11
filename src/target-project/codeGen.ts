import type { AegisDb } from './db.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomCode(length = 7): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
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
