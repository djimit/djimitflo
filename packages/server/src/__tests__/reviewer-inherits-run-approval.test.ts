import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';

let db: Database.Database;
let engine: ExecutionEngine;
const inherits = (id: string) => (engine as unknown as { reviewerInheritsRunApproval(id: string): boolean }).reviewerInheritsRunApproval(id);

/** a loop-created worker task: its lease of the same run names it as execution_task_id (loop-worker-executor-service) */
function task(id: string, role: string, runId: string, opts: { lease?: boolean } = {}) {
  const leaseId = `lease-${id}`;
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES (?, 't', 'd', 'awaiting_approval', 'low', 'medium', 'local', ?, ?, datetime('now'), datetime('now'))")
    .run(id, JSON.stringify(['loop-worker', role, 'opencode']), JSON.stringify({ loop_run_id: runId, lease_id: leaseId }));
  if (opts.lease === false) return;
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'opencode', 'prepared', ?, datetime('now'), datetime('now'))")
    .run(leaseId, runId, role, JSON.stringify({ execution_task_id: id }));
}
function approval(id: string, taskId: string, over: { status?: string; decidedBy?: string | null; expires?: string } = {}) {
  db.prepare("INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'medium', 'high_risk_action', 'm', '{}', ?, ?, datetime('now'), datetime('now'))")
    .run(id, taskId, over.status ?? 'approved', over.decidedBy === undefined ? 'operator' : over.decidedBy, over.expires ?? new Date(Date.now() + 3600_000).toISOString());
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  engine = new ExecutionEngine(db);
  process.env.LOOP_REVIEWER_APPROVAL_INHERIT = 'true';
  task('maker-1', 'maker', 'run-1'); task('checker-1', 'checker', 'run-1'); task('sec-1', 'security_checker', 'run-1');
  task('checker-other', 'checker', 'run-2'); task('maker-2', 'maker', 'run-1');
});
afterEach(() => { delete process.env.LOOP_REVIEWER_APPROVAL_INHERIT; db.close(); vi.restoreAllMocks(); });

it('checker and security checker inherit a human-approved, unexpired maker approval of the same run', () => {
  approval('a1', 'maker-1');
  expect(inherits('checker-1')).toBe(true);
  expect(inherits('sec-1')).toBe(true);
});
it('never inherits: makers, other runs, system decisions, pending/expired approvals, or when the flag is off', () => {
  approval('a1', 'maker-1');
  expect(inherits('maker-2')).toBe(false);          // a second maker needs its own approval
  expect(inherits('checker-other')).toBe(false);    // different run
  db.prepare("UPDATE approvals SET decided_by = 'system'").run();
  expect(inherits('checker-1')).toBe(false);
  db.prepare("UPDATE approvals SET decided_by = 'operator', status = 'pending'").run();
  expect(inherits('checker-1')).toBe(false);
  db.prepare("UPDATE approvals SET status = 'approved', expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
  expect(inherits('checker-1')).toBe(false);
  db.prepare("UPDATE approvals SET expires_at = ?").run(new Date(Date.now() + 3600_000).toISOString());
  expect(inherits('checker-1')).toBe(true);
  delete process.env.LOOP_REVIEWER_APPROVAL_INHERIT;
  expect(inherits('checker-1')).toBe(false);
});
it('records an audit event when a reviewer inherits', () => {
  approval('a1', 'maker-1'); inherits('checker-1');
  expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'reviewer_inherited_run_approval'").get()).toEqual({ n: 1 });
});

it('AUTHZ-F4: a task that only claims to be a reviewer (tags + loop_run_id from POST /tasks) does not inherit', () => {
  approval('a1', 'maker-1');
  task('forged-checker', 'checker', 'run-1', { lease: false }); // no lease names it
  expect(inherits('forged-checker')).toBe(false);
  // pointing at a real reviewer lease of the run is not enough: the lease names its own execution task
  db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.lease_id', 'lease-checker-1') WHERE id = 'forged-checker'").run();
  expect(inherits('forged-checker')).toBe(false);
  expect(inherits('checker-1')).toBe(true);
});
