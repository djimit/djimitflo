import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createCognitiveRoutes } from '../routes/cognitive';
import { createPolicyRoutes } from '../routes/policies';
import { createSwarmRoutes } from '../routes/swarms';
import { createRiskRoutes } from '../routes/risk';
import { createApexRoutes } from '../routes/apex';
import { createAgiRoutes } from '../routes/agi';
import { createRuntimeGovernanceRoutes } from '../routes/runtime-governance';
import { errorHandler } from '../middleware/error-handler';

const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;

describe('mutation routes fail closed on missing required input', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('returns validation errors instead of SQLite 500s', async () => {
    const db = createTestDb(); dbs.push(db);
    const app = express().use(express.json());
    app.use('/cognitive', createCognitiveRoutes(db, auth));
    app.use('/policies', createPolicyRoutes(db, auth));
    app.use('/swarms', createSwarmRoutes(db, auth));
    app.use('/risk', createRiskRoutes(db, auth));
    app.use('/apex', createApexRoutes(db, auth));
    app.use('/agi', createAgiRoutes(db, auth));
    app.use('/runtime-governance', createRuntimeGovernanceRoutes(db, auth));
    app.use(errorHandler);

    const cognitive = await request(app).post('/cognitive/episodes').send({});
    expect(cognitive.status).toBe(400);
    const policy = await request(app).post('/policies').send({});
    expect(policy.status).toBe(400);
    const mission = await request(app).post('/swarms/intelligence/missions').send({});
    expect(mission.status).toBe(400);
    const risk = await request(app).post('/risk/task').send({});
    expect(risk.status).toBe(400);
    const claim = await request(app).post('/swarms/intelligence/claims').send({});
    expect(claim.status).toBe(400);
    const llm = await request(app).post('/apex/llm/route').send({});
    expect(llm.status).toBe(400);
    const resolve = await request(app).post('/agi/consensus/debates/missing-debate/resolve').send({});
    expect(resolve.status).toBe(404);
    const governanceRegister = await request(app).post('/runtime-governance/agents/missing-agent/register').send({});
    expect(governanceRegister.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cognitive_episodes').get()).toEqual({ n: 0 });
  });
});
