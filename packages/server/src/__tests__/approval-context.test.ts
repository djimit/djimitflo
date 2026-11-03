import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { approvalContext } from '../services/approval-context';

describe('approvalContext', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  const task = (id: string, metadata: object, description = 'Do the thing') => db.prepare(
    "INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES (?, 't', ?, 'awaiting_approval', 'low', 'high', 'local', '[]', ?, datetime('now'), datetime('now'))"
  ).run(id, description, JSON.stringify(metadata));

  it('explains a loop-worker approval: goal, proposal, runtime, directory and what the worker is asked', () => {
    db.prepare("INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at) VALUES ('g1', 'Add an idempotency test', 'running', 'low', '[]', '{}', 'imp1', '{}', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at) VALUES ('imp1', 'feature', 'Idempotent sweep test', 'd', 'r', 'reflection', 'executing', 0.5, datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run1', 'g1', 'doc-drift-and-small-fix-loop', 'closed', 'running')").run();
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('lease1', 'run1', 'maker', 'opencode', 'prepared', '{}', datetime('now'), datetime('now'))").run();
    task('t1', { loop_run_id: 'run1', lease_id: 'lease1', workingDirectory: '/data/loop-worktrees/run1/f1' }, 'x'.repeat(900));
    expect(approvalContext(db, 't1')).toMatchObject({
      kind: 'loop_worker', goal_objective: 'Add an idempotency test', proposal_title: 'Idempotent sweep test',
      loop_run_id: 'run1', lease_role: 'maker', runtime: 'opencode', working_directory: '/data/loop-worktrees/run1/f1',
    });
    expect(approvalContext(db, 't1')!.prompt_preview!.length).toBe(500);
  });

  it('is null for ordinary tasks and for unknown tasks (never breaks the queue)', () => {
    task('plain', { executor: 'opencode' });
    expect(approvalContext(db, 'plain')).toBeNull();
    expect(approvalContext(db, 'missing')).toBeNull();
  });
});
