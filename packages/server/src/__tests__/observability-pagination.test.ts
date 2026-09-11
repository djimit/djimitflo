import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createObservabilityRoutes } from '../routes/observability';
import { errorHandler } from '../middleware/error-handler';

describe('observability time-window validation', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed days and hours before database reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = {
      requireAuth: (_req: any, _res: any, next: any) => next(),
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any;
    const app = express().use('/observability', createObservabilityRoutes(db, auth)).use(errorHandler);
    for (const path of ['/observability/risk-trends?days=NaN', '/observability/execution-activity?hours=0']) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });

  it('projects empty observability state from the canonical SQLite tables', async () => {
    const db = createTestDb();
    dbs.push(db);
    db.exec(`
      CREATE TABLE execution_events (task_id TEXT, message TEXT, level TEXT, created_at TEXT);
      CREATE TABLE approval_policies (id TEXT, name TEXT, decision TEXT, enabled INTEGER, priority INTEGER);
    `);
    const auth = {
      requireAuth: (_req: any, _res: any, next: any) => next(),
      requirePermission: () => (_req: any, _res: any, next: any) => next(),
    } as any;
    const app = express().use('/observability', createObservabilityRoutes(db, auth)).use(errorHandler);
    const metrics = await request(app).get('/observability/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.body).toMatchObject({ total_tasks: 0, active_tasks: 0, completed_tasks: 0, failed_tasks: 0, pending_approvals: 0 });
    expect((await request(app).get('/observability/risk-trends?days=30')).body.trends).toEqual([]);
    expect((await request(app).get('/observability/policy-stats')).body).toMatchObject({ policies: [], decisions: [], recent_denials: [] });
    expect((await request(app).get('/observability/execution-activity?hours=24')).body).toMatchObject({ activity: [], recent_tasks: [] });
  });
});
