import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { configureProxyTrust } from '../config/proxy-trust';

describe('reverse proxy trust', () => {
  it('trusts the private nginx hop but not direct Tailscale or public peers', async () => {
    const app = express();
    configureProxyTrust(app);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));

    const trust = app.get('trust proxy fn') as (address: string, hop: number) => boolean;
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('172.21.0.1', 0)).toBe(true);
    expect(trust('100.86.47.122', 0)).toBe(false);
    expect(trust('203.0.113.10', 0)).toBe(false);

    await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.23')
      .expect(200, { ip: '198.51.100.23' });
  });
});
