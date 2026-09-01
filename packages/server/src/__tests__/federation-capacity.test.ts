import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { createFederationRoutes } from '../routes/federation';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';

describe('federation work capacity', () => {
  afterEach(() => {
    runtimeConcurrencySemaphore.release('federation-test');
    delete process.env.RUNTIME_MAX_CONCURRENCY;
  });

  it('rejects offered work when shared runtime capacity is exhausted', async () => {
    process.env.RUNTIME_MAX_CONCURRENCY = '1';
    await runtimeConcurrencySemaphore.acquire('federation-test');
    const db = createTestDb();
    const router = createFederationRoutes(db, { requireAuth: (_req: any, _res: any, next: any) => next() } as any);
    const layer = router.stack.find((entry: any) => entry.route?.path === '/work');
    const handler = layer.route.stack.at(-1).handle;
    const json = vi.fn();

    handler({ body: { goal_objective: 'Do bounded work' } }, { json }, vi.fn());

    expect(json).toHaveBeenCalledWith({
      accepted: false,
      reason: 'capacity exhausted',
      capacity: { active: 1, limit: 1 },
    });
    db.close();
  });
});
