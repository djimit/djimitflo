import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskTrace, TRACE_STATES, type TraceState } from '../services/execution-receipt';

/**
 * `taskTrace` in services/execution-receipt.ts projects the tasks + execution_events
 * rows for one task id into a Trace. It is exported but no test names it directly; this
 * test-only file covers it with a minimal in-memory schema (only the columns the
 * function reads). `traceLifecycle` and `executionReceipt` are exercised in
 * commons-signal-bridge.test.ts; this file targets `taskTrace` itself.
 */
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      metadata TEXT,
      updated_at TEXT
    );
    CREATE TABLE execution_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      message TEXT,
      level TEXT,
      metadata TEXT
    );
  `);
});
afterEach(() => { db.close(); });

const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();
const H = 3_600_000;
const admitted = (kind = 'opencode') => JSON.stringify({ source: 'execution-engine', phase: 'admitted', attempt_id: 'a', executorKind: kind });

function task(id: string, status: string, metadata: Record<string, unknown> = {}, updatedAt = iso()): void {
  db.prepare('INSERT INTO tasks (id, status, metadata, updated_at) VALUES (?, ?, ?, ?)').run(id, status, JSON.stringify(metadata), updatedAt);
}
function event(taskId: string, type: string, at: string, metadata: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO execution_events (id, task_id, event_type, timestamp, message, level, metadata) VALUES (?, ?, ?, ?, 'm', 'info', ?)")
    .run(`${taskId}-${type}-${at}-${Math.random()}`, taskId, type, at, JSON.stringify(metadata));
}

describe('taskTrace', () => {
  it('returns an unknown trace with no task id when taskId is null', () => {
    const trace = taskTrace(db, null);
    expect(trace).toMatchObject({ task_id: null, state: 'unknown', attempts: 0, reason: 'no execution task recorded' });
  });

  it('returns an unknown trace when the task row is missing', () => {
    expect(taskTrace(db, 'nope')).toMatchObject({ task_id: null, state: 'unknown' });
  });

  it('returns the terminal state of a completed task with the admission attempts counted', () => {
    task('t-completed', 'completed');
    event('t-completed', 'log', iso(2 * H), JSON.parse(admitted()));
    event('t-completed', 'log', iso(H));
    expect(taskTrace(db, 't-completed')).toMatchObject({ task_id: 't-completed', state: 'completed', attempts: 1, admitted_event_runtime: 'opencode' });
  });

  it('maps failed and cancelled task statuses to their trace state', () => {
    task('t-failed', 'failed');
    task('t-cancelled', 'cancelled');
    expect(taskTrace(db, 't-failed').state).toBe('failed');
    expect(taskTrace(db, 't-cancelled').state).toBe('cancelled');
  });

  it('reports a running task without an engine admission as unknown', () => {
    task('t-running-no-admit', 'running');
    event('t-running-no-admit', 'tool.call', iso(H));
    expect(taskTrace(db, 't-running-no-admit')).toMatchObject({ state: 'unknown', reason: 'running without an engine admission event' });
  });

  it('reports admitted when the only events are the admission itself', () => {
    task('t-admitted', 'running');
    event('t-admitted', 'log', iso(H), JSON.parse(admitted('codex')));
    expect(taskTrace(db, 't-admitted')).toMatchObject({ state: 'admitted', attempts: 1, admitted_event_runtime: 'codex' });
  });

  it('reports started once a non-admission event follows the admission', () => {
    task('t-started', 'running');
    event('t-started', 'log', iso(2 * H), JSON.parse(admitted()));
    event('t-started', 'tool.call', iso(H));
    expect(taskTrace(db, 't-started').state).toBe('started');
  });

  it('reports resumed when a second admission or a task.resumed event appears', () => {
    task('t-resumed', 'running');
    event('t-resumed', 'log', iso(3 * H), JSON.parse(admitted()));
    event('t-resumed', 'task.paused', iso(2 * H));
    event('t-resumed', 'log', iso(H), JSON.parse(admitted()));
    expect(taskTrace(db, 't-resumed')).toMatchObject({ state: 'resumed', attempts: 2 });
  });

  it('reports interrupted for a paused task whose recovery outcome was observed', () => {
    task('t-paused', 'paused', { execution_recovery_outcome: 'recovered' });
    event('t-paused', 'log', iso(H), JSON.parse(admitted()));
    expect(taskTrace(db, 't-paused').state).toBe('interrupted');
  });

  it('reports unknown for a paused task whose recovery outcome was not observed', () => {
    task('t-paused-unknown', 'paused', { execution_recovery_outcome: 'unknown' });
    event('t-paused-unknown', 'log', iso(H), JSON.parse(admitted()));
    expect(taskTrace(db, 't-paused-unknown')).toMatchObject({ state: 'unknown', reason: 'ownership was lost; the external outcome was not observed' });
  });

  it('reports a prepared trace for a queued task that has not started running', () => {
    task('t-queued', 'queued');
    expect(taskTrace(db, 't-queued')).toMatchObject({ state: 'prepared', attempts: 0 });
  });

  it('reports unknown when a running task has no event within the stale threshold', () => {
    task('t-stale', 'running');
    event('t-stale', 'log', iso(5 * H), JSON.parse(admitted()));
    const now = Date.now();
    const trace = taskTrace(db, 't-stale', now, 2 * H);
    expect(trace.state).toBe('unknown');
    expect(trace.reason).toBe('running, but no execution event within the stale threshold');
  });

  it('still reports started when a recent event falls inside the stale window', () => {
    task('t-fresh', 'running');
    event('t-fresh', 'log', iso(2 * H), JSON.parse(admitted()));
    event('t-fresh', 'tool.call', iso(H));
    const now = Date.now();
    expect(taskTrace(db, 't-fresh', now, 3 * H).state).toBe('started');
  });

  it('falls back to an unknown trace when the database query throws', () => {
    db.exec('DROP TABLE tasks');
    expect(taskTrace(db, 't-anything')).toMatchObject({ task_id: null, state: 'unknown' });
  });

  it('TRACE_STATES lists every state taskTrace can return', () => {
    const states: TraceState[] = ['prepared', 'admitted', 'started', 'interrupted', 'resumed', 'completed', 'failed', 'cancelled', 'unknown'];
    expect(TRACE_STATES).toEqual(states);
  });
});
