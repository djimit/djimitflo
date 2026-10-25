import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const PATH = '/runs/:id/gym-outcome';

function seed() {
  const db = createTestDb();
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, '2026-10-25T10:00:00Z', '2026-10-25T10:05:00Z')`);
  run.run('gym-scored', JSON.stringify({ gym: { commit: 'abc123', species: 'atomic@llama-router', remote_host: 'ws1' }, gym_result: { status: 'failure', reason: 'tests still red', tokens: null } }));
  run.run('gym-discarded', JSON.stringify({ gym: { commit: 'def456', species: 'atomic@llama-router', remote_host: 'ws1' }, gym_result: { status: 'discarded', reason: 'infra: orphaned_no_result' } }));
  new SkillEvolutionEngine(db).recordOutcome('loop-maker:gym:atomic', {
    success: false, tokensUsed: null, durationMs: 61_000, domain: 'gym', taskId: 'gym-scored', model: 'llama-router',
    evidenceRefs: ['gym:abc123', 'loop_run:gym-scored', 'gym_result:tests still red'],
  });
  const authService = new AuthService(db);
  const viewer = authService.generateToken(authService.createUser('gym-outcome@example.test', 'disposable-password', UserRole.VIEWER));
  return { db, authService, viewer };
}

it('gym panel: GET /api/loops/runs/:id/gym-outcome returns the stored skill outcome to a reader, unknown tokens as null', async () => {
  const { db, authService, viewer } = seed();
  const app = express().use(express.json()).use('/api/loops', createAuthMiddleware(authService).requireAuth, createLoopRoutes(db, createAuthMiddleware(authService))).use(errorHandler);
  expect((await request(app).get('/api/loops/runs/gym-scored/gym-outcome')).status).toBe(401);

  const scored = await request(app).get('/api/loops/runs/gym-scored/gym-outcome').set('Authorization', `Bearer ${viewer}`);
  expect(scored.status).toBe(200);
  expect(scored.body).toMatchObject({ run_id: 'gym-scored', skill_outcome: { skill_id: 'loop-maker:gym:atomic', success: false, tokens_used: null, duration_ms: 61_000, model: 'llama-router' } });
  expect(scored.body.skill_outcome.evidence_refs).toContain('loop_run:gym-scored');

  // an infra discard writes no skill outcome: null, not a zeroed row
  const discarded = await request(app).get('/api/loops/runs/gym-discarded/gym-outcome').set('Authorization', `Bearer ${viewer}`);
  expect(discarded.status).toBe(200);
  expect(discarded.body).toEqual({ run_id: 'gym-discarded', skill_outcome: null });

  const missing = await request(app).get('/api/loops/runs/no-such-run/gym-outcome').set('Authorization', `Bearer ${viewer}`);
  expect(missing.status).toBe(404);
});

it('gym panel: the gym-outcome route is GET-only behind read:evidence and writes nothing', async () => {
  const { db, authService, viewer } = seed();
  const auth = createAuthMiddleware(authService);
  // tag every permission guard with the permission it checks, so the route's guard can be read off the router
  const tagged = { ...auth, requirePermission: (permission: string) => Object.assign(auth.requirePermission(permission), { permission }) };
  const router = createLoopRoutes(db, tagged);
  const layers = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { permission?: string } }> } }>)
    .filter((layer) => layer.route?.path === PATH);
  expect(layers).toHaveLength(1);
  expect(layers[0].route!.methods).toEqual({ get: true });
  expect(layers[0].route!.stack[0].handle.permission).toBe('read:evidence');

  // a principal whose role lacks read:evidence is refused
  const noRole = express().use((req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 'x', role: 'no-such-role' }; next(); })
    .use('/api/loops', createLoopRoutes(db, auth)).use(errorHandler);
  expect((await request(noRole).get('/api/loops/runs/gym-scored/gym-outcome')).status).toBe(403);

  const app = express().use(express.json()).use('/api/loops', auth.requireAuth, createLoopRoutes(db, auth)).use(errorHandler);
  const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM loop_runs ORDER BY id').all(), db.prepare('SELECT * FROM skill_outcomes ORDER BY id').all()]);
  const before = snapshot();
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    const res = await request(app)[method]('/api/loops/runs/gym-scored/gym-outcome').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(404);
  }
  await request(app).get('/api/loops/runs/gym-scored/gym-outcome').set('Authorization', `Bearer ${viewer}`);
  expect(snapshot()).toBe(before);
});
