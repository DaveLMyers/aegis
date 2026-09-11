import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/target-project/server.js';

describe('url shortener API', () => {
  it('creates a short link and redirects to the target', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com' });
    expect(createRes.status).toBe(201);
    const { code } = createRes.body;
    expect(code).toBeTruthy();

    const redirectRes = await request(app).get(`/${code}`);
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.location).toBe('https://example.com');
  });

  it('tracks click analytics', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com/stats-test' });
    const { code } = createRes.body;
    await request(app).get(`/${code}`);
    const statsRes = await request(app).get(`/${code}/stats`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.clicks).toBeGreaterThanOrEqual(1);
  });

  it('rejects creating a link without a targetUrl', async () => {
    const app = createServer(':memory:');
    const res = await request(app).post('/links').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown short code', async () => {
    const app = createServer(':memory:');
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
