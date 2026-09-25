import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * 2026-09-21 loop proof: the engine asked a human to approve the maker; the daemon marked the goal failed and
 * parked its proposal, and the approval expired unseen. Approval is now a wait: blocked -> resumed/failed.
 */
describe('LoopDaemon waits for worker approval', () => {
  let db: Database.Database;
  let goalId: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF'); // the fixtures below only need the rows the daemon reads
    db.exec(schema);
    runMigrations(db);
    for (const key of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE']) { prev[key] = process.env[key]; delete process.env[key]; }
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    const goal = new GoalService(db).createGoal({ objective: 'Add a test', acceptance_criteria: ['pass'], risk_class: 'low', metadata: { source: 'self-improvement' } });
    goalId = goal.id;
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goalId);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close(); vi.restoreAllMocks();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const goalRow = () => db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(goalId) as { status: string; metadata: string };
  const seedRunWithApprovalLease = () => {
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-a', ?, 'doc-drift-and-small-fix-loop', 'closed', 'running')").run(goalId);
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('lease-a', 'run-a', 'maker', 'opencode', 'prepared', '{\"approval_id\":\"appr-1\"}', datetime('now'), datetime('now'))").run();
  };
  const seedApproval = (status: string, taskStatus: string) => {
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES ('task-a', 't', 'd', ?, 'low', 'high', 'local', '[]', '{}', datetime('now'), datetime('now'))").run(taskStatus);
    db.prepare("INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, created_at, updated_at) VALUES ('appr-1', 'task-a', ?, 'high', 'high_risk_action', 'm', '{}', datetime('now'), datetime('now'))").run(status);
  };
  const daemonWith = (loops: Record<string, unknown>) => new LoopDaemon(db, { pruneOrphanedWorktrees: vi.fn(), ...loops } as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  const runTick = async (d: LoopDaemon) => { await d.tick(); d.stop(); };

  it('blocks the goal (not failed) when the maker needs approval, and keeps the proposal in flight', async () => {
    seedRunWithApprovalLease();
    const loops = {
      startObjectiveLoop: vi.fn(() => ({ id: 'run-a', findings: [{ id: 'f1' }] })),
      continueLoopRun: vi.fn(() => ({ run: { id: 'run-a' }, leases: [{ id: 'lease-a', role: 'maker', status: 'prepared', runtime: 'opencode' }] })),
      executeWorker: vi.fn(async () => { throw new Error('LOOP_WORKER_APPROVAL_REQUIRED'); }),
    };
    await runTick(daemonWith(loops));
    const row = goalRow();
    expect(row.status).toBe('blocked');
    expect(JSON.parse(row.metadata).awaiting_approval).toMatchObject({ approval_id: 'appr-1', run_id: 'run-a', lease_id: 'lease-a' });
    expect(db.prepare("SELECT COUNT(*) n FROM loop_events WHERE event_type = 'goal_awaiting_approval'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM loop_events WHERE event_type = 'goal_failed'").get()).toEqual({ n: 0 });
  });

  it('blocks (not fails) when the automated checker needs its own approval, and waits on the checker approval', async () => {
    process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED = 'true';
    seedRunWithApprovalLease(); // maker lease-a with approval appr-1 in metadata
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('lease-c', 'run-a', 'checker', 'opencode', 'prepared', '{\"execution_task_id\":\"task-c\"}', datetime('now'), datetime('now'))").run();
    // the checker lease carries only the task id; the approval hangs off the task
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES ('task-c', 't', 'd', 'awaiting_approval', 'low', 'high', 'local', '[]', '{}', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, created_at, updated_at) VALUES ('appr-2', 'task-c', 'pending', 'high', 'high_risk_action', 'm', '{}', datetime('now'), datetime('now'))").run();
    const maker = { id: 'lease-a', role: 'maker', status: 'prepared', runtime: 'opencode' };
    const loops = {
      startObjectiveLoop: vi.fn(() => ({ id: 'run-a', findings: [{ id: 'f1' }] })),
      continueLoopRun: vi.fn(() => ({ run: { id: 'run-a' }, leases: [maker] })),
      executeWorker: vi.fn(async () => undefined),
      runDeterministicChecks: vi.fn(() => ({ run: { status: 'running' } })),
      executeChecker: vi.fn(async () => { throw new Error('LOOP_WORKER_APPROVAL_REQUIRED'); }),
      verifyLoopRun: vi.fn(),
    };
    try { await runTick(daemonWith(loops)); } finally { delete process.env.LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED; }
    expect(goalRow().status).toBe('blocked');
    expect(JSON.parse(goalRow().metadata).awaiting_approval).toMatchObject({ approval_id: 'appr-2', lease_id: 'lease-c' });
    expect(loops.verifyLoopRun).not.toHaveBeenCalled();
  });

  const blockGoal = () => db.prepare("UPDATE goals SET status = 'blocked', metadata = json_set(metadata, '$.awaiting_approval', json(?)) WHERE id = ?")
    .run(JSON.stringify({ approval_id: 'appr-1', run_id: 'run-a', lease_id: 'lease-a', since: 'x' }), goalId);

  it('keeps waiting while the approval is pending', async () => {
    seedRunWithApprovalLease(); seedApproval('pending', 'awaiting_approval'); blockGoal();
    const start = vi.fn();
    await runTick(daemonWith({ startObjectiveLoop: start }));
    expect(goalRow().status).toBe('blocked');
    expect(start).not.toHaveBeenCalled();
  });

  it('resumes the same run once approved and the task finished (does not start a new run)', async () => {
    seedRunWithApprovalLease(); seedApproval('approved', 'completed'); blockGoal();
    const start = vi.fn(); const getLoopRun = vi.fn(() => ({ id: 'run-a', findings: [] }));
    await runTick(daemonWith({ startObjectiveLoop: start, getLoopRun }));
    expect(getLoopRun).toHaveBeenCalledWith('run-a');
    expect(start).not.toHaveBeenCalled();
    expect(goalRow().status).toBe('completed'); // stub run has no findings, so the resumed goal completes
  });

  it('waits for an approved task that is still running', async () => {
    seedRunWithApprovalLease(); seedApproval('approved', 'running'); blockGoal();
    await runTick(daemonWith({ startObjectiveLoop: vi.fn() }));
    expect(goalRow().status).toBe('blocked');
  });

  it('fails the goal with a recorded reason when the approval expired or was denied', async () => {
    seedRunWithApprovalLease(); seedApproval('expired', 'cancelled'); blockGoal();
    await runTick(daemonWith({ startObjectiveLoop: vi.fn() }));
    expect(goalRow().status).toBe('failed');
    const ev = db.prepare("SELECT message FROM loop_events WHERE event_type = 'goal_failed'").get() as { message: string };
    expect(ev.message).toBe('approval expired');
  });
});
