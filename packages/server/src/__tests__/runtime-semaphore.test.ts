import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencySemaphore } from '../services/concurrency-semaphore';

/**
 * Deterministic proof for the shared runtime concurrency primitive.
 */

describe('RuntimeSemaphore (P2 bounded concurrency)', () => {
  const previousConcurrency = process.env.RUNTIME_MAX_CONCURRENCY;

  afterEach(() => {
    if (previousConcurrency === undefined) delete process.env.RUNTIME_MAX_CONCURRENCY;
    else process.env.RUNTIME_MAX_CONCURRENCY = previousConcurrency;
  });

  it('admits up to the limit and queues the rest until a slot frees', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '2';
    const semaphore = new ConcurrencySemaphore(() => 2);

    await semaphore.acquire('a');
    await semaphore.acquire('b');
    expect(semaphore.activeCount).toBe(2);

    let thirdAdmitted = false;
    const third = semaphore.acquire('c').then(() => { thirdAdmitted = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(semaphore.activeCount).toBe(2);

    semaphore.release('a');
    await third;
    expect(thirdAdmitted).toBe(true);
    expect(semaphore.activeCount).toBe(2);

    semaphore.release('b');
    semaphore.release('c');
    expect(semaphore.activeCount).toBe(0);
  });

  it('a queued lease stopped before spawning is cancelled, not admitted', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '1';
    const semaphore = new ConcurrencySemaphore(() => 1);
    await semaphore.acquire('a');
    expect(semaphore.activeCount).toBe(1);

    const queued = semaphore.acquire('b');

    semaphore.cancel('b');
    await expect(queued).rejects.toThrow(/RUNTIME_PERMIT_CANCELLED/);
    expect(semaphore.activeCount).toBe(1);

    semaphore.release('a');
    expect(semaphore.activeCount).toBe(0);
  });

  it('release is idempotent and safe to call on every exit path', () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '4';
    const semaphore = new ConcurrencySemaphore(() => 4);
    expect(() => semaphore.release('never-acquired')).not.toThrow();
    expect(semaphore.activeCount).toBe(0);
  });
});
