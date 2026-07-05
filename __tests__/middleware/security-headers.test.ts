import request from 'supertest';
import express from 'express';
import { securityHeaders } from '../middleware/security-headers';

const app = express();
app.use(securityHeaders);
app.get('/test', (req, res) => res.json({ ok: true }));

describe('Security Headers Middleware', () => {
  it('should set Content-Security-Policy header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('should set Strict-Transport-Security header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
  });

  it('should set X-Frame-Options header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('should set X-Content-Type-Options header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should set X-XSS-Protection header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['x-xss-protection']).toBe('1; mode=block');
  });

  it('should allow configuration overrides', async () => {
    const appCustom = express();
    appCustom.use(securityHeaders({ 'X-Frame-Options': 'SAMEORIGIN' }));
    appCustom.get('/test', (req, res) => res.json({ ok: true }));
    const res = await request(appCustom).get('/test');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
