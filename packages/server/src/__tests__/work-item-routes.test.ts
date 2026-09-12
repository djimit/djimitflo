import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createWorkItemRoutes } from '../routes/work-items';
import { errorHandler } from '../middleware/error-handler';

describe('work-item list pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before durable work-item reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/work-items', createWorkItemRoutes(db, passthroughAuth)).use(errorHandler);
    for (const value of ['NaN', '0', '1.5', '501', '-1']) {
      const response = await request(app).get(`/work-items?limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(response.body.error.code, value).toBe('VALIDATION_ERROR');
    }
  });
});
