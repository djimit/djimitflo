import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from './helpers/test-db';
import { createSegmlRoutes } from '../routes/segml';
import { errorHandler } from '../middleware/error-handler';

describe('SEGML HTTP contracts', () => {
  let server: Server | undefined;
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    db?.close();
    server = undefined;
    db = undefined;
  });

  it('rejects malformed cycle-history limits before SQLite access', async () => {
    db = createTestDb();
    const app = express();
    app.use('/segml', createSegmlRoutes(db));
    app.use(errorHandler);
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const value of ['NaN', '0', '101', '1.5']) {
      const response = await fetch(`${base}/segml/history?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    const valid = await fetch(`${base}/segml/history?limit=1`);
    expect(valid.status).toBe(200);
    expect((await valid.json()).cycles).toEqual([]);

    app.use('/api/segml', createSegmlRoutes(db));
    expect((await fetch(`${base}/api/segml/generated-cases`)).status).toBe(200);
    const judge = await fetch(`${base}/api/segml/judge-rubrics`);
    expect(judge.status, await judge.text()).toBe(200);
    expect((await fetch(`${base}/api/segml/curriculum`)).status).toBe(200);
    expect((await fetch(`${base}/api/segml/latest`)).status).toBe(404);
    expect((await fetch(`${base}/api/segml/blind-spots/missing`)).status).toBe(404);
  });
});
