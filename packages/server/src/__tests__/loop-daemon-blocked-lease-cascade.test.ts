import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * C-reliability 30-10 §1d / candidate 5: 10 manual reviewer leases stayed `prepared` for up to 48 h on 4 runs the daemon had
 * set `blocked` (failed gates) with their goals `failed` and no approval pending. They counted as live work. The daemon now
 * settles them with the O2b cascade reason when it blocks the run; running leases and runs still waiting on an approval
 * are never touched.
 */
describe('LoopDaemon: a blocked run with a failed goal cancels its still-prepared leases', () => {
  let db: Database.Database;
  let goalId: string;
  let stubLoops: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    db.pragma('foreign_keys = OFF');
    const goal = new GoalService(db).createGoal({ objective: 'Fix a small doc drift issue', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
    goalId = goal.id;
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goalId);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, created_at, updated_at) VALUES ('run-1', ?, 'doc-drift-and-small-fix-loop', 'closed', 'running', ?, ?)").run(goalId, now, now);
    const lease = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?)");
    lease.run('maker-1', 'maker', 'opencode', 'completed', '{}', now, now);
    lease.run('checker-1', 'checker', 'manual', 'prepared', '{}', now, now);
    lease.run('security-1', 'security_checker', 'manual', 'prepared', '{}', now, now);
    lease.run('sibling-1', 'maker', 'opencode', 'running', '{}', now, now);
    stubLoops = {
      startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'f', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
      continueLoopRun: vi.fn(() => ({ leases: [
        { id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'opencode' },
        { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' },
      ] })),
      executeWorker: vi.fn(async () => ({})),
      runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
      retryLoopRun: vi.fn(),
      executeChecker: vi.fn(async () => ({})),
      verifyLoopRun: vi.fn(() => ({ gates: [{ name: 'checker_verdict', status: 'fail', evidence: 'no verdict' }] })),
      pruneOrphanedWorktrees: vi.fn(),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function runOneTick() {
    const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    daemon.stop();
  }
  const lease = (id: string) => {
    const r = db.prepare('SELECT status, metadata FROM worker_leases WHERE id = ?').get(id) as { status: string; metadata: string };
    return { status: r.status, metadata: JSON.parse(r.metadata) as Record<string, any> };
  };

  it('cancels prepared leases with cascade:run_blocked and leaves the running one alone', async () => {
    await runOneTick();
    expect((db.prepare('SELECT status FROM loop_runs WHERE id = ?').get('run-1') as { status: string }).status).toBe('blocked');
    expect((db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string }).status).toBe('failed');
    for (const id of ['checker-1', 'security-1']) {
      expect(lease(id)).toMatchObject({ status: 'cancelled', metadata: { cancellation_reason: 'cascade:run_blocked',
        failure: { stage: 'cancel', cancellation_reason: 'cascade:run_blocked', exit_observed: false } } });
    }
    expect(lease('sibling-1').status).toBe('running');
    expect(lease('maker-1').status).toBe('completed');
  });

  it('never touches a run that still waits on a pending approval', async () => {
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('task-sec', 't', 'd', 'awaiting_approval', 'medium', 'low', 'local', '{}')").run();
    db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data)
      VALUES ('appr-1', 'task-sec', 'pending', 'low', 'high_risk_action', 'run?', '{}')`).run();
    db.prepare("UPDATE worker_leases SET metadata = json_set(metadata, '$.execution_task_id', 'task-sec') WHERE id = 'security-1'").run();
    await runOneTick();
    expect((db.prepare('SELECT status FROM loop_runs WHERE id = ?').get('run-1') as { status: string }).status).toBe('blocked');
    expect(lease('checker-1').status).toBe('prepared');
    expect(lease('security-1').status).toBe('prepared');
  });
});
