import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';

let db: Database.Database;
let engine: ExecutionEngine;
let approvals: ApprovalService;
let start: ReturnType<typeof vi.fn>;
const id = 'approval-binding-fixture';
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const ws = { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() };
  engine = new ExecutionEngine(db, ws as any);
  approvals = new ApprovalService(db, ws, new AuditService(db));
  db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,metadata)
    VALUES (?, 'Review fixture', 'Read local fixture', 'pending', 'medium', 'high', 'local', '{}')`).run(id);
  start = vi.fn(async () => { throw new Error('Unexpected executor start'); });
  engine.registerExecutor({ kind: 'mock', canExecute: () => true, start } as any);
});
afterEach(() => { runtimeConcurrencySemaphore.release(`execution:${id}`); vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

async function approved() {
  const gate = await engine.executeTask(id, 'mock', 'maker');
  expect(gate.status).toBe('awaiting_approval');
  approvals.decideApproval(gate.approvalId!, true, 'checker');
  return gate.approvalId!;
}

it.each([
  ["description = ?", 'Different local work'],
  ["title = ?", 'Different target'],
  ["metadata = ?", JSON.stringify({ model: 'different-model' })],
  ["metadata = ?", JSON.stringify({ sandbox: { enabled: true, networkMode: 'host' } })],
  ["tags = ?", JSON.stringify(['new-instructions'])],
])('requires a new approval after execution input changes: %s %s', async (column, value) => {
  const first = await approved();
  db.prepare(`UPDATE tasks SET ${column} WHERE id=?`).run(value, id);
  const next = await engine.executeTask(id, 'mock', 'maker');
  expect(next.status).toBe('awaiting_approval');
  expect(next.approvalId).not.toBe(first);
  expect(start).not.toHaveBeenCalled();
});

it.each(['2000-01-01T00:00:00.000Z', 'not-a-date', null])('does not reuse an approved grant whose expiry is %s', async expiry => {
  const first = await approved();
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(expiry, first);
  expect((await engine.executeTask(id, 'mock', 'maker')).status).toBe('awaiting_approval');
  expect(start).not.toHaveBeenCalled();
});

it('rejects historical unbound approvals and manual action metadata as execution grants', async () => {
  const first = await approved();
  db.prepare('UPDATE approvals SET metadata=? WHERE id=?').run(JSON.stringify({ executorKind: 'mock' }), first);
  expect((engine as any).hasApprovedStart(id, 'mock')).toBe(false);
  db.prepare('UPDATE approvals SET metadata=? WHERE id=?').run(JSON.stringify({ executorKind: 'mock', manual_action: true }), first);
  expect((engine as any).hasApprovedStart(id, 'mock')).toBe(false);
});

it('dispatches the unchanged approved input and preserves canonical metadata ordering', async () => {
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{"model":"fixture","nested":{"b":2,"a":1}}', id);
  await approved();
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{"nested":{"a":1,"b":2},"model":"fixture"}', id);
  start.mockImplementation(async task => ({ id: 'fixture-session', taskId: task.id, executorKind: 'mock', status: 'running',
    startedAt: new Date(), events: (async function* () {})(), cancel: async () => {},
    result: Promise.resolve({ status: 'completed', metrics: {} }),
  }));
  const dispatched = await engine.executeTask(id, 'mock', 'checker');
  expect(dispatched.status).toBe('started');
  await dispatched.completion;
  await vi.waitFor(() => expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({ status: 'completed' }));
  expect(start).toHaveBeenCalledOnce();
});

it('rechecks approved input after a capacity wait before starting any executor', async () => {
  await approved();
  vi.spyOn(runtimeConcurrencySemaphore, 'acquire').mockImplementation(async () => {
    db.prepare("UPDATE tasks SET description='Changed while queued' WHERE id=?").run(id);
  });
  await expect(engine.executeTask(id, 'mock', 'checker')).rejects.toThrow('TASK_EXECUTION_INPUT_CHANGED');
  expect(start).not.toHaveBeenCalled();
});

it('does not fall back to an older grant after a newer refusal', async () => {
  const first = await approved();
  const row = approvals.getApproval(first)!;
  const next = approvals.createApproval({ task: (engine as any).getTask(id),
    assessment: row.request_data.assessment as any, requestType: row.request_type,
    title: 'Reconsider', description: 'Reconsider same input', requestedBy: 'maker', metadata: row.metadata });
  approvals.decideApproval(next.id, false, 'checker');
  expect((engine as any).hasApprovedStart(id, 'mock')).toBe(false);
  expect((await engine.executeTask(id, 'mock', 'maker')).status).toBe('awaiting_approval');
  expect(start).not.toHaveBeenCalled();
});

it('rechecks grant expiry after capacity becomes available', async () => {
  const grant = await approved();
  vi.spyOn(runtimeConcurrencySemaphore, 'acquire').mockImplementation(async () => {
    db.prepare("UPDATE approvals SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(grant);
  });
  await expect(engine.executeTask(id, 'mock', 'checker')).rejects.toThrow('approval is no longer current');
  expect(start).not.toHaveBeenCalled();
});

it('refuses a retired agent even if a legacy writer left its operational status active', async () => {
  db.prepare("INSERT INTO agents(id,name,description,capabilities,status,retired_at) VALUES ('retired-fixture','Retired fixture','Fixture-only retired agent','[]','active',?)").run(new Date().toISOString());
  db.prepare('UPDATE tasks SET agent_id=? WHERE id=?').run('retired-fixture', id);
  await expect(engine.executeTask(id, 'mock', 'maker')).rejects.toThrow('is retired');
  expect(start).not.toHaveBeenCalled();
});

it.each(['deny', 'require_approval'])('reassesses a new %s policy after waiting for capacity', async decision => {
  db.prepare("UPDATE tasks SET risk_level='low' WHERE id=?").run(id);
  const assessment = (engine as any).riskClassifier.assessTask((engine as any).getTask(id), 'mock', process.cwd());
  vi.spyOn(runtimeConcurrencySemaphore, 'acquire').mockImplementation(async () => {
    db.prepare(`INSERT INTO approval_policies(id,name,description,risk_levels,tool_patterns,file_patterns,action_type,decision,priority,enabled)
      VALUES ('late-policy','Queue policy','Fixture-only changed policy',?,'[]','[]',?,?,99999,1)`)
      .run(JSON.stringify([assessment.risk_level]), assessment.action_type, decision);
  });
  await expect(engine.executeTask(id, 'mock', 'maker')).rejects.toMatchObject({ code: decision === 'deny' ? 'EXECUTION_POLICY_DENIED' : 'EXECUTION_APPROVAL_STALE' });
  expect(start).not.toHaveBeenCalled();
  const evidence = db.prepare("SELECT details FROM execution_evidence WHERE task_id=? AND source='queue-admission' ORDER BY rowid DESC LIMIT 1").get(id) as { details: string };
  expect(JSON.parse(evidence.details)).toMatchObject({ previousDecision: 'allow', decision });
});

it('reassesses newly tightened governance evidence after capacity becomes available', async () => {
  db.prepare("UPDATE tasks SET risk_level='low' WHERE id=?").run(id);
  vi.stubEnv('GOVERNANCE_GATE_ENABLED', 'true');
  vi.stubEnv('GOVERNANCE_GATE_MODEL_MAP', 'mock=fixture-model');
  vi.spyOn(runtimeConcurrencySemaphore, 'acquire').mockImplementation(async () => {
    db.prepare("INSERT INTO openmythos_eval_runs(id,agent_id,status,overall_score,finished_at,metadata) VALUES ('queue-governance','nightly:fixture-model','completed',1,?,'{}')").run(new Date().toISOString());
  });
  await expect(engine.executeTask(id, 'mock', 'maker')).rejects.toMatchObject({ code: 'EXECUTION_APPROVAL_STALE' });
  expect(start).not.toHaveBeenCalled();
  const evidence = db.prepare("SELECT details FROM execution_evidence WHERE task_id=? AND source='queue-admission' ORDER BY rowid DESC LIMIT 1").get(id) as { details: string };
  expect(JSON.parse(evidence.details)).toMatchObject({ previousDecision: 'allow', decision: 'require_approval', governanceAction: 'require_approval' });
});

it.each(['cancelled', 'paused'])('does not dispatch a task marked %s while waiting for capacity', async status => {
  await approved();
  vi.spyOn(runtimeConcurrencySemaphore, 'acquire').mockImplementation(async () => {
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id);
  });
  await expect(engine.executeTask(id, 'mock', 'checker')).rejects.toMatchObject({ code: 'TASK_EXECUTION_STATE_CHANGED' });
  expect(start).not.toHaveBeenCalled();
  expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({ status });
});

it.each(['execution_recovery_hold', 'deep_agent_assurance_hold'])('rechecks %s established while waiting for capacity', async hold => {
  await approved();
  vi.spyOn(runtimeConcurrencySemaphore, 'acquire').mockImplementation(async () => {
    db.prepare('UPDATE tasks SET metadata=json_set(metadata,?,json(?)) WHERE id=?').run(`$.${hold}`, 'true', id);
  });
  await expect(engine.executeTask(id, 'mock', 'checker')).rejects.toMatchObject({ code: hold === 'execution_recovery_hold' ? 'EXECUTION_RECOVERY_REQUIRED' : 'DEEP_AGENT_ASSURANCE_HOLD' });
  expect(start).not.toHaveBeenCalled();
});
