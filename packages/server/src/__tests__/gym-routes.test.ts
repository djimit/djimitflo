import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from './helpers/test-db';
import { createGymRoutes } from '../routes/gym';
import { errorHandler } from '../middleware/error-handler';

describe('gym HTTP contracts', () => {
  let server: Server | undefined;
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed governance-history limits before SQLite access', async () => {
    db = createTestDb();
    const app = express();
    app.use('/gym', createGymRoutes(db));
    app.use(errorHandler);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const value of ['NaN', '0', '101', '1.5']) {
      const response = await fetch(`${base}/gym/governance/skill-a/history?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/gym/governance/skill-a/history?limit=1`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).history).toEqual([]);
    app.use('/api/gym', createGymRoutes(db));
    expect((await fetch(`${base}/api/gym/governance/skill-a`)).status).toBe(200);
    expect((await fetch(`${base}/api/gym/governance/skill-a/curriculum`)).status).toBe(200);
    expect((await fetch(`${base}/api/gym/governance/skill-a/history?limit=1`)).status).toBe(200);
  });
});
