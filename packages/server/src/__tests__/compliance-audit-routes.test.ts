import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createComplianceRoutes } from '../routes/compliance';
import { errorHandler } from '../middleware/error-handler';
import { createTestDb } from './helpers/test-db';

describe('compliance audit chain HTTP contract', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('appends immutable entries, verifies the chain and generates a report', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use(createComplianceRoutes(db, auth)).use(errorHandler);

    const initial = await request(app).get('/status');
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ totalAuditEntries: 0, chainIntegrity: true });
    expect((await request(app).post('/audit/append').send({ action: '' })).status).toBe(400);

    for (const [action, outcome] of [['task.created', 'success'], ['task.denied', 'denied']] as const) {
      const response = await request(app).post('/audit/append').send({ action, resource: 'task-fixture', outcome, evidence: { source: 'route-test' } });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ action, resource: 'task-fixture', outcome, previousHash: expect.any(String), hash: expect.any(String) });
    }

    const log = await request(app).get('/audit/log?limit=2');
    expect(log.status).toBe(200);
    expect(log.body.entries).toHaveLength(2);
    const verify = await request(app).get('/audit/verify');
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ valid: true, entriesChecked: 2 });

    const report = await request(app).post('/reports/generate').send({ type: 'nora' });
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ type: 'nora', findings: expect.any(Array), score: expect.any(Number) });
    const status = await request(app).get('/status');
    expect(status.body).toMatchObject({ totalAuditEntries: 2, chainIntegrity: true, lastReportStatus: expect.any(String) });
  });
});
