import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createMemoryRoutes } from '../routes/memory';
import { errorHandler } from '../middleware/error-handler';

describe('proactive memory route pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before memory reads or embedding work', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/memory', createMemoryRoutes(db, passthroughAuth)).use(errorHandler);
    for (const path of ['/memory/top', '/memory/search?q=governance']) {
      for (const value of ['NaN', '0', '1.5', '101', '-1']) {
        const response = await request(app).get(`${path}${path.includes('?') ? '&' : '?'}limit=${value}`);
        expect(response.status, `${path}:${value}`).toBe(400);
        expect(response.body.error.code, `${path}:${value}`).toBe('VALIDATION_ERROR');
      }
    }
  });
});
