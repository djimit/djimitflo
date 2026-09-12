import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';

let db: Database.Database;
let engine: ExecutionEngine;
let ws: { broadcastTaskEvent: ReturnType<typeof vi.fn>; broadcastTaskEventById: ReturnType<typeof vi.fn> };
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  ws = { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn() };
  engine = new ExecutionEngine(db, ws as any);
  db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode)
    VALUES ('terminal-fixture','Read fixture','Read local fixture','pending','medium','low','local')`).run();
});
afterEach(() => { runtimeConcurrencySemaphore.release('execution:terminal-fixture'); db.close(); });

it.each(['completed', 'failed'] as const)('records actual engine %s before publishing terminal state, without duplicate replay', async status => {
  const terminalAtBroadcast: unknown[] = [];
  ws.broadcastTaskEvent.mockImplementation((_task, message) => {
    if (message.payload.task.status === status) {
      terminalAtBroadcast.push(db.prepare("SELECT action,outcome FROM audit_events WHERE task_id='terminal-fixture'").all());
    }
  });
  engine.registerExecutor({ kind: 'mock', canExecute: () => true, start: async (task: Task) => ({
    id: 'terminal-session', taskId: task.id, executorKind: 'mock', status: 'running',
    startedAt: new Date(), events: (async function* () {})(), cancel: async () => {},
    result: Promise.resolve({ status, message: 'private worker output must not enter canonical audit', metrics: {} }),
  }) });
  const execution = await engine.executeTask('terminal-fixture', 'mock');
  expect(execution.status).toBe('started');
  await execution.completion;
  await vi.waitFor(() => expect(db.prepare("SELECT status FROM tasks WHERE id='terminal-fixture'").get()).toEqual({ status }));
  const expected = { event_type: status === 'completed' ? 'task.executed' : 'execution.failed',
    action: `execution_${status}`, outcome: status === 'completed' ? 'success' : 'failure' };
  const rows = db.prepare("SELECT event_type,action,outcome,before,after,metadata FROM audit_events WHERE task_id='terminal-fixture'").all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(expected);
  expect(JSON.parse(rows[0].before)).toMatchObject({ status: 'running' });
  expect(JSON.parse(rows[0].after)).toMatchObject({ status });
  expect(JSON.stringify(rows)).not.toContain('private worker output');
  expect(terminalAtBroadcast.length).toBeGreaterThan(0);
  for (const observed of terminalAtBroadcast) expect(observed).toEqual([{ action: expected.action, outcome: expected.outcome }]);
  (engine as any).updateTaskStatus('terminal-fixture', status);
  expect(db.prepare("SELECT count(*) AS count FROM audit_events WHERE task_id='terminal-fixture'").get()).toEqual({ count: 1 });
});

it.each(['completed', 'failed'] as const)('rolls back %s state and timestamps when canonical audit insertion fails', status => {
  db.prepare("UPDATE tasks SET status='running', updated_at='2026-01-01T00:00:00.000Z' WHERE id='terminal-fixture'").run();
  db.exec(`CREATE TRIGGER reject_terminal_audit BEFORE INSERT ON audit_events
    WHEN NEW.action IN ('execution_completed','execution_failed')
    BEGIN SELECT RAISE(ABORT, 'injected canonical audit failure'); END;`);
  const session = { id: 'terminal-session', taskId: 'terminal-fixture', executorKind: 'mock',
    status: 'running', startedAt: new Date(), cancel: async () => {} };
  (engine as any).activeSessions.set('terminal-fixture', session);
  expect(() => (engine as any).handleExecutionComplete('terminal-fixture', session, { status, metrics: {} }))
    .toThrow('injected canonical audit failure');
  expect(db.prepare("SELECT status,completed_at,failed_at,updated_at FROM tasks WHERE id='terminal-fixture'").get())
    .toEqual({ status: 'running', completed_at: null, failed_at: null, updated_at: '2026-01-01T00:00:00.000Z' });
  expect(db.prepare("SELECT count(*) AS count FROM audit_events WHERE task_id='terminal-fixture'").get()).toEqual({ count: 0 });
  expect(ws.broadcastTaskEvent).not.toHaveBeenCalled();
});
