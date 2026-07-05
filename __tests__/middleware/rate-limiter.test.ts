import request from 'supertest';
import express from 'express';
import { rateLimiter } from '../middleware/rate-limiter';

const app = express();
app.use(rateLimiter({ windowMs: 1000, max: 2 }));
app.get('/test', (req, res) => res.json({ ok: true }));

describe('Rate Limiter Middleware', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should allow requests within limit', async () => {
    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);
    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
  });

  it('should block requests exceeding limit', async () => {
    await request(app).get('/test');
    await request(app).get('/test');
    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(429);
    expect(res3.body.error).toBe('Too many requests');
  });

  it('should reset after window expires', async () => {
    await request(app).get('/test');
    await request(app).get('/test');
    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(429);

    jest.advanceTimersByTime(1000);
    const res4 = await request(app).get('/test');
    expect(res4.status).toBe(200);
  });

  it('should handle burst by allowing short bursts within limit', async () => {
    // Simulate burst: 2 requests quickly then a third (blocked)
    const res1 = await request(app).get('/test');
    const res2 = await request(app).get('/test');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(429);
  });

  it('should include Retry-After header', async () => {
    await request(app).get('/test');
    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
