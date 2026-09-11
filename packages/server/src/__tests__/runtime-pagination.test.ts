import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createIntelligenceRoutes } from '../routes/intelligence';
import { createRuntimeGovernanceRoutes } from '../routes/runtime-governance';
import { createMetaOrchestrationRoutes } from '../routes/meta-orchestration';
import { errorHandler } from '../middleware/error-handler';

describe('runtime pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before incident, alert or tuning reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const runtimeService = { start() {}, getAlerts() { return []; } } as any;
    const metaService = { getTuningHistory() { return []; } } as any;
    const app = express()
      .use('/intelligence', createIntelligenceRoutes(db, auth))
      .use('/runtime-governance', createRuntimeGovernanceRoutes(db, auth, runtimeService))
      .use('/meta', createMetaOrchestrationRoutes(db, auth, metaService))
      .use(errorHandler);
    for (const path of ['/intelligence/incidents', '/runtime-governance/alerts', '/meta/tuning-history']) {
      const response = await request(app).get(`${path}?limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects empty predictive requests instead of returning a neutral false-success', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const app = express()
      .use(express.json())
      .use('/intelligence', createIntelligenceRoutes(db, auth))
      .use('/api/intelligence', createIntelligenceRoutes(db, auth))
      .use(errorHandler);

    const invalid = await request(app).post('/intelligence/predict').send({});
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const valid = await request(app).post('/intelligence/predict').send({ goalType: 'docs', runtime: 'mock', mode: 'closed', estimatedFindings: 0 });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ successProbability: 0.5, expectedCostDollars: 0.05 });
    expect((await request(app).get('/api/intelligence/patterns')).status).toBe(200);
    expect((await request(app).get('/api/intelligence/predictive/stats')).status).toBe(200);
    expect((await request(app).get('/api/intelligence/data-quality')).status).toBe(200);
    expect((await request(app).get('/api/intelligence/health')).status).toBe(200);
    expect((await request(app).post('/api/intelligence/heal')).status).toBe(200);
    expect((await request(app).get('/api/intelligence/incidents?limit=5')).status).toBe(200);
    expect((await request(app).get('/api/intelligence/healing/stats')).status).toBe(200);
  });
});
