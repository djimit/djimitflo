import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createOpenMythosRoutes } from '../routes/openmythos';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';

it('projects persisted operational status over HTTP without inventing evaluation or certification evidence', async () => {
  const db = createTestDb();
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Provider forbidden in read-only status proof'); });
  try {
    const service = new AuthService(db);
    const user = service.createUser('status-fixture@example.test', 'disposable-status-password', UserRole.ADMIN);
    const token = service.generateToken(user);
    const auth = createAuthMiddleware(service);
    const app = express().use('/api/openmythos', auth.requireAuth, createOpenMythosRoutes(db, auth));
    expect((await request(app).get('/api/openmythos/status')).status).toBe(401);
    expect((await request(app).get('/api/openmythos/status/fixture-a')).status).toBe(401);
    const emptyGlobal = await request(app).get('/api/openmythos/status').set('Authorization', `Bearer ${token}`);
    expect(emptyGlobal.status).toBe(200);
    expect(emptyGlobal.body).toEqual({ state: 'no_evidence', admissible: false, agentId: null });
    const emptyAgent = await request(app).get('/api/openmythos/status/fixture-a').set('Authorization', `Bearer ${token}`);
    expect(emptyAgent.body).toEqual({ state: 'no_evidence', admissible: false, agentId: 'fixture-a' });

    const insert = db.prepare(`INSERT INTO openmythos_eval_runs
      (id, agent_id, status, total_cases, completed_cases, overall_score, started_at, finished_at, metadata)
      VALUES (?, ?, ?, 4, ?, ?, ?, ?, ?)`);
    insert.run('run-a-complete', 'fixture-a', 'completed', 4, 4.5, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', JSON.stringify({ score_valid: true, corpus_certification_ready: false, certification_eligible: false, corpus_sha256: 'fixture-hash' }));
    insert.run('run-b-latest', 'fixture-b', 'completed', 4, 4.2, '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z', JSON.stringify({ score_valid: true, corpus_certification_ready: true, certification_eligible: false }));
    const global = await request(app).get('/api/openmythos/status').set('Authorization', `Bearer ${token}`);
    expect(global.body).toMatchObject({ runId: 'run-b-latest', agentId: 'fixture-b', state: 'completed', admissible: false, reason: 'evidence_not_certification_eligible' });
    const agent = await request(app).get('/api/openmythos/status/fixture-a').set('Authorization', `Bearer ${token}`);
    expect(agent.body).toMatchObject({ runId: 'run-a-complete', agentId: 'fixture-a', overallScore: 4.5, corpusSha256: 'fixture-hash', admissible: false, reason: 'corpus_not_certification_ready' });

    insert.run('run-a-failed', 'fixture-a', 'failed', 2, 5, '2026-01-03T00:00:00Z', '2026-01-03T00:01:00Z', JSON.stringify({ score_valid: true, corpus_certification_ready: true, certification_eligible: true }));
    const failed = await request(app).get('/api/openmythos/status/fixture-a').set('Authorization', `Bearer ${token}`);
    expect(failed.body).toMatchObject({ state: 'failed', runId: 'run-a-failed', overallScore: null, admissible: false, lastFailure: { id: 'run-a-failed' } });
    insert.run('run-a-incomplete', 'fixture-a', 'completed', 3, 5, '2026-01-04T00:00:00Z', '2026-01-04T00:01:00Z', JSON.stringify({ score_valid: true, corpus_certification_ready: true, certification_eligible: true }));
    const incomplete = await request(app).get('/api/openmythos/status/fixture-a').set('Authorization', `Bearer ${token}`);
    expect(incomplete.body).toMatchObject({ state: 'completed', completedCases: 3, totalCases: 4, admissible: false, lastFailure: { id: 'run-a-failed' } });
    const missing = await request(app).get('/api/openmythos/status/absent').set('Authorization', `Bearer ${token}`);
    expect(missing.body).toEqual({ state: 'no_evidence', admissible: false, agentId: 'absent' });
    expect(db.prepare('SELECT count(*) count FROM openmythos_eval_runs').get()).toEqual({ count: 4 });
    expect(db.prepare('SELECT count(*) count FROM openmythos_case_results').get()).toEqual({ count: 0 });
    expect(provider).not.toHaveBeenCalled();
  } finally { provider.mockRestore(); db.close(); }
});
