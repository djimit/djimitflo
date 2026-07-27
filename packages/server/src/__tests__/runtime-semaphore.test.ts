import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { runtimeAdmissionLimit, runtimeAdmissionSnapshot } from '../services/runtime-admission';
import { ExecutionEngine } from '../execution/execution-engine';

/**
 * P2 RuntimeSemaphore — deterministic proof that executeRuntimeCommand's
 * chokepoint bounds live runtime children to the configured concurrency, that
 * over-limit acquisitions queue (and are admitted on release), and that a
 * queued lease can be cancelled (the stop-while-waiting path). The semaphore is
 * now owned by RuntimeCommandService (accessed via loops.runtimeCommand).
 */

let loops: LoopService;

function resetSemaphore(): void {
  if (!loops) return; // beforeEach hasn't run yet
  const snapshot = runtimeAdmissionSnapshot();
  for (const id of snapshot.queued) (loops.runtimeCommand as any).cancelRuntimePermit(id);
  for (const id of snapshot.active) (loops.runtimeCommand as any).releaseRuntimePermit(id);
}

describe('RuntimeSemaphore (P2 bounded concurrency)', () => {
  let db: Database.Database;
  const previousConcurrency = process.env.RUNTIME_MAX_CONCURRENCY;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    loops = new LoopService(db);
    resetSemaphore();
  });

  afterEach(() => {
    resetSemaphore();
    db.close();
    if (previousConcurrency === undefined) delete process.env.RUNTIME_MAX_CONCURRENCY;
    else process.env.RUNTIME_MAX_CONCURRENCY = previousConcurrency;
  });

  it('admits up to the limit and queues the rest until a slot frees', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '2';
    expect(runtimeAdmissionLimit()).toBe(2);

    await (loops.runtimeCommand as any).acquireRuntimePermit('a');
    await (loops.runtimeCommand as any).acquireRuntimePermit('b');
    expect(loops.runtimeConcurrencyInUse()).toBe(2);

    let thirdAdmitted = false;
    const third = (loops.runtimeCommand as any).acquireRuntimePermit('c').then(() => { thirdAdmitted = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(loops.runtimeConcurrencyInUse()).toBe(2);
    expect(runtimeAdmissionSnapshot().queued).toEqual(['c']);

    (loops.runtimeCommand as any).releaseRuntimePermit('a');
    await third;
    expect(thirdAdmitted).toBe(true);
    expect(loops.runtimeConcurrencyInUse()).toBe(2);

    (loops.runtimeCommand as any).releaseRuntimePermit('b');
    (loops.runtimeCommand as any).releaseRuntimePermit('c');
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });

  it('a queued lease stopped before spawning is cancelled, not admitted', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '1';
    await (loops.runtimeCommand as any).acquireRuntimePermit('a');
    expect(loops.runtimeConcurrencyInUse()).toBe(1);

    expect(runtimeAdmissionSnapshot().active).toHaveLength(1);
    expect(runtimeAdmissionSnapshot().queued).toHaveLength(0);
    const queued = (loops.runtimeCommand as any).acquireRuntimePermit('b');
    expect(runtimeAdmissionSnapshot().active).toHaveLength(1);
    expect(runtimeAdmissionSnapshot().queued).toEqual(['b']);

    (loops.runtimeCommand as any).cancelRuntimePermit('b');
    await expect(queued).rejects.toThrow(/RUNTIME_PERMIT_CANCELLED/);
    expect(runtimeAdmissionSnapshot().queued).toEqual([]);
    expect(loops.runtimeConcurrencyInUse()).toBe(1);

    (loops.runtimeCommand as any).releaseRuntimePermit('a');
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });

  it('release is idempotent and safe to call on every exit path', () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '4';
    expect(() => (loops.runtimeCommand as any).releaseRuntimePermit('never-acquired')).not.toThrow();
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });

  it('shares the same admission limit with task execution', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '1';
    await (loops.runtimeCommand as any).acquireRuntimePermit('loop-worker');
    const engine = new ExecutionEngine(db, {
      broadcastTaskEvent: () => undefined,
      broadcastTaskEventById: () => undefined,
      broadcastExecutionEvent: () => undefined,
    } as any);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, risk_level, execution_mode,
        tags, metadata, created_at, updated_at
      ) VALUES ('task-shared-admission', 'shared admission', 'run mock task', 'pending',
        'low', 'low', 'local', '[]', '{}', ?, ?)
    `).run(now, now);

    let admitted = false;
    const execution = engine.executeTask('task-shared-admission', 'mock').then((result) => {
      admitted = true;
      return result;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(runtimeAdmissionSnapshot()).toMatchObject({
      active: ['loop-worker'],
      queued: ['task:task-shared-admission'],
    });

    (loops.runtimeCommand as any).releaseRuntimePermit('loop-worker');
    await expect(execution).resolves.toMatchObject({ status: 'started' });
  });
});
