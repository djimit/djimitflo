import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { requeueImprovement } from '../services/improvement-requeue';

let db: Database.Database;
const seed = (id: string, status: string, refs: string[] = ['test-gap:foo'], createdAt = '2026-09-01T00:00:00Z') =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'test', 'Add unit tests for services/foo.ts', 'd', 'r', 'gap_analysis', ?, ?, ?, ?)`).run(id, status, JSON.stringify(refs), createdAt, createdAt);
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());
const who = { actor: 'dennis', reason: 'checks ran without node_modules (#514)' };

it('creates a new linked attempt and leaves the original untouched', () => {
  seed('orig', 'regressed');
  const r = requeueImprovement(db, 'orig', who, { TEST_GAP_MAX_PER_DAY: '4' });
  expect(r.created).toBe(true);
  const orig = db.prepare("SELECT status, evidence_refs_json FROM self_improvements WHERE id = 'orig'").get() as { status: string; evidence_refs_json: string };
  expect(orig).toEqual({ status: 'regressed', evidence_refs_json: '["test-gap:foo"]' });
  const copy = db.prepare('SELECT status, approved_by, evidence_refs_json FROM self_improvements WHERE id = ?').get(r.id) as { status: string; approved_by: string; evidence_refs_json: string };
  expect(copy.status).toBe('scheduled'); expect(copy.approved_by).toBe('dennis');
  expect(JSON.parse(copy.evidence_refs_json)).toEqual(['test-gap:foo', 'requeue-of:orig', 'requeue-by:dennis', 'requeue-reason:checks ran without node_modules (#514)']);
  expect(db.prepare("SELECT reason FROM judgments WHERE judgment = 'requeue' AND subject_id = 'orig'").get()).toEqual({ reason: `requeued as ${r.id} by dennis: checks ran without node_modules (#514)` });
});

it('is idempotent per original', () => {
  seed('orig', 'regressed');
  const first = requeueImprovement(db, 'orig', who, { TEST_GAP_MAX_PER_DAY: '4' });
  expect(requeueImprovement(db, 'orig', who, { TEST_GAP_MAX_PER_DAY: '4' })).toEqual({ id: first.id, created: false });
  expect((db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as { n: number }).n).toBe(2);
});

it('counts against the lane budget', () => {
  seed('orig', 'regressed');
  seed('today', 'proposed', ['test-gap:bar'], new Date().toISOString());
  expect(() => requeueImprovement(db, 'orig', who, { TEST_GAP_MAX_PER_DAY: '1' })).toThrow('REQUEUE_BUDGET_EXHAUSTED');
});

it('refuses an escalated original without explicit approval, and records the approval when given', () => {
  seed('orig', 'regressed');
  db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES ('g', 'orig', 't', 'low', 'failed')").run();
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run', 'g', 'l', 'closed', 'escalated', '[]', '{}', '[]', '[]', '{}', '2026-09-01', '2026-09-01')`).run();
  expect(() => requeueImprovement(db, 'orig', who, { TEST_GAP_MAX_PER_DAY: '4' })).toThrow('REQUEUE_ESCALATED_NEEDS_APPROVAL');
  requeueImprovement(db, 'orig', { ...who, approveEscalation: true }, { TEST_GAP_MAX_PER_DAY: '4' });
  expect((db.prepare("SELECT reason FROM judgments WHERE judgment = 'requeue'").get() as { reason: string }).reason).toContain('(escalation approved)');
});

it('refuses proposals that are still open or verified, and requires actor and reason', () => {
  seed('open', 'scheduled'); seed('done', 'verified'); seed('orig', 'regressed');
  expect(() => requeueImprovement(db, 'open', who)).toThrow('REQUEUE_STATUS_NOT_ALLOWED');
  expect(() => requeueImprovement(db, 'done', who)).toThrow('REQUEUE_STATUS_NOT_ALLOWED');
  expect(() => requeueImprovement(db, 'orig', { actor: ' ', reason: 'long enough' })).toThrow('REQUEUE_ACTOR_REQUIRED');
  expect(() => requeueImprovement(db, 'orig', { actor: 'x', reason: '' })).toThrow('REQUEUE_REASON_REQUIRED');
});
