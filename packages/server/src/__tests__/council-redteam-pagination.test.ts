import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createCouncilRoutes } from '../routes/council';
import { createRedTeamRoutes } from '../routes/red-team';
import { errorHandler } from '../middleware/error-handler';

describe('council and red-team pagination', () => {
  const dbs: ReturnType<typeof createTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it('rejects malformed limits before session or adversarial-history reads', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const governance = { isAllowed: () => true, registerBaseline() {}, getQuarantineStatus: () => ({}) } as any;
    const app = express()
      .use('/council', createCouncilRoutes(db, auth))
      .use('/red-team', createRedTeamRoutes(db, auth, governance))
      .use(errorHandler);
    for (const path of ['/council/sessions', '/red-team/history']) {
      const response = await request(app).get(`${path}?limit=NaN`);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code, path).toBe('VALIDATION_ERROR');
    }
  });

  it('runs an assessment and projects the persisted latest report and history', async () => {
    const db = createTestDb();
    dbs.push(db);
    const auth = { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any;
    const governance = { isAllowed: () => true, registerBaseline() {}, getQuarantineStatus: () => ({}) } as any;
    const app = express().use(express.json()).use('/red-team', createRedTeamRoutes(db, auth, governance)).use(errorHandler);
    const assessment = await request(app).post('/red-team/assess');
    expect(assessment.status).toBe(200);
    expect(assessment.body).toMatchObject({ totalAttacks: 12, blocked: 12, missed: 0, overallScore: 1 });
    const latest = await request(app).get('/red-team/latest');
    expect(latest.status).toBe(200);
    expect(latest.body.id).toBe(assessment.body.id);
    const history = await request(app).get('/red-team/history?limit=1');
    expect(history.status).toBe(200);
    expect(history.body.history).toHaveLength(1);
  });
});
