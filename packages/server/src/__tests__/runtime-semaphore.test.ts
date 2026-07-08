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
 * now owned by RuntimeCommandService (accessed via loops.runtimeCommand).
 */

interface SemState {
  active: Set<string>;
  queue: Array<{ leaseId: string; resolve: () => void; reject: (err: Error) => void }>;
}

let loops: LoopService;

function semState(): SemState {
  // runtimeSemaphore is a private static on RuntimeCommandService
  return (loops.runtimeCommand.constructor as any).runtimeSemaphore;
}

function resetSemaphore(): void {
  if (!loops) return; // beforeEach hasn't run yet
  const sem = semState();
  if (!sem) return;
  for (const waiter of sem.queue) {
    try { waiter.reject(new Error('test reset')); } catch { /* ignore */ }
  }
  sem.queue.length = 0;
  sem.active.clear();
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
    expect((loops.runtimeCommand as any).runtimeSemaphoreLimit()).toBe(2);

    await (loops.runtimeCommand as any).acquireRuntimePermit('a');
    await (loops.runtimeCommand as any).acquireRuntimePermit('b');
    expect(loops.runtimeConcurrencyInUse()).toBe(2);

    let thirdAdmitted = false;
    const third = (loops.runtimeCommand as any).acquireRuntimePermit('c').then(() => { thirdAdmitted = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(loops.runtimeConcurrencyInUse()).toBe(2);
    expect(semState().queue.map((w) => w.leaseId)).toEqual(['c']);

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

    expect(semState().active.size).toBe(1);
    expect(semState().queue.length).toBe(0);
    const queued = (loops.runtimeCommand as any).acquireRuntimePermit('b');
    expect(semState().active.size).toBe(1);
    expect(semState().queue.length).toBe(1);
    expect(semState().queue.map((w) => w.leaseId)).toEqual(['b']);

    (loops.runtimeCommand as any).cancelRuntimePermit('b');
    await expect(queued).rejects.toThrow(/RUNTIME_PERMIT_CANCELLED/);
    expect(semState().queue.map((w) => w.leaseId)).toEqual([]);
    expect(loops.runtimeConcurrencyInUse()).toBe(1);

    (loops.runtimeCommand as any).releaseRuntimePermit('a');
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });

  it('release is idempotent and safe to call on every exit path', () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '4';
    expect(() => (loops.runtimeCommand as any).releaseRuntimePermit('never-acquired')).not.toThrow();
    expect(loops.runtimeConcurrencyInUse()).toBe(0);
  });
});
