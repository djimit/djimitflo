import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createUsageRoutes } from '../routes/usage';
import { errorHandler } from '../middleware/error-handler';

describe('usage route chain', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('persists token logs and projects usage, cost, quota, model and recent views', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.exec(`
      CREATE TABLE provider_configs (id TEXT PRIMARY KEY, provider TEXT UNIQUE NOT NULL, base_url TEXT, subscription_tier TEXT NOT NULL, token_quota_hourly INTEGER, token_quota_daily INTEGER, token_quota_weekly INTEGER, token_quota_monthly INTEGER, rate_limit_rpm INTEGER, rate_limit_rpd INTEGER, cost_per_1k_prompt_tokens REAL, cost_per_1k_completion_tokens REAL, is_active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE token_usage_log (id TEXT PRIMARY KEY, task_id TEXT, discussion_id TEXT, agent_id TEXT, model TEXT NOT NULL, task_type TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, cost_estimate REAL, metadata TEXT, created_at TEXT, updated_at TEXT, provider TEXT NOT NULL, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_create_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, duration_ms INTEGER, timestamp TEXT NOT NULL);
    `);
    db.prepare(`INSERT INTO provider_configs (id, provider, base_url, subscription_tier, token_quota_daily, cost_per_1k_prompt_tokens, cost_per_1k_completion_tokens) VALUES ('provider-1','openai','https://api.openai.com/v1','metered',1000,1,2)`).run();
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/usage', createUsageRoutes(db, auth)).use(errorHandler);

    const inserted = await request(app).post('/usage/tokens').send({ logs: [{ id: 'usage-1', provider: 'openai', model: 'gpt-6-astra', task_type: 'task', prompt_tokens: 4, completion_tokens: 6, latency_ms: 12 }] });
    expect(inserted.status).toBe(201);
    expect(inserted.body).toMatchObject({ inserted: 1, count: 1 });
    db.prepare('UPDATE token_usage_log SET cost = 1.25 WHERE id = ?').run('usage-1');

    const tokens = await request(app).get('/usage/tokens?provider=openai&group_by=provider');
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ total_tokens: 10, total_cost: 1.25 });
    expect(tokens.body.breakdown[0]).toMatchObject({ provider: 'openai', tokens: 10 });
    const costs = await request(app).get('/usage/costs?provider=openai');
    expect(costs.status).toBe(200);
    expect(costs.body).toMatchObject({ total_cost: 1.25 });
    const quotas = await request(app).get('/usage/quotas');
    expect(quotas.status).toBe(200);
    expect(quotas.body.quotas[0]).toMatchObject({ provider: 'openai', tokens_used_daily: 10, quota_daily: 1000 });
    const models = await request(app).get('/usage/available-models');
    expect(models.status).toBe(200);
    expect(models.body.models[0]).toMatchObject({ provider: 'openai', base_url: 'https://api.openai.com/v1' });
    const recent = await request(app).get('/usage/recent?limit=1');
    expect(recent.status).toBe(200);
    expect(recent.body.logs[0]).toMatchObject({ id: 'usage-1', model: 'gpt-6-astra', provider: 'openai' });
  });
});
