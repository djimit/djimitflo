import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import type { Stall } from '../services/stall-watch';
import { listDraftPrs } from '../services/loop-draft-pr-service';
import { operatorCockpit } from '../services/operator-cockpit';
import { evolutionLineage } from '../services/evolution-lineage';
import { createTestDb } from './helpers/test-db';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';

// Dashboard truth audit 2026-11-12 (/decisions and the cockpit): what the operator sees must match what waits for them.
const injected = vi.hoisted(() => ({ stalls: null as Stall[] | null }));
vi.mock('../services/stall-watch', async (importOriginal) => {
  const m = await importOriginal<typeof import('../services/stall-watch')>();
  return { ...m, detectStallsWithHealth: (...args: Parameters<typeof m.detectStallsWithHealth>) => {
    const r = m.detectStallsWithHealth(...args);
    return injected.stalls ? { ...r, stalls: injected.stalls } : r;
  } };
});

const NOW = Date.parse('2026-11-12T19:00:00Z');
const iso = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
let db: Database.Database;
beforeEach(() => { injected.stalls = null; db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

const prRun = (id: string, pr: number, createdDaysAgo: number, outcome?: Record<string, unknown>) => db.prepare(`INSERT INTO loop_runs
  (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
  VALUES (?, 'test-gap', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`)
  .run(id, JSON.stringify({ pr_url: `https://github.com/o/r/pull/${pr}`, ...(outcome ? { pr_outcome: outcome } : {}) }), iso(createdDaysAgo), iso(createdDaysAgo));

it('/decisions: every open loop PR is listed first, oldest first, even behind 50 newer merged ones; open rows need the operator', () => {
  // prod 11-12: #713 … #729 open 34 d, counted in the cockpit's "26 flagged", invisible in a newest-50 table
  [713, 714, 718, 728, 729].forEach((pr, i) => prRun(`open-${pr}`, pr, 34 - i * 0.1, i === 2 ? { state: 'open' } : undefined));
  for (let i = 0; i < 50; i++) prRun(`merged-${i}`, 800 + i, 1 + i * 0.1, { state: 'merged', merged_at: iso(1 + i * 0.1) });
  prRun('settled', 700, 40, { state: 'merged', merged_at: iso(40), settled_at: iso(20), survived: true });
  const r = listDraftPrs(db, 50, NOW);
  expect(r.rows).toHaveLength(50);
  expect(r.rows.slice(0, 5).map((x) => x.pr_number)).toEqual([713, 714, 718, 728, 729]);
  expect(r.rows.slice(0, 5).every((x) => x.needs_operator)).toBe(true);
  // then the merged rows still inside the survival window (newest first); they only wait
  expect(r.rows[5]).toMatchObject({ pr_number: 800, settlement: 'MERGED_SURVIVAL_PENDING', needs_operator: false });
  expect(r.rows.slice(5).every((x) => !x.needs_operator)).toBe(true);
  // a small limit never hides an open PR
  expect(listDraftPrs(db, 2, NOW).rows.map((x) => x.pr_number)).toEqual([713, 714, 718, 728, 729]);
});

it('cockpit: a future-dated admission expiry is a warning ("expires in 15 d"), not a stall, and does not degrade health', () => {
  const base = operatorCockpit(db, NOW);
  injected.stalls = [{ subsystem: 'runtime_admission:djimitsec', since: '2026-11-27T00:00:00Z', detail: 'admission CONDITIONAL expires 2026-11-27T00:00:00Z; reassess before then' }];
  const c = operatorCockpit(db, NOW);
  expect(c.stalls).toEqual([]);
  expect(c.warnings).toEqual([expect.objectContaining({ subsystem: 'runtime_admission:djimitsec', due_in_days: 15 })]);
  expect(c.health).toBe(base.health);
  expect(c.needs_you.stalls).toBe(0);
});

it('cockpit: a stall that tells the operator to act counts in needs_you.total, not under "system handles"', () => {
  db.exec('CREATE TABLE IF NOT EXISTS social_join_requests (id TEXT, status TEXT)'); // created by the social service at runtime
  injected.stalls = [];
  const before = operatorCockpit(db, NOW).needs_you;
  expect(before.total).toEqual(expect.any(Number));
  injected.stalls = [
    { subsystem: 'experiment:ACE-001', since: null, detail: 'every arm reached target 50 without a verdict; record a verdict or stop it' },
    { subsystem: 'gym', since: iso(1), detail: 'no gym outcome for 6 h' },
  ];
  const c = operatorCockpit(db, NOW);
  expect(c.stalls).toHaveLength(2);
  expect(c.needs_you).toMatchObject({ operator_stalls: 1, stalls: 1 });
  expect(c.needs_you.total).toBe(before.total! + 1);
});

it('GET /api/health/needs-you returns the cockpit needs_you (one number for badge, tab title and /decisions)', async () => {
  const tdb = createTestDb();
  const authService = new AuthService(tdb);
  const admin = authService.generateToken(authService.createUser('needs-you-admin@example.test', 'disposable-password', UserRole.ADMIN));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(tdb, createAuthMiddleware(authService)));
  expect((await request(app).get('/api/health/needs-you')).status).toBe(401);
  const res = await request(app).get('/api/health/needs-you').set('Authorization', `Bearer ${admin}`);
  expect(res.status).toBe(200);
  expect(res.body.needs_you.total).toBe(operatorCockpit(tdb).needs_you.total);
  expect(Object.keys(res.body).sort()).toEqual(['at', 'errors', 'needs_you', 'warnings']);
});

it('funnel: queue age and the oldest queue ignore archived (terminal) proposals; no open proposal = no queue', () => {
  const proposal = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, '[]', ?, ?)`);
  for (let i = 0; i < 12; i++) proposal.run(`a${i}`, `archived ${i}`, 'archived', iso(53), iso(50));
  let e = evolutionLineage(db, NOW, {});
  expect(e.stages.find((s) => s.stage === 'proposal')?.median_age_days).toBeNull();
  expect(e.bottleneck).toMatchObject({ from: 'proposal', to: 'experiment', lost: 12, oldest_queue: null });
  proposal.run('p1', 'open one', 'proposed', iso(3), iso(3));
  e = evolutionLineage(db, NOW, {});
  expect(e.stages.find((s) => s.stage === 'proposal')?.median_age_days).toBe(3);
});
