import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { QueueHygieneService } from '../services/queue-hygiene-service';

let db: Database.Database;
const NOW = new Date('2026-09-22T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const goal = (id: string, status: string, hoursAgo: number, metadata: object = {}, improvementId: string | null = null) =>
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', ?, ?, ?, ?, ?)")
    .run(id, status, JSON.stringify(metadata), improvementId, ago(hoursAgo), ago(hoursAgo));
const run = (id: string, goalId: string, status: string, hoursAgo: number) =>
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES (?, ?, 'x', 'closed', ?, ?, ?)").run(id, goalId, status, ago(hoursAgo), ago(hoursAgo));
const status = (table: string, id: string) => (db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

it('reaps stale running goals but not ones with a live run or a recent update', () => {
  goal('g-stale', 'running', 48); goal('g-live', 'running', 48); run('r-live', 'g-live', 'running', 1); goal('g-recent', 'running', 2);
  const r = new QueueHygieneService(db).sweepZombies(NOW);
  expect(r.goalsReaped).toBe(1);
  expect(status('goals', 'g-stale')).toBe('failed'); expect(status('goals', 'g-live')).toBe('running'); expect(status('goals', 'g-recent')).toBe('running');
  expect(JSON.parse((db.prepare("SELECT metadata FROM goals WHERE id = 'g-stale'").get() as { metadata: string }).metadata).reaped).toBe('stale_running');
});
it('cancels old blocked goals without a wait reason, and never touches goals awaiting approval', () => {
  goal('g-blocked', 'blocked', 24 * 8); goal('g-waiting', 'blocked', 24 * 8, { awaiting_approval: { approval_id: 'a' } }); goal('g-fresh', 'blocked', 24);
  new QueueHygieneService(db).sweepZombies(NOW);
  expect(status('goals', 'g-blocked')).toBe('cancelled'); expect(status('goals', 'g-waiting')).toBe('blocked'); expect(status('goals', 'g-fresh')).toBe('blocked');
});
it('closes stale interrupted/planning runs and parks the proposal of a reaped goal; idempotent', () => {
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, status, source, priority, created_at, updated_at) VALUES ('p1', 'bug_fix', 't', 'd', 'r', 'executing', 'reflection', 1, ?, ?)").run(ago(100), ago(100));
  goal('g1', 'running', 48, {}, 'p1'); run('r-int', 'g1', 'interrupted', 72); run('r-plan', 'g1', 'planning', 30); run('r-int-new', 'g1', 'interrupted', 5);
  const svc = new QueueHygieneService(db);
  expect(svc.sweepZombies(NOW)).toEqual({ goalsReaped: 1, runsReaped: 2 });
  expect(status('loop_runs', 'r-int')).toBe('cancelled'); expect(status('loop_runs', 'r-plan')).toBe('failed'); expect(status('loop_runs', 'r-int-new')).toBe('interrupted');
  expect(status('self_improvements', 'p1')).toBe('needs_more_evidence');
  expect(svc.sweepZombies(NOW)).toEqual({ goalsReaped: 0, runsReaped: 0 });
});
