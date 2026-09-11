import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createComplianceRoutes } from '../routes/compliance';
import { createUsageRoutes } from '../routes/usage';
import { errorHandler } from '../middleware/error-handler';

describe('compliance and usage pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before audit or usage reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express()
      .use(express.json())
      .use('/compliance', createComplianceRoutes(db, auth))
      .use('/usage', createUsageRoutes(db, auth))
      .use(errorHandler);
    for (const path of ['/compliance/audit/log', '/usage/recent']) {
      const response = await request(app).get(`${path}?limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }

    const invalidAudit = await request(app).post('/compliance/audit/append').send({ action: 42, outcome: 'accepted' });
    expect(invalidAudit.status).toBe(400);
    expect(invalidAudit.body.error.code).toBe('VALIDATION_ERROR');
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type LIKE 'compliance.%'").get()).toMatchObject({ count: 0 });

    const invalidReport = await request(app).post('/compliance/reports/generate').send({ type: 'custom' });
    expect(invalidReport.status).toBe(400);
    expect(invalidReport.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed usage batches before SQLite and persists valid entries', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.exec(`CREATE TABLE token_usage_log (
      id TEXT PRIMARY KEY, task_id TEXT, discussion_id TEXT, agent_id TEXT, model TEXT,
      task_type TEXT, total_tokens INTEGER NOT NULL DEFAULT 0, cost_estimate REAL,
      metadata TEXT, created_at TEXT, updated_at TEXT, provider TEXT NOT NULL,
      model_name TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER, timestamp TEXT NOT NULL
    )`);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express()
      .use(express.json())
      .use('/usage', createUsageRoutes(db, auth))
      .use(errorHandler);

    const invalid = await request(app).post('/usage/tokens').send({ logs: [{ id: 'bad', prompt_tokens: -1 }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_INPUT');
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_usage_log').get()).toMatchObject({ count: 0 });

    const invalidProvider = await request(app).post('/usage/tokens').send({ logs: [{ id: 'bad-provider', provider: '   ' }] });
    expect(invalidProvider.status).toBe(400);
    expect(invalidProvider.body.error.code).toBe('INVALID_INPUT');
    expect(db.prepare('SELECT COUNT(*) AS count FROM token_usage_log').get()).toMatchObject({ count: 0 });

    const valid = await request(app).post('/usage/tokens').send({ logs: [{ id: 'usage-valid', task_id: 'task-1', agent_id: 'agent-1', provider: 'openai', model: 'gpt-6-astra', task_type: 'task', prompt_tokens: 4, completion_tokens: 6, latency_ms: 12 }] });
    expect(valid.status).toBe(201);
    expect(valid.body).toMatchObject({ inserted: 1, count: 1 });
    expect(db.prepare('SELECT task_id, agent_id, provider, task_type, total_tokens, model, prompt_tokens, completion_tokens FROM token_usage_log WHERE id = ?').get('usage-valid')).toMatchObject({ task_id: 'task-1', agent_id: 'agent-1', provider: 'openai', task_type: 'task', total_tokens: 10, model: 'gpt-6-astra', prompt_tokens: 4, completion_tokens: 6 });

    const legacy = await request(app).post('/usage/tokens').send({ logs: [{ id: 'usage-legacy', task_type: 'discussion', prompt_tokens: 2, completion_tokens: 3 }] });
    expect(legacy.status).toBe(201);
    expect(db.prepare('SELECT provider, task_type, total_tokens FROM token_usage_log WHERE id = ?').get('usage-legacy')).toMatchObject({ provider: 'unknown', task_type: 'discussion', total_tokens: 5 });
  });
});
