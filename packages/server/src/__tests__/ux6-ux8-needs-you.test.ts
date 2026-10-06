import { afterEach, beforeEach, expect, it } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { operatorCockpit } from '../services/operator-cockpit';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { listSchedulers, markRun, noteScheduler, resetSchedulers } from '../services/scheduler-registry';
import { AgentCommonsOpenDoorService } from '../services/agent-commons-open-door-service';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const iso = (mins: number) => new Date(NOW + mins * 60_000).toISOString();
let db: Database.Database;
beforeEach(() => { resetSchedulers(); db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); new SkillEvolutionEngine(db); });
afterEach(() => db.close());

it('UX-8: the registry passes armed state through unchanged, reports armed and off, and never throws', () => {
  expect(noteScheduler('dream_evolution', 'DREAM_EVOLUTION_ENABLED', true, 3_600_000)).toBe(true);
  expect(noteScheduler('evolution_gym', 'EVOLUTION_GYM_ENABLED', false)).toBe(false);
  markRun('dream_evolution'); markRun('dream_evolution', new Error('boom')); markRun('unknown');
  const r = listSchedulers();
  expect(r).toMatchObject({ armed: 1, off: 1 });
  expect(r.schedulers.find((s) => s.name === 'evolution_gym')).toMatchObject({ armed: false, flag: 'EVOLUTION_GYM_ENABLED', last_run: null });
  expect(r.schedulers.find((s) => s.name === 'dream_evolution')).toMatchObject({ armed: true, interval_ms: 3_600_000, last_error: 'boom' });
});

it('UX-6: needs_you counts every blocking category from seeded rows (foreign keys on); the original four stay', () => {
  const ins = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', ?, ?, ?)`);
  ins.run('p1', 'proposed', iso(-60), iso(-60)); ins.run('p2', 'proposed', iso(-60), iso(-60)); ins.run('v1', 'verified', iso(-60), iso(-60));
  const run = db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`);
  run.run('r1', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/1' }), iso(-120), iso(-120));
  run.run('r2', JSON.stringify({ pr_url: 'https://github.com/o/r/pull/2', pr_outcome: { state: 'merged', settled_at: iso(-1) } }), iso(-120), iso(-120));
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_at, updated_at) VALUES ('t1', 't', 'd', 'pending', 'low', 'low', 'local', ?, ?)").run(iso(-10), iso(-10));
  const appr = db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, expires_at) VALUES (?, 't1', 'pending', 'low', 'tool_call', 'm', '{}', ?)`);
  appr.run('a1', iso(30)); appr.run('a2', iso(300)); appr.run('a3', null);
  new AgentCommonsOpenDoorService(db); // creates social_join_requests
  db.prepare("INSERT INTO social_join_requests (agent_id, name, invite_label, secret_hash, status, requested_at) VALUES ('j1', 'n', 'l', 'h', 'pending', ?)").run(iso(-5));
  db.prepare("INSERT INTO fleet_commands (id, host, kind, command, command_sha256, status, requested_by, created_at) VALUES ('f1', 'h', 'shell', 'id -u', 'x', 'pending_approval', 'op', ?)").run(iso(-5));
  noteScheduler('stall_watch', 'STALL_WATCH_ENABLED', true); noteScheduler('evolution_gym', 'EVOLUTION_GYM_ENABLED', false);

  const c = operatorCockpit(db, NOW);
  expect(c.needs_you).toMatchObject({ approvals: 3, proposals: 2, draft_prs: 1, approvals_expiring: 1, join_requests: 1, shell_requests: 1 });
  expect(Object.keys(c.needs_you)).toEqual(expect.arrayContaining(['approvals', 'requeue', 'labels', 'memory_review']));
  expect(c.needs_you.stalls).toBe(c.stalls.length);
  expect(c.schedulers).toEqual({ armed: 1, off: 1 });
});

it('UX-8: GET /api/health/schedulers needs manage:config', async () => {
  const tdb = createTestDb();
  const authService = new AuthService(tdb);
  const viewer = authService.generateToken(authService.createUser('sched-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const admin = authService.generateToken(authService.createUser('sched-admin@example.test', 'disposable-password', UserRole.ADMIN));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(tdb, createAuthMiddleware(authService)));
  noteScheduler('merge_survival', 'MERGE_SURVIVAL_ENABLED', true);
  expect((await request(app).get('/api/health/schedulers')).status).toBe(401);
  expect((await request(app).get('/api/health/schedulers').set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
  const ok = await request(app).get('/api/health/schedulers').set('Authorization', `Bearer ${admin}`);
  expect(ok.status).toBe(200);
  expect(ok.body.schedulers[0]).toMatchObject({ name: 'merge_survival', armed: true });
});
