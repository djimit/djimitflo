import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createConsoleRoutes } from '../routes/console';
import { errorHandler } from '../middleware/error-handler';

describe('console and platform route execution', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('serves every console projection from the current SQLite state', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use('/console', createConsoleRoutes(db, auth)).use(errorHandler);
    const responses = await Promise.all([
      request(app).get('/console/overview'),
      request(app).get('/console/capabilities'),
      request(app).get('/console/gates'),
      request(app).get('/console/memory'),
      request(app).get('/console/models'),
      request(app).get('/console/audit'),
      request(app).get('/console/improvements'),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/json/);
    }
  });

});
