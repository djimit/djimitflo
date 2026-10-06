import { expect, it } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { runtimeHealth } from '../services/runtime-health';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function seed() {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('r1', 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(ago(5), ago(5));
  const lease = db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'r1', 'maker', ?, ?, '{}', ?, ?)`);
  lease.run('l1', 'opencode', 'completed', ago(2), ago(2)); lease.run('l2', 'opencode', 'completed', ago(3), ago(3));
  lease.run('l3', 'opencode', 'failed', ago(4), ago(4)); lease.run('l4', 'opencode', 'cancelled', ago(4), ago(4));
  lease.run('l5', 'opencode', 'completed', ago(40), ago(40)); // outside 30 d, inside 90 d
  lease.run('l6', 'mystery-cli', 'failed', ago(1), ago(1)); // a runtime the ledger does not know
  db.prepare(`INSERT INTO runtime_contract_probes (runtime, command, status, available, contract_json, probed_at, updated_at) VALUES ('opencode', 'opencode', 'ok', 1, '{"version":"1.18.10"}', ?, ?)`).run(ago(1), ago(1));
  return db;
}

it('UX-16: an unknown runtime and a runtime without a probe render "no probe", never "ok"', () => {
  const rows = runtimeHealth(seed(), NOW);
  const mystery = rows.find((r) => r.runtime === 'mystery-cli')!;
  expect(mystery).toMatchObject({ probe: { status: 'no probe', probed_at: null }, readiness: 'unknown_runtime', admission: { decision: 'UNKNOWN_RUNTIME', allowed_now: false } });
  const gemini = rows.find((r) => r.runtime === 'gemini')!;
  expect(gemini.probe.status).toBe('no probe');
  expect(rows.find((r) => r.runtime === 'opencode')!.probe).toMatchObject({ status: 'ok', age_h: 24 });
});

it('UX-16: the legacy expiry is a countdown in days and unused legacy runtimes are retire candidates', () => {
  const rows = runtimeHealth(seed(), NOW);
  const opencode = rows.find((r) => r.runtime === 'opencode')!;
  expect(opencode.admission).toMatchObject({ decision: 'LEGACY_ADMITTED', expires_at: '2026-12-31T00:00:00Z', days_to_expiry: 85 });
  expect(opencode.readiness).toBe('reassess');
  expect(opencode.version).toMatchObject({ admitted: '1.18.10', observed: '1.18.10', drift: false });
  expect(rows.find((r) => r.runtime === 'gemini')!.readiness).toBe('retire_unused');
  expect(rows.find((r) => r.runtime === 'mock')!.readiness).toBe('keep_test_only');
});

it('UX-16: 30-day lease stats equal hand SQL (completed / failed / cancelled, success over decided runs)', () => {
  const db = seed();
  const hand = db.prepare(`SELECT COUNT(*) n, SUM(status='completed') c, SUM(status='failed') f FROM worker_leases WHERE runtime='opencode' AND created_at >= ?`).get(ago(30)) as { n: number; c: number; f: number };
  const row = runtimeHealth(db, NOW).find((r) => r.runtime === 'opencode')!;
  expect(row.leases_30d).toEqual({ n: hand.n, completed: hand.c, failed: hand.f, cancelled: 1, success_rate: +(hand.c / (hand.c + hand.f)).toFixed(3) });
  expect(row.leases_90d).toBe(5);
  expect(row.last_success_at).toBe(ago(2));
});

it('UX-16: GET /api/health/runtimes requires a login and returns one row per runtime', async () => {
  const db = createTestDb();
  const authService = new AuthService(db);
  const auth = createAuthMiddleware(authService);
  const viewer = authService.generateToken(authService.createUser('rt-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(db, auth));
  expect((await request(app).get('/api/health/runtimes')).status).toBe(401);
  const res = await request(app).get('/api/health/runtimes').set('Authorization', `Bearer ${viewer}`);
  expect(res.status).toBe(200); // viewers hold read:evidence
  expect(res.body.runtimes.length).toBeGreaterThan(5);
  expect(res.body.runtimes.every((r: { probe: { status: string } }) => typeof r.probe.status === 'string')).toBe(true);
});
