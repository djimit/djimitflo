import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// admission is judged at a fixed instant, not the wall clock (helpers/admission-now.ts; ledger expiries 2026-11-27 / 2026-12-31)
vi.mock('../execution/runtime-admission', () => import('./helpers/admission-now').then((m) => m.admissionAtFixedNow()));
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { BackgroundWorkerService } from '../services/background-worker-service';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';

/**
 * M0 property F (prod lease ac827d48: cancelled superseded_by_evolve_winner 05:48Z, approved 06:44Z, its task completed
 * 06:50Z): an approval decision started the worker task whatever had happened to its lease or loop run. An approval is
 * evidence for live work only: a task whose lease ended or whose run is terminal is cancelled, never executed, and the
 * approval does not stay pending.
 */
let db: Database.Database;
let engine: ExecutionEngine;
let approvals: ApprovalService;
let start: ReturnType<typeof vi.fn>;
const taskId = 'loop-worker-lease-x-0001';

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const ws = { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() };
  engine = new ExecutionEngine(db, ws as any);
  approvals = new ApprovalService(db, ws, new AuditService(db));
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('run-x', 'doc-drift-and-small-fix-loop', 'closed', 'running')").run();
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES ('lease-x', 'run-x', 'maker', 'mock', 'prepared', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ execution_task_id: taskId }));
  db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata)
    VALUES (?, 'maker worker', 'Fix the finding', 'pending', 'medium', 'high', 'local', ?)`).run(taskId, JSON.stringify({ loop_run_id: 'run-x', lease_id: 'lease-x' }));
  start = vi.fn(async (task: { id: string }) => ({ id: 'session', taskId: task.id, executorKind: 'mock', status: 'running',
    startedAt: new Date(), events: (async function* () {})(), cancel: async () => {}, result: Promise.resolve({ status: 'completed', metrics: {} }) }));
  engine.registerExecutor({ kind: 'mock', canExecute: () => true, start } as any);
});
afterEach(() => { runtimeConcurrencySemaphore.release(`execution:${taskId}`); vi.restoreAllMocks(); db.close(); });

async function gate(): Promise<string> {
  const result = await engine.executeTask(taskId, 'mock', 'maker');
  expect(result.status).toBe('awaiting_approval');
  return result.approvalId!;
}
const approvalStatus = (id: string) => (db.prepare('SELECT status FROM approvals WHERE id = ?').get(id) as { status: string }).status;
const taskRow = () => db.prepare('SELECT status, metadata FROM tasks WHERE id = ?').get(taskId) as { status: string; metadata: string };

it.each([
  ['the lease was cancelled (evolve supersede)', "UPDATE worker_leases SET status = 'cancelled' WHERE id = 'lease-x'"],
  ['the lease failed (stale_timeout)', "UPDATE worker_leases SET status = 'failed' WHERE id = 'lease-x'"],
  ['the loop run was cancelled', "UPDATE loop_runs SET status = 'cancelled' WHERE id = 'run-x'"],
  ['the loop run completed', "UPDATE loop_runs SET status = 'completed' WHERE id = 'run-x'"],
])('does not execute an approved task when %s', async (_label, sql) => {
  const approvalId = await gate();
  db.exec(sql);
  const result = await engine.handleApprovalDecision(approvalId, true, 'dennis');
  expect(start).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: 'denied', reason: 'lease_not_active_at_approval' });
  expect(approvalStatus(approvalId)).toBe('expired'); // not left pending, and never 'approved' (no inheritance origin)
  expect(taskRow().status).toBe('cancelled');
  expect(JSON.parse(taskRow().metadata).cancellation_reason).toBe('lease_not_active_at_approval');
  const event = db.prepare("SELECT metadata FROM execution_events WHERE task_id = ? AND event_type = 'task.cancelled'").get(taskId) as { metadata: string } | undefined;
  expect(JSON.parse(event!.metadata)).toMatchObject({ reason: 'lease_not_active_at_approval', lease_id: 'lease-x', loop_run_id: 'run-x' });
});

it('still executes an approved task whose lease and run are live', async () => {
  const approvalId = await gate();
  const result = await engine.handleApprovalDecision(approvalId, true, 'dennis');
  expect(result?.status).toBe('started');
  await result!.completion;
  expect(start).toHaveBeenCalledOnce();
  expect(approvalStatus(approvalId)).toBe('approved');
});

it('a denial of an ended worker is recorded as a denial', async () => {
  const approvalId = await gate();
  db.exec("UPDATE worker_leases SET status = 'cancelled' WHERE id = 'lease-x'");
  expect(await engine.handleApprovalDecision(approvalId, false, 'dennis', 'no')).toMatchObject({ status: 'denied' });
  expect(approvalStatus(approvalId)).toBe('denied');
  expect(start).not.toHaveBeenCalled();
});

it('the orphan lease cleanup expires a pending approval whose lease was cancelled, with an audit row', async () => {
  const approvalId = await gate();
  db.exec("UPDATE worker_leases SET status = 'cancelled' WHERE id = 'lease-x'");
  const live = 'loop-worker-lease-y-0001'; // a live worker's approval stays pending
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
    VALUES ('lease-y', 'run-x', 'maker', 'mock', 'prepared', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ execution_task_id: live }));
  db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata)
    VALUES (?, 'maker worker', 'Other finding', 'pending', 'medium', 'high', 'local', ?)`).run(live, JSON.stringify({ loop_run_id: 'run-x', lease_id: 'lease-y' }));
  const liveApproval = (await engine.executeTask(live, 'mock', 'maker')).approvalId!;
  runtimeConcurrencySemaphore.release(`execution:${live}`);

  await new BackgroundWorkerService(db).runWorker('orphan-lease-cleanup');
  expect(approvalStatus(approvalId)).toBe('expired');
  expect(taskRow().status).toBe('cancelled');
  expect(approvalStatus(liveApproval)).toBe('pending');
  expect(db.prepare("SELECT decision_reason FROM approvals WHERE id = ?").get(approvalId)).toEqual({ decision_reason: 'worker_lease_ended' });
  expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'approval.expired' AND resource_id = ?").get(approvalId)).toEqual({ n: 1 });
  await expect(engine.handleApprovalDecision(approvalId, true, 'dennis')).rejects.toThrow('APPROVAL_EXPIRED');
  expect(start).not.toHaveBeenCalled();
});
