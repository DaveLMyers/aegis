import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/target-project/server.js';

describe('premium-tier analytics (ambiguous requirement resolution)', () => {
  it('includes a referrer breakdown for premium-tier links', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app)
      .post('/links')
      .send({ targetUrl: 'https://example.com/premium-analytics', clientTier: 'premium' });
    const { code } = createRes.body;
    await request(app).get(`/${code}`).set('Referer', 'https://partner.example.com');

    const statsRes = await request(app).get(`/${code}/stats`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.referrerBreakdown).toBeDefined();
    expect(Array.isArray(statsRes.body.referrerBreakdown)).toBe(true);
  });

  it('omits the referrer breakdown for standard-tier links', async () => {
    const app = createServer(':memory:');
    const createRes = await request(app).post('/links').send({ targetUrl: 'https://example.com/standard-analytics' });
    const { code } = createRes.body;
    await request(app).get(`/${code}`);

    const statsRes = await request(app).get(`/${code}/stats`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.referrerBreakdown).toBeUndefined();
  });
});
