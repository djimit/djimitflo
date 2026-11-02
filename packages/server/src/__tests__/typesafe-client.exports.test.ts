import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TypeSafeClient,
  typesafeBusy,
  resetTypesafeBreaker,
  resetTypesafeLimiter,
} from '../services/typesafe-client';

describe('typesafeBusy', () => {
  beforeEach(() => {
    resetTypesafeBreaker();
    resetTypesafeLimiter();
    process.env.TYPESAFE_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_MAX_CONCURRENCY;
  });

  it('returns false when breaker is closed and no calls are queued', () => {
    expect(typesafeBusy()).toBe(false);
  });

  it('returns true when the breaker opens after 3 consecutive failures', async () => {
    const failFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    const client = new TypeSafeClient(failFetch);
    for (let i = 0; i < 3; i += 1) {
      await expect(client.systemOne({}, {}, { retries: 0 })).rejects.toThrow('TYPESAFE_FAILED');
    }
    expect(typesafeBusy()).toBe(true);
  });

  it('returns false again after the breaker is reset', async () => {
    const failFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    const client = new TypeSafeClient(failFetch);
    for (let i = 0; i < 3; i += 1) {
      await expect(client.systemOne({}, {}, { retries: 0 })).rejects.toThrow();
    }
    expect(typesafeBusy()).toBe(true);
    resetTypesafeBreaker();
    expect(typesafeBusy()).toBe(false);
  });

  it('returns true when calls are waiting in the concurrency queue', async () => {
    process.env.TYPESAFE_MAX_CONCURRENCY = '1';
    const hangingFetch = vi.fn().mockImplementation(() => new Promise(() => {})) as unknown as typeof fetch;
    const client = new TypeSafeClient(hangingFetch);
    // First call acquires the only slot and hangs in fetch; second call queues.
    const first = client.systemOne({}, {}, { retries: 0 });
    const second = client.systemOne({}, {}, { retries: 0 });
    expect(typesafeBusy()).toBe(true);
    // Cleanup: reset limiter so module state does not leak into other tests.
    resetTypesafeLimiter();
    void first;
    void second;
  });

  it('returns false after the limiter is reset following queued calls', async () => {
    process.env.TYPESAFE_MAX_CONCURRENCY = '1';
    const hangingFetch = vi.fn().mockImplementation(() => new Promise(() => {})) as unknown as typeof fetch;
    const client = new TypeSafeClient(hangingFetch);
    client.systemOne({}, {}, { retries: 0 });
    client.systemOne({}, {}, { retries: 0 });
    expect(typesafeBusy()).toBe(true);
    resetTypesafeLimiter();
    expect(typesafeBusy()).toBe(false);
  });
});