import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';

let db: Database.Database;
let engine: ExecutionEngine;
const inherits = (id: string) => (engine as unknown as { reviewerInheritsRunApproval(id: string): boolean }).reviewerInheritsRunApproval(id);

function task(id: string, role: string, runId: string) {
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES (?, 't', 'd', 'awaiting_approval', 'low', 'medium', 'local', ?, ?, datetime('now'), datetime('now'))")
    .run(id, JSON.stringify(['loop-worker', role, 'opencode']), JSON.stringify({ loop_run_id: runId }));
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
