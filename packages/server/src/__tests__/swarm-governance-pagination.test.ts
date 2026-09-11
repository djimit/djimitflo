import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createGovernanceRoutes } from '../routes/swarm-governance';
import { errorHandler } from '../middleware/error-handler';

describe('swarm governance pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before assurance or memory reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/swarms', createGovernanceRoutes(db, passthroughAuth)).use(errorHandler);
    for (const path of ['/swarms/assurance/capability-tokens', '/swarms/assurance/reflections', '/swarms/memory/candidates']) {
      const response = await request(app).get(`${path}?limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });

  it('projects proof and assurance state through the read routes', async () => {
    const db = createTestDb();
    dbs.push(db);
    const passthroughAuth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express().use(express.json()).use('/swarms', createGovernanceRoutes(db, passthroughAuth)).use(errorHandler);

    const proofResponse = await request(app).post('/swarms/proof-runs').send({ runtime: 'mock' });
    expect(proofResponse.status).toBe(201);
    const latestResponse = await request(app).get('/swarms/proof-runs/latest');
    expect(latestResponse.status).toBe(200);
    expect(latestResponse.body).toMatchObject({ id: proofResponse.body.id, status: 'completed', passed: true });

    const traceResponse = await request(app).post('/swarms/assurance/trace-spans').send({
      trace_id: 'governance-read-trace', span_type: 'goal', name: 'route-read', status: 'ok',
    });
    expect(traceResponse.status).toBe(201);
    const tokenResponse = await request(app).post('/swarms/assurance/capability-tokens').send({
      subject_agent_id: 'route-reader', scopes: ['loop:read'], risk_class: 'low',
    });
    expect(tokenResponse.status).toBe(201);
    const reflectionResponse = await request(app).post('/swarms/assurance/reflections').send({
      source_type: 'trace', source_ref: 'governance-read-trace', lesson: 'Read projections preserve persisted governance evidence.',
    });
    expect(reflectionResponse.status).toBe(201);

    const tokenList = await request(app).get('/swarms/assurance/capability-tokens?limit=1');
    expect(tokenList.status).toBe(200);
    expect(tokenList.body).toHaveLength(1);
    expect(tokenList.body[0].id).toBe(tokenResponse.body.id);

    const reflectionList = await request(app).get('/swarms/assurance/reflections?limit=1');
    expect(reflectionList.status).toBe(200);
    expect(reflectionList.body).toHaveLength(1);
    expect(reflectionList.body[0].id).toBe(reflectionResponse.body.id);

    const summary = await request(app).get('/swarms/assurance/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.trace_count).toBeGreaterThanOrEqual(2);
    expect(summary.body.trace_span_count).toBeGreaterThanOrEqual(6);
    expect(summary.body.active_capability_count).toBe(1);
  });
});
