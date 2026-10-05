import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';
import { listDraftPrs } from '../services/loop-draft-pr-service';

const NOW = Date.parse('2026-10-05T12:00:00Z');
function seed() {
  const db = createTestDb();
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('r1', 'test-gap', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/474' }), '2026-09-27T12:00:00Z', '2026-09-27T12:00:00Z');
  run.run('r2', 'mutation-gap', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/616', pr_outcome: { state: 'merged', survived: true, settled_at: 'x' } }), '2026-10-04T12:00:00Z', '2026-10-04T12:00:00Z');
  run.run('r3', 'test-gap', '{}', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z');
  return db;
}

it('UX-7: lists loop draft PRs newest first with number, lane, age and settlement; runs without a PR are left out', () => {
  const r = listDraftPrs(seed(), 50, NOW);
  expect(r).toMatchObject({ total: 2, unsettled: 1 });
  expect(r.rows).toEqual([
    { run_id: 'r2', lane: 'mutation-gap', pr_url: 'https://github.com/o/r/pull/616', pr_number: 616, age_days: 1, outcome: 'merged', survived: true },
    { run_id: 'r1', lane: 'test-gap', pr_url: 'https://github.com/o/r/pull/474', pr_number: 474, age_days: 8, outcome: null, survived: null },
  ]);
  expect(listDraftPrs(seed(), 1, NOW).rows).toHaveLength(1);
  expect(listDraftPrs(seed(), 999, NOW).rows).toHaveLength(2); // clamp ≤ 100
});

it('UX-7: GET /api/loops/draft-prs requires a login and clamps the limit', async () => {
  const db = seed();
  const authService = new AuthService(db);
  const token = authService.generateToken(authService.createUser('draft-prs@example.test', 'disposable-password', UserRole.VIEWER));
  const auth = createAuthMiddleware(authService);
  const app = express().use(express.json()).use('/api/loops', auth.requireAuth, createLoopRoutes(db, auth)).use(errorHandler);
  expect((await request(app).get('/api/loops/draft-prs')).status).toBe(401);
  const res = await request(app).get('/api/loops/draft-prs?limit=0').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ total: 2, unsettled: 1 });
  expect(res.body.rows.length).toBeGreaterThan(0);
});
