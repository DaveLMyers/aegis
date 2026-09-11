import { describe, it, expect } from 'vitest';
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

    const redirectRes = await request(app).get(`/${createRes.body.code}`);
    expect(redirectRes.status).toBe(302);
  });

  it('defaults new links to the standard tier', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com/standard' });
    expect(createRes.body.clientTier).toBe('standard');
  });
});
