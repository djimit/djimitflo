import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createKnowledgeRoutes } from '../routes/knowledge';
import { createMultiModelRoutes } from '../routes/multi-model';
import { errorHandler } from '../middleware/error-handler';

describe('knowledge and multi-model pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before claim or model reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = {
      requireAuth: (_req: any, _res: any, next: any) => next(),
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any;
    const app = express()
      .use('/knowledge', createKnowledgeRoutes(auth, db))
      .use('/models', createMultiModelRoutes(db, auth))
      .use(errorHandler);
    for (const path of ['/knowledge/events', '/models/best/coding']) {
      const response = await request(app).get(`${path}?limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects malformed model registration and outcome payloads before mutation', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = {
      requireAuth: (_req: any, _res: any, next: any) => next(),
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any;
    const app = express().use(express.json()).use('/models', createMultiModelRoutes(db, auth)).use(errorHandler);
    for (const body of [
      { modelId: 'model', modelName: 'Model' },
      { modelId: 'model', modelName: 'Model', provider: 'ollama', costPerMtok: -1 },
      { modelId: 'model', modelName: 'Model', provider: 'ollama', capabilities: [{ taskType: 'coding', successRate: 2 }] },
    ]) {
      const response = await request(app).post('/models/register').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const routeResponse = await request(app).post('/models/route').send({ taskType: 'coding', minSuccessRate: 2 });
    expect(routeResponse.status).toBe(400);
    const outcomeResponse = await request(app).post('/models/outcome').send({ modelId: 'model', taskType: 'coding', success: 'true' });
    expect(outcomeResponse.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_capabilities').get()).toEqual({ count: 0 });
  });
});
