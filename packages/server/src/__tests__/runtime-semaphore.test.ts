import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * P2 RuntimeSemaphore — deterministic proof that executeRuntimeCommand's
 * chokepoint bounds live runtime children to the configured concurrency, that
 * over-limit acquisitions queue (and are admitted on release), and that a
 * queued lease can be cancelled (the stop-while-waiting path). The semaphore is
 * a private static field on LoopService; we drive it via the same private
 * helpers executeRuntimeCommand uses, and fully reset it before/after so the
 * shared static state never leaks into other test files in the same worker.
 */

interface SemState {
  active: Set<string>;
  queue: Array<{ leaseId: string; resolve: () => void; reject: (err: Error) => void }>;
}

function semState(): SemState {
  return (LoopService as any).runtimeSemaphore;
}

function resetSemaphore(): void {
  const sem = semState();
  for (const waiter of sem.queue) {
    try { waiter.reject(new Error('test reset')); } catch { /* ignore */ }
  }
  sem.queue.length = 0;
  sem.active.clear();
}

describe('RuntimeSemaphore (P2 bounded concurrency)', () => {
  let db: Database.Database;
  let loops: LoopService;
  const previousConcurrency = process.env.RUNTIME_MAX_CONCURRENCY;

  beforeEach(() => {
    resetSemaphore();
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    loops = new LoopService(db);
  });

  afterEach(() => {
    resetSemaphore();
    db.close();
    if (previousConcurrency === undefined) delete process.env.RUNTIME_MAX_CONCURRENCY;
    else process.env.RUNTIME_MAX_CONCURRENCY = previousConcurrency;
  });

  it('admits up to the limit and queues the rest until a slot frees', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '2';
    expect((loops as any).runtimeSemaphoreLimit()).toBe(2);

    await (loops as any).acquireRuntimePermit('a');
    await (loops as any).acquireRuntimePermit('b');
    expect(loops.runtimeConcurrencyInUse()).toBe(2);

    let thirdAdmitted = false;
    const third = (loops as any).acquireRuntimePermit('c').then(() => { thirdAdmitted = true; });
    // Let pending microtasks flush; the third must still be queued.
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(loops.runtimeConcurrencyInUse()).toBe(2);
    expect(semState().queue.map((w) => w.leaseId)).toEqual(['c']);

    (loops as any).releaseRuntimePermit('a');
    await third;
    expect(thirdAdmitted).toBe(true);
    expect(loops.runtimeConcurrencyInUse()).toBe(2); // b + c

    (loops as any).releaseRuntimePermit('b');
    (loops as any).releaseRuntimePermit('c');
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });

  it('a queued lease stopped before spawning is cancelled, not admitted', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '1';
    await (loops as any).acquireRuntimePermit('a');
    expect(loops.runtimeConcurrencyInUse()).toBe(1);

    const queued = (loops as any).acquireRuntimePermit('b');
    await Promise.resolve();
    expect(semState().queue.map((w) => w.leaseId)).toEqual(['b']);

    // Stop the queued lease (the path stopWorkerLeaseRuntime takes when there is
    // no live process handle): the queued waiter must reject, and the active slot
    // is NOT freed (the lease never held one).
    (loops as any).cancelRuntimePermit('b');
    await expect(queued).rejects.toThrow(/RUNTIME_PERMIT_CANCELLED/);
    expect(semState().queue.map((w) => w.leaseId)).toEqual([]);
    expect(loops.runtimeConcurrencyInUse()).toBe(1);

    (loops as any).releaseRuntimePermit('a');
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });

  it('release is idempotent and safe to call on every exit path', () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '4';
    // Releasing a lease that never acquired must not throw or corrupt state.
    expect(() => (loops as any).releaseRuntimePermit('never-acquired')).not.toThrow();
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });
});