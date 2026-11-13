import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from './helpers/test-db';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';

/**
 * Truth audit 2026-11-12: Goals & Loops listed the synthetic PR-review runs (bookkeeping, 51 % of loop runs) with production
 * runs. GET /loops/runs?synthetic=exclude returns real loop work only — the same predicate the operator cockpit uses
 * (marked metadata.synthetic, or a historical repo-maintenance-loop run with a 'manual' maker lease). The default is unchanged.
 */
it('GET /loops/runs?synthetic=exclude lists production runs only; the default still lists every run', async () => {
  const db = createTestDb();
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('real', 'test-gap', '{}', '2026-11-12T10:00:00.000Z', '2026-11-12T10:00:00.000Z');
  run.run('marked', 'repo-maintenance-loop', JSON.stringify({ synthetic: true, synthetic_reason: 'pr_review' }), '2026-11-12T11:00:00.000Z', '2026-11-12T11:00:00.000Z');
  run.run('historical', 'repo-maintenance-loop', '{}', '2026-11-12T12:00:00.000Z', '2026-11-12T12:00:00.000Z');
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES ('l1', 'historical', 'maker', 'manual', 'completed', '{}', '2026-11-12T12:00:00.000Z', '2026-11-12T12:00:00.000Z')`).run();
  const app = express().use('/api/loops', createLoopRoutes(db)).use(errorHandler);

  const ids = async (path: string) => ((await request(app).get(path)).body.runs as Array<{ id: string }>).map((r) => r.id);
  expect(await ids('/api/loops/runs')).toEqual(['historical', 'marked', 'real']);
  expect(await ids('/api/loops/runs?synthetic=include')).toEqual(['historical', 'marked', 'real']);
  expect(await ids('/api/loops/runs?synthetic=exclude')).toEqual(['real']);
  expect((await request(app).get('/api/loops/runs?synthetic=maybe')).status).toBe(400);
});
