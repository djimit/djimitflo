import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker, resetTypesafeLimiter } from '../services/typesafe-client';
import { setLlmLedger } from '../services/model-selector';
import { runJudgment } from '../services/judgment-service';
import { proposalPrescreen } from '../services/judgments/proposal-prescreen';

const Q = { q: { type: 'noul', instructions: 'x?' } } as never;
const okBody = { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } };
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); setLlmLedger(db);
  vi.stubEnv('TYPESAFE_API_KEY', 'k'); resetTypesafeBreaker(); resetTypesafeLimiter();
});
afterEach(() => { vi.unstubAllEnvs(); setLlmLedger(null); resetTypesafeLimiter(); db.close(); });
const rows = () => db.prepare("SELECT ok, status, attempts FROM llm_model_calls WHERE consumer = 'jev' ORDER BY id").all();

/** A fetch that takes `ms` and honours the abort signal, counting how many requests are in flight at once. */
function slowFetch(ms: number) {
  let inFlight = 0; let peak = 0;
  const f = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((resolve, reject) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    const t = setTimeout(() => { inFlight -= 1; resolve({ ok: true, status: 200, json: async () => okBody }); }, ms);
    init.signal.addEventListener('abort', () => { clearTimeout(t); inFlight -= 1; reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })); });
  }));
  return { f: f as unknown as typeof fetch, peak: () => peak };
}

it('B8-JEV: 50 simultaneous calls run at most TYPESAFE_MAX_CONCURRENCY at a time and all complete', async () => {
  vi.stubEnv('TYPESAFE_MAX_CONCURRENCY', '6');
  const { f, peak } = slowFetch(5);
  const c = new TypeSafeClient(f);
  const out = await Promise.all(Array.from({ length: 50 }, () => c.systemOne({ a: 1 }, Q, { retries: 0 })));
  expect(out).toHaveLength(50);
  expect(peak()).toBeLessThanOrEqual(6);
  expect(rows()).toHaveLength(50);
});

it('B8-JEV: the timeout starts when the request starts, not when it was queued', async () => {
  vi.stubEnv('TYPESAFE_MAX_CONCURRENCY', '2');
  const { f } = slowFetch(30);
  const c = new TypeSafeClient(f);
  // 10 calls × 30 ms through 2 slots ≈ 150 ms of queueing, but each request itself takes 30 ms < 80 ms timeout
  const out = await Promise.all(Array.from({ length: 10 }, () => c.systemOne({ a: 1 }, Q, { retries: 0, timeoutMs: 80 })));
  expect(out).toHaveLength(10);
  expect(rows().every((r) => (r as { ok: number }).ok === 1)).toBe(true);
});

it('B8-JEV: a full queue fails fast with queue_full (recorded), never hangs', async () => {
  vi.stubEnv('TYPESAFE_MAX_CONCURRENCY', '1'); vi.stubEnv('TYPESAFE_MAX_QUEUE', '2');
  const { f } = slowFetch(20);
  const c = new TypeSafeClient(f);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => c.systemOne({ a: 1 }, Q, { retries: 0 })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3); // 1 running + 2 queued
  expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual(['Error: TYPESAFE_QUEUE_FULL', 'Error: TYPESAFE_QUEUE_FULL']);
  expect(rows().filter((r) => (r as { status: string }).status === 'queue_full')).toHaveLength(2);
});

it('B8-JEV: one ledger row per call with the final outcome and the number of attempts', async () => {
  const f = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => okBody });
  await new TypeSafeClient(f as unknown as typeof fetch).systemOne({ a: 1 }, Q, { retries: 2 });
  expect(rows()).toEqual([{ ok: 1, status: 'ok', attempts: 3 }]);
}, 10_000);

it('B8-JEV: a timeout is recorded as status timeout; an open breaker is recorded as breaker_open', async () => {
  const { f } = slowFetch(100);
  const c = new TypeSafeClient(f);
  for (let i = 0; i < 3; i += 1) await expect(c.systemOne({ a: 1 }, Q, { retries: 0, timeoutMs: 10 })).rejects.toThrow();
  await expect(c.systemOne({ a: 1 }, Q, { retries: 0 })).rejects.toThrow('TYPESAFE_BREAKER_OPEN');
  expect(rows()).toEqual([
    { ok: 0, status: 'timeout', attempts: 1 }, { ok: 0, status: 'timeout', attempts: 1 }, { ok: 0, status: 'timeout', attempts: 1 },
    { ok: 0, status: 'breaker_open', attempts: 0 },
  ]);
});

it('B8-JEV: shadow judgments do not retry; enforce judgments keep their retries', async () => {
  const failing = () => vi.fn().mockResolvedValue({ ok: false, status: 503 });
  vi.stubEnv('TYPESAFE_PROPOSAL_PRESCREEN_MODE', 'shadow');
  const shadowFetch = failing();
  expect(await runJudgment(db, proposalPrescreen, { type: 't', id: 's1' }, {}, new TypeSafeClient(shadowFetch as unknown as typeof fetch))).toBeNull();
  expect(shadowFetch).toHaveBeenCalledTimes(1);
  resetTypesafeBreaker();
  vi.stubEnv('TYPESAFE_PROPOSAL_PRESCREEN_MODE', 'enforce');
  const enforceFetch = failing();
  expect(await runJudgment(db, proposalPrescreen, { type: 't', id: 'e1' }, {}, new TypeSafeClient(enforceFetch as unknown as typeof fetch))).toBeNull();
  expect(enforceFetch).toHaveBeenCalledTimes(3);
}, 10_000);
