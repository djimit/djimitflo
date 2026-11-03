import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('verified proposal whose maker ran before the runtime assertion-strength check (#730)', () => {
  const makerRun = (improvementId: string, checks: unknown[] | null) => {
    db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 't', 'low', 'completed')").run(`g-${improvementId}`, improvementId);
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, 'l', 'closed', 'ready_for_human_merge', '[]', '{}', '[]', '[]', '{}', '2026-09-01', '2026-09-01')`).run(`run-${improvementId}`, `g-${improvementId}`);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES (?, ?, 'maker', 'codex', 'completed', ?, '2026-09-01', '2026-09-01')`)
      .run(`m-${improvementId}`, `run-${improvementId}`, JSON.stringify(checks ? { deterministic_checks: checks } : {}));
  };
  const env = { TEST_GAP_MAX_PER_DAY: '4' };

  it('creates a copy when the latest maker run has no runtime verdict, and records the eligibility reason', () => {
    seed('v', 'verified'); makerRun('v', [{ name: 'test:unit', status: 'pass' }]);
    const r = requeueImprovement(db, 'v', who, env);
    expect(r.created).toBe(true);
    expect(db.prepare("SELECT status FROM self_improvements WHERE id = 'v'").get()).toEqual({ status: 'verified' });
    const copy = db.prepare('SELECT status, evidence_refs_json FROM self_improvements WHERE id = ?').get(r.id) as { status: string; evidence_refs_json: string };
    expect(copy.status).toBe('scheduled');
    expect(JSON.parse(copy.evidence_refs_json)).toContain('requeue-eligibility:assertion_verdict_missing');
    expect((db.prepare("SELECT reason FROM judgments WHERE judgment = 'requeue' AND subject_id = 'v'").get() as { reason: string }).reason).toContain('[assertion_verdict_missing]');
  });

  it('refuses when the maker run has a runtime verdict (shadow pass)', () => {
    seed('v', 'verified'); makerRun('v', [{ name: 'test:assertion-strength', status: 'skipped', shadow_status: 'pass' }]);
    expect(() => requeueImprovement(db, 'v', who, env)).toThrow('REQUEUE_STATUS_NOT_ALLOWED');
  });

  it('does not count the retroactive offline judgment as a runtime verdict', () => {
    seed('v', 'verified'); makerRun('v', null);
    for (const [type, subject] of [['self_improvement', 'v'], ['loop_run', 'run-v']]) {
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
        VALUES (?, 'assertion_strength_retroactive', ?, ?, 'h', 'shadow', 'yes', 'offline pass', '2026-10-13')`).run(`j-${subject}`, type, subject);
    }
    expect(requeueImprovement(db, 'v', who, env).created).toBe(true);
  });

  it('refuses a verified proposal outside the test-writing lanes (the check never runs there)', () => {
    seed('v', 'verified', ['openspec:foo']); makerRun('v', []);
    expect(() => requeueImprovement(db, 'v', who, env)).toThrow('REQUEUE_STATUS_NOT_ALLOWED');
  });

  it('refuses a verified proposal with no maker run at all', () => {
    seed('v', 'verified');
    expect(() => requeueImprovement(db, 'v', who, env)).toThrow('REQUEUE_STATUS_NOT_ALLOWED');
  });

  it('still counts against the lane budget', () => {
    seed('v', 'verified'); makerRun('v', []);
    seed('today', 'proposed', ['test-gap:bar'], new Date().toISOString());
    expect(() => requeueImprovement(db, 'v', who, { TEST_GAP_MAX_PER_DAY: '1' })).toThrow('REQUEUE_BUDGET_EXHAUSTED');
  });

  it('is idempotent: a second requeue returns the same copy', () => {
    seed('v', 'verified'); makerRun('v', []);
    const first = requeueImprovement(db, 'v', who, env);
    expect(requeueImprovement(db, 'v', who, env)).toEqual({ id: first.id, created: false });
    expect((db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as { n: number }).n).toBe(2);
  });
});
