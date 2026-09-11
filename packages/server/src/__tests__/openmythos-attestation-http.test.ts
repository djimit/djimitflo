import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createOpenMythosRoutes } from '../routes/openmythos';
import { OpenMythosAttestationService } from '../services/openmythos-attestation-service';
import { GoalBatchService } from '../services/goal-batch-service';
import type Database from 'better-sqlite3';

let db: Database.Database;
let token: string;
let app: express.Express;
const corpusHash = 'a'.repeat(64);

function artifact() {
  const payload: Record<string, unknown> = {
    schema: 'djimit.openmythos.calibration.v1', run_id: 'run-http', openmythos_commit: 'a'.repeat(40),
    corpus_sha256: corpusHash, corpus_certification_ready: true, case_result_rows: 2,
    total_cases: 2, completed_cases: 2, calibrated: true, certification_eligible: true,
    agreement_rate: 0.9, lowest_category_agreement_rate: 0.8,
    evidence_sha256: { corpus: corpusHash, run: 'b'.repeat(64) },
  };
  return { ...payload, attestation_hash: `sha256:${OpenMythosAttestationService.hashArtifact(payload)}` };
}

beforeEach(() => {
  db = createTestDb();
  db.prepare(`INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, metadata)
    VALUES ('run-http', 'agent-http', 'completed', 2, 2, ?)`)
    .run(JSON.stringify({ corpus_sha256: corpusHash }));
  const authService = new AuthService(db);
  // Keep this fixture independent from other tests that mutate process.env.JWT_SECRET
  // while Vitest runs files concurrently.
  (authService as unknown as { jwtSecret: string }).jwtSecret = 'openmythos-attestation-http-fixture-secret';
  token = authService.generateToken(authService.createUser('attestation@example.test', 'attestation-password', UserRole.ADMIN));
  const auth = createAuthMiddleware(authService);
  app = express().use(express.json()).use('/api/openmythos', auth.requireAuth, createOpenMythosRoutes(db, auth));
});

afterEach(() => db.close());

describe('OpenMythos attestation HTTP contract', () => {
  it('imports and reads a verified attestation, while rejecting unauthenticated and tampered requests', async () => {
    expect((await request(app).post('/api/openmythos/attestations/import').send(artifact())).status).toBe(401);
    const imported = await request(app).post('/api/openmythos/attestations/import')
      .set('Authorization', `Bearer ${token}`).send(artifact());
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ run_id: 'run-http', certification_eligible: true });
    const listed = await request(app).get('/api/openmythos/attestations').set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.attestations).toHaveLength(1);
    const tampered = await request(app).post('/api/openmythos/attestations/import')
      .set('Authorization', `Bearer ${token}`).send({ ...artifact(), agreement_rate: 0.1 });
    expect(tampered.status).toBe(400);
  });

  it('records WorldLab retest evidence without changing goal status or promoting', async () => {
    const goal = new GoalBatchService(db).apply({ batch: {
      goals: [{ id: 'goal-http', title: 'Retest finding', risk: 'medium', acceptance: ['all gates pass'], target: 'worldlab' }],
    } }).created_goals[0];
    db.prepare('UPDATE goals SET metadata = ? WHERE id = ?').run(JSON.stringify({
      ...goal.metadata, openmythos_source: { finding_id: 'finding-http' },
    }), goal.id);
    const payload = {
      schema: 'djimit.openmythos.worldlab.retest.v1', finding_id: 'finding-http', goal_id: goal.id,
      change_id: 'change-http', commit: 'abcdef1234567', trajectory_id: 'trajectory-http',
      evidence_hash: `sha256:${'b'.repeat(64)}`,
      gates: { static_openmythos: 'PASS', worldlab_targeted: 'PASS', djimitflo_tests: 'PASS', security_invariants: 'PASS' },
      evidence_refs: ['openmythos:static-http', 'worldlab:trajectory-http', 'djimitflo:test-http', 'security:proof-http'],
    };
    const result = await request(app).post('/api/openmythos/worldlab/retests')
      .set('Authorization', `Bearer ${token}`).send(payload);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ decision: 'PROMOTION_CANDIDATE', promoted: false });
    expect((db.prepare('SELECT status FROM goals WHERE id = ?').get(goal.id) as { status: string }).status).toBe('created');
  });
});
