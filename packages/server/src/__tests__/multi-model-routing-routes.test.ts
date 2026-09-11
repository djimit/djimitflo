import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createMultiModelRoutes } from '../routes/multi-model';
import { errorHandler } from '../middleware/error-handler';

describe('multi-model routing capability chain', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('registers models, learns outcomes, routes by measured capability, and exposes proof state', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = {
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any;
    const app = express()
      .use(express.json())
      .use('/models', createMultiModelRoutes(db, auth))
      .use(errorHandler);

    const preferred = await request(app).post('/models/register').send({
      modelId: 'astra', modelName: 'GPT-6 Astra', provider: 'openai', costPerMtok: 5,
      capabilities: [{ taskType: 'coding', successRate: 0.9 }],
    });
    expect(preferred.status).toBe(201);
    const economical = await request(app).post('/models/register').send({
      modelId: 'economical', modelName: 'Economical Coder', provider: 'ollama', costPerMtok: 1,
      capabilities: [{ taskType: 'coding', successRate: 0.6 }],
    });
    expect(economical.status).toBe(201);

    for (const success of [true, true]) {
      expect((await request(app).post('/models/outcome').send({
        modelId: 'astra', taskType: 'coding', success, score: 0.95, latencyMs: 100,
      })).status).toBe(200);
      expect((await request(app).post('/models/outcome').send({
        modelId: 'economical', taskType: 'coding', success: false, score: 0.2, latencyMs: 50,
      })).status).toBe(200);
    }

    const decision = await request(app).post('/models/route').send({
      taskType: 'coding', minSuccessRate: 0.8, maxCost: 10,
    });
    expect(decision.status).toBe(200);
    expect(decision.body.selectedModel).toBe('astra');
    expect(decision.body.alternatives).toEqual([]);

    const best = await request(app).get('/models/best/coding?limit=2');
    expect(best.status).toBe(200);
    expect(best.body.models[0]).toMatchObject({ modelId: 'astra', sampleCount: 2 });

    const status = await request(app).get('/models/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ totalModels: 2, activeModels: 2, totalCapabilities: 2, routingDecisions: 1 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM model_execution_outcomes').get() as { count: number }).count).toBe(4);
  });
});
