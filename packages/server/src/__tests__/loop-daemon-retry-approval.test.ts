import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * M0 property A (prod 30 d: 13 of 76 retry makers): a retry maker that needs its own approval (not inheritable) threw
 * LOOP_WORKER_APPROVAL_REQUIRED into the daemon's best-effort catch; the goal was verified and failed while the approval
 * stayed pending, a human approved later and the engine ran the retry with nobody reading its result. The retry now parks
 * the goal on its approval, like the checker path, and the resumed run evaluates the retry.
 */
describe('LoopDaemon parks a goal on its retry maker approval', () => {
  let db: Database.Database;
  let goalId: string;
  const prev: Record<string, string | undefined> = {};
  const keys = ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE', 'APPROVAL_INHERIT_ENABLED', 'LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED',
    'LOOP_DAEMON_MAKER_RUNTIME', 'LOOP_EVOLVE_ENABLED', 'LOOP_BANDIT_ENABLED', 'ORACLE_LANES_AUTO_APPROVE', 'FINDING_FIX_AUTO_APPROVE'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF'); // the fixtures below only need the rows the daemon reads
    db.exec(schema);
    runMigrations(db);
    for (const key of keys) { prev[key] = process.env[key]; delete process.env[key]; }
    process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
    goalId = new GoalService(db).createGoal({ objective: 'Add a test', acceptance_criteria: ['pass'], risk_class: 'low', metadata: { source: 'self-improvement' } }).id;
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goalId);
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-a', ?, 'doc-drift-and-small-fix-loop', 'closed', 'running')").run(goalId);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES ('lease-a', 'run-a', 'maker', 'opencode', 'completed', '{}', '2026-11-14T10:00:00.000Z', '2026-11-14T10:00:00.000Z')`).run();
    // what retryLoopRun + executeViaEngine leave behind: a prepared retry maker whose engine task waits for a human
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES ('lease-r', 'run-a', 'maker', 'opencode', 'prepared', ?, '2026-11-14T10:05:00.000Z', '2026-11-14T10:05:00.000Z')`)
      .run(JSON.stringify({ retry_of_maker_lease_id: 'lease-a', retry_root_maker_lease_id: 'lease-a', retry_attempt: 1, execution_task_id: 'task-r', approval_id: 'appr-r' }));
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, tags, metadata, created_at, updated_at) VALUES ('task-r', 't', 'd', 'awaiting_approval', 'low', 'high', 'local', '[]', '{}', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, created_at, updated_at) VALUES ('appr-r', 'task-r', 'pending', 'high', 'high_risk_action', 'm', '{}', datetime('now'), datetime('now'))").run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close(); vi.restoreAllMocks();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const goalRow = () => db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(goalId) as { status: string; metadata: string };
  const leaseRow = (id: string) => db.prepare('SELECT id, role, runtime, status, metadata FROM worker_leases WHERE id = ?').get(id) as { id: string; role: string; runtime: string; status: string; metadata: string };
  const asLease = (id: string) => { const l = leaseRow(id); return { ...l, metadata: JSON.parse(l.metadata) }; };
  // tick() dispatches executeGoal without awaiting it: wait until the goal left the queue state
  const runTick = async (d: LoopDaemon) => { await d.tick(); d.stop(); await vi.waitFor(() => expect(goalRow().status).not.toBe('decomposed')); };

  function stubLoops() {
    let retryApproved = false;
    const loops = {
      pruneOrphanedWorktrees: vi.fn(),
      startObjectiveLoop: vi.fn(() => ({ id: 'run-a', findings: [{ id: 'f1' }] })),
      continueLoopRun: vi.fn(() => ({ run: { id: 'run-a' }, leases: [{ ...asLease('lease-a'), status: 'prepared' }] })),
      getLoopRun: vi.fn(() => ({ id: 'run-a', findings: [{ id: 'f1' }] })),
      listWorkerLeases: vi.fn(() => [asLease('lease-a'), asLease('lease-r')]),
      executeWorker: vi.fn(async (_run: string, input: { lease_id: string }) => {
        if (input.lease_id === 'lease-r' && !retryApproved) throw new Error('LOOP_WORKER_APPROVAL_REQUIRED');
      }),
      // the first maker fails its checks (-> retry), the retry passes them
      runDeterministicChecks: vi.fn((_run: string, input: { lease_id: string }) => ({ run: { status: input.lease_id === 'lease-a' ? 'blocked' : 'running' } })),
      retryLoopRun: vi.fn(() => ({ retry_maker: asLease('lease-r') })),
      awaitWorkerExecution: vi.fn(async () => undefined),
      verifyLoopRun: vi.fn(() => ({ gates: [{ name: 'checker_verdict', status: 'fail' }] })),
    };
    return { loops, approve: () => { retryApproved = true; } };
  }
  const daemonWith = (loops: Record<string, unknown>) => new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });

  it('blocks the goal on the retry approval instead of verifying and failing it', async () => {
    const { loops } = stubLoops();
    await runTick(daemonWith(loops));
    const row = goalRow();
    expect(row.status).toBe('blocked');
    expect(JSON.parse(row.metadata).awaiting_approval).toMatchObject({ approval_id: 'appr-r', run_id: 'run-a', lease_id: 'lease-r' });
    expect(loops.verifyLoopRun).not.toHaveBeenCalled();
    // the retry keeps its human gate: no lane auto-approval is applied to a retry that could not inherit
    expect(db.prepare("SELECT status FROM approvals WHERE id = 'appr-r'").get()).toEqual({ status: 'pending' });
    expect(db.prepare("SELECT COUNT(*) n FROM loop_events WHERE event_type = 'goal_awaiting_approval'").get()).toEqual({ n: 1 });
  });

  it('after approval resumes the run on the retry, reads its result and evaluates it', async () => {
    const { loops, approve } = stubLoops();
    const daemon = daemonWith(loops);
    await runTick(daemon);
    expect(goalRow().status).toBe('blocked');

    // a human approves; the engine runs the retry's task to completion
    approve();
    db.prepare("UPDATE approvals SET status = 'approved', decided_by = 'dennis', decided_at = ? WHERE id = 'appr-r'").run(new Date().toISOString());
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'task-r'").run();
    loops.executeWorker.mockClear(); loops.runDeterministicChecks.mockClear(); loops.retryLoopRun.mockClear();
    await runTick(daemon);

    expect(loops.startObjectiveLoop).toHaveBeenCalledTimes(1); // the same run, not a new one
    expect(loops.getLoopRun).toHaveBeenCalledWith('run-a');
    expect(loops.executeWorker.mock.calls.map((c) => (c[1] as { lease_id: string }).lease_id)).toEqual(['lease-r']); // reads the stored result
    expect(loops.runDeterministicChecks.mock.calls.map((c) => (c[1] as { lease_id: string }).lease_id)).toEqual(['lease-r']);
    expect(loops.retryLoopRun).not.toHaveBeenCalled(); // no second retry
    expect(loops.verifyLoopRun).toHaveBeenCalledTimes(1);
    // the outcome is the retry's
    expect(db.prepare('SELECT agent_id FROM skill_outcomes').all()).toEqual([{ agent_id: 'lease-r' }]);
    expect(goalRow().status).toBe('failed'); // its gates failed: a real verdict, not a dropped result
  });

  it('still fails the goal as before when the retry fails for another reason', async () => {
    const { loops } = stubLoops();
    loops.executeWorker.mockImplementation(async (_run: string, input: { lease_id: string }) => { if (input.lease_id === 'lease-r') throw new Error('RUNTIME_CRASHED'); });
    await runTick(daemonWith(loops));
    expect(loops.verifyLoopRun).toHaveBeenCalledTimes(1);
    expect(goalRow().status).toBe('failed');
    expect(JSON.parse(goalRow().metadata).awaiting_approval).toBeUndefined();
  });
});
