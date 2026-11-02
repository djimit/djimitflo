import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createApexRoutes } from '../routes/apex';
import { errorHandler } from '../middleware/error-handler';

describe('Apex vector-memory route validation', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed search limits before invoking the embedding provider', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/apex', createApexRoutes(db, passthroughAuth, false)).use(errorHandler);
    for (const value of ['NaN', '0', '1.5', '101', '-1']) {
      const response = await request(app).get(`/apex/memory/search?q=typescript&limit=${value}`);
      expect(response.status, value).toBe(400);
      expect(response.body.error.code, value).toBe('VALIDATION_ERROR');
    }
  });

  it('returns typed 404 for unknown worker lifecycle operations', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/apex', createApexRoutes(db, passthroughAuth, false)).use(errorHandler);
    for (const path of ['/apex/workers/missing-worker/start', '/apex/workers/missing-worker/stop']) {
      const response = await request(app).post(path).send({});
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('WORKER_NOT_FOUND');
    }
  });

  it('executes the canonical LLM provider, performance and stats chain', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express()
      .use(express.json())
      .use('/api/apex', createApexRoutes(db, passthroughAuth, false))
      .use(errorHandler);

    expect((await request(app).get('/api/apex/llm/providers')).status).toBe(200);
    expect((await request(app).post('/api/apex/llm/performance').send({
      provider: 'openai', taskType: 'coding', success: true, latencyMs: 12, costDollars: 0.01,
    })).status).toBe(200);
    expect((await request(app).get('/api/apex/llm/stats')).status).toBe(200);
  });

  it('answers an explicit 503 unavailable when no provider is eligible (INT-001)', async () => {
    const db = createTestDb();
    dbs.push(db);
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'LITELLM_API_KEY']) vi.stubEnv(key, undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    try {
      const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
      const app = express().use(express.json()).use('/api/apex', createApexRoutes(db, passthroughAuth, false)).use(errorHandler);
      await request(app).post('/api/apex/llm/performance').send({ provider: 'ollama', taskType: 'coding', success: true, latencyMs: 5 });
      const response = await request(app).post('/api/apex/llm/route').send({ taskType: 'coding', prompt: 'p' });
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ available: false, taskType: 'coding' });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
