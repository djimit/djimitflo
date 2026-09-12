import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

describe('swarm pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before panel, hypothesis or mission reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/swarms', createSwarmRoutes(db, passthroughAuth)).use(errorHandler);
    for (const path of ['/swarms/specialist-panels', '/swarms/intelligence/hypotheses', '/swarms/intelligence/missions']) {
      const response = await request(app).get(`${path}?limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });
});
