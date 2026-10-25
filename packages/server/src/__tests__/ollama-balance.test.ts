import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOllamaAccountUsage, parseOllamaBalance, parseOllamaUsage, resetOllamaBalanceCache, type OllamaAccountUsage } from '../services/ollama-balance';
import { usageAccounts } from '../services/usage-accounts';
import { createUsageRoutes } from '../routes/usage';
import { errorHandler } from '../middleware/error-handler';
import { installOutboundGuard } from '../utils/outbound-guard';

// Fixtures: the response examples on https://docs.ollama.com/api/balance and https://docs.ollama.com/api/cloud-usage (read 2026-10-25).
const LEGACY = { included: { session: { remaining_percent: 0, resets_at: '2026-10-25T15:00:00Z' }, weekly: { remaining_percent: 10.3, resets_at: '2026-10-27T00:00:00Z' } },
  purchased: { balance_usd: 15.31 } };
const MODERN = { included: { balance_usd: 72.5, allowance_usd: 100, period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' } }, purchased: { balance_usd: 25 } };
const USAGE_7D = { range: '7d', scope: 'self', granularity: 'day', from: '2026-10-18T00:00:00Z', until: '2026-10-25T12:00:00Z',
  totals: { request_count: 6612, usage_usd: 3.99, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, buckets: [] };
const KEY = ['fixture', 'bearer', 'value'].join('-'); // built at runtime so secret scanners do not match a fake key
const NOW = Date.parse('2026-10-25T12:00:00Z');

const jsonRes = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
function fakeFetch(routes: Record<string, () => Promise<Response> | Response>) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const u = new URL(String(input));
    expect(u.hostname).toBe('ollama.com');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const r = routes[u.pathname];
    if (!r) throw new Error(`unexpected ${u.pathname}`);
    return r();
  });
}
const on = { OLLAMA_BALANCE_MODE: 'on', SOCIAL_COMPAT_API_KEY: KEY } as NodeJS.ProcessEnv;

beforeEach(() => resetOllamaBalanceCache());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('parseOllamaBalance', () => {
  it('legacy plan: remaining_percent → used_pct, resets_at kept, purchased credits', () => {
    expect(parseOllamaBalance(LEGACY)).toEqual({ session: { used_pct: 100, resets_at: '2026-10-25T15:00:00Z' }, weekly: { used_pct: 89.7, resets_at: '2026-10-27T00:00:00Z' },
      credits: { balance_usd: 15.31 } });
  });
  it('modern plan: no session/weekly (null, not 0), included credits only as returned', () => {
    expect(parseOllamaBalance(MODERN)).toEqual({ session: null, weekly: null,
      credits: { balance_usd: 25, included_balance_usd: 72.5, included_allowance_usd: 100, included_period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' } } });
  });
  it('missing or malformed fields are null, never 0', () => {
    expect(parseOllamaBalance({})).toEqual({ session: null, weekly: null, credits: null });
    expect(parseOllamaBalance({ included: { session: { remaining_percent: 'x' }, weekly: { remaining_percent: 140 } }, purchased: {} }))
      .toEqual({ session: null, weekly: null, credits: null });
    expect(parseOllamaBalance({ included: { weekly: { remaining_percent: 50 } } }).weekly).toEqual({ used_pct: 50, resets_at: null });
    expect(() => parseOllamaBalance(null)).toThrow(/unexpected/);
    expect(() => parseOllamaBalance([1])).toThrow(/unexpected/);
  });
});

describe('parseOllamaUsage', () => {
  it('reads the account 7 d totals; missing totals → null', () => {
    expect(parseOllamaUsage(USAGE_7D)).toEqual({ request_count: 6612, usage_value_usd: 3.99, from: '2026-10-18T00:00:00Z', until: '2026-10-25T12:00:00Z' });
    expect(parseOllamaUsage({ range: '7d' })).toBeNull();
    expect(parseOllamaUsage({ totals: { request_count: -1 } })).toEqual({ request_count: null, usage_value_usd: null, from: null, until: null });
  });
});

describe('fetchOllamaAccountUsage', () => {
  it('mode off (default): no outbound call, null fields with a reason', async () => {
    const f = vi.fn();
    const u = await fetchOllamaAccountUsage({ env: { SOCIAL_COMPAT_API_KEY: KEY }, fetchImpl: f as never, now: NOW });
    expect(f).not.toHaveBeenCalled();
    expect(u).toMatchObject({ source: 'ollama_balance_api', mode: 'off', fetched_at: null, session: null, weekly: null, credits: null, week: null });
    expect(u.error).toMatch(/OLLAMA_BALANCE_MODE/);
  });
  it('no key: no call, null with a reason naming the env var (never its value)', async () => {
    const f = vi.fn();
    const u = await fetchOllamaAccountUsage({ env: { OLLAMA_BALANCE_MODE: 'on', OLLAMA_ACCOUNT_KEY_ENV: 'MY_OLLAMA_KEY' }, fetchImpl: f as never, now: NOW });
    expect(f).not.toHaveBeenCalled();
    expect(u).toMatchObject({ mode: 'on', session: null, weekly: null, credits: null, week: null });
    expect(u.error).toMatch(/MY_OLLAMA_KEY/);
  });
  it('on: fetches balance + usage with the key from OLLAMA_ACCOUNT_KEY_ENV, caches 5 min', async () => {
    const f = fakeFetch({ '/api/balance': () => jsonRes(LEGACY), '/api/usage': () => jsonRes(USAGE_7D) });
    const env = { OLLAMA_BALANCE_MODE: 'on', OLLAMA_ACCOUNT_KEY_ENV: 'K2', K2: KEY } as NodeJS.ProcessEnv;
    const u = await fetchOllamaAccountUsage({ env, fetchImpl: f as never, now: NOW });
    expect(u).toMatchObject({ mode: 'on', fetched_at: new Date(NOW).toISOString(), session: { used_pct: 100 }, weekly: { used_pct: 89.7 }, credits: { balance_usd: 15.31 },
      week: { request_count: 6612 } });
    expect(u.error).toBeUndefined();
    expect(String(f.mock.calls.find((c) => String(c[0]).includes('/api/usage'))![0])).toMatch(/range=7d/);
    await fetchOllamaAccountUsage({ env, fetchImpl: f as never, now: NOW + 4 * 60_000 });
    expect(f).toHaveBeenCalledTimes(2); // cached
    await fetchOllamaAccountUsage({ env, fetchImpl: f as never, now: NOW + 6 * 60_000 });
    expect(f).toHaveBeenCalledTimes(4);
  });
  it('HTTP error: fields null with the status, never 0; the other endpoint still counts', async () => {
    const f = fakeFetch({ '/api/balance': () => jsonRes({ error: 'unavailable' }, 503), '/api/usage': () => jsonRes(USAGE_7D) });
    const u = await fetchOllamaAccountUsage({ env: on, fetchImpl: f as never, now: NOW });
    expect(u).toMatchObject({ session: null, weekly: null, credits: null, week: { request_count: 6612 } });
    expect(u.error).toMatch(/balance: HTTP 503/);
  });
  it('timeout: aborted after timeoutMs, null with reason', async () => {
    const hang = (init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const f = vi.fn(async (_i: unknown, init?: RequestInit) => hang(init));
    const u = await fetchOllamaAccountUsage({ env: on, fetchImpl: f as never, now: NOW, timeoutMs: 20 });
    expect(u).toMatchObject({ session: null, weekly: null, credits: null, week: null });
    expect(u.error).toMatch(/balance: timeout/);
    expect(u.error).toMatch(/usage: timeout/);
  });
  it('the key never appears in the result, even when an error message echoes it', async () => {
    const log = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn'); const err = vi.spyOn(console, 'error');
    const f = vi.fn(async () => { throw new Error(`bad header Bearer ${KEY}`); });
    const u = await fetchOllamaAccountUsage({ env: on, fetchImpl: f as never, now: NOW });
    expect(JSON.stringify(u)).not.toContain(KEY);
    expect(u.error).toMatch(/\[redacted\]/);
    for (const spy of [log, warn, err]) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
  });
  it('passes the outbound guard: a denied ollama.com is refused, not bypassed', async () => {
    const original = globalThis.fetch;
    const inner = vi.fn(async () => jsonRes(LEGACY));
    vi.stubGlobal('fetch', inner);
    try {
      installOutboundGuard({ OUTBOUND_DENY_HOSTS: 'ollama.com' }, () => undefined);
      const u = await fetchOllamaAccountUsage({ env: on, now: NOW }); // default fetch = globalThis.fetch at call time
      expect(inner).not.toHaveBeenCalled();
      expect(u.error).toMatch(/outbound guard/);
    } finally { globalThis.fetch = original; }
  });
});

describe('usageAccounts with account usage', () => {
  const noLimits = { limits: [], invalid: 0, account_plan: {}, source: 'test', error: null };
  const legacyLimits = {
    limits: (['session', 'weekly'] as const).map((window) => ({ account: 'ollama_cloud' as const, plan: 'Legacy Max', window, unit: 'unknown' as const, limit: null,
      limit_text: 'not published', source_url: null, checked_at: null, confidence: null, note: null, exceed_behaviour: null })),
    invalid: 0, account_plan: { ollama_cloud: 'Legacy Max' }, source: 'test', error: null };
  const d = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE llm_model_calls (consumer TEXT, model TEXT, provider TEXT, ok INTEGER, tokens_in INTEGER, tokens_out INTEGER, status TEXT, purpose TEXT,
        cost_basis TEXT, list_price_cost REAL, created_at TEXT);
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT);
      CREATE TABLE worker_leases (id TEXT, loop_run_id TEXT, role TEXT, runtime TEXT, status TEXT, metadata TEXT, created_at TEXT);
      CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    db.prepare(`INSERT INTO llm_model_calls VALUES ('panel', 'kimi-k3:cloud', 'ollama', 1, 10, 5, 'ok', 'panel:review', null, null, ?)`).run(new Date(NOW - 3_600_000).toISOString());
    db.prepare(`INSERT INTO worker_leases VALUES ('l1', 'r', 'maker', 'opencode', 'completed', '{"model":"ollama/kimi-k3"}', ?)`).run(new Date(NOW - 3_600_000).toISOString());
    return db;
  };
  const au = (o: Partial<OllamaAccountUsage>): OllamaAccountUsage => ({ source: 'ollama_balance_api', mode: 'on', fetched_at: new Date(NOW).toISOString(),
    session: null, weekly: null, credits: null, week: null, ...o });

  it('labels the ledger numbers as Djimitflo share and counts lease sessions apart', () => {
    const o = usageAccounts(d(), { now: NOW, planLimits: noLimits }).accounts.find((a) => a.id === 'ollama_cloud')!;
    expect(o.scope).toBe('djimitflo_ledger');
    expect(o.windows['5h'].calls).toBe(2);
    expect(o.lease_sessions['5h']).toBe(1);
    expect(o.account_usage).toMatchObject({ source: 'ollama_balance_api', session: null, weekly: null, credits: null });
    expect(o.account_usage!.error).toBeTruthy();
    expect(usageAccounts(d(), { now: NOW, planLimits: noLimits }).accounts.find((a) => a.id === 'claude_max')!.account_usage).toBeUndefined();
  });
  it('fills used_pct of the session/weekly rows from the API percent and sets limit_reached at ≥ 100 %', () => {
    const r = usageAccounts(d(), { now: NOW, planLimits: legacyLimits,
      ollamaAccountUsage: au({ session: { used_pct: 100, resets_at: '2026-10-25T15:00:00Z' }, weekly: { used_pct: 89.7, resets_at: '2026-10-27T00:00:00Z' }, credits: { balance_usd: 15.31 } }) });
    const o = r.accounts.find((a) => a.id === 'ollama_cloud')!;
    const weekly = o.limits.find((l) => l.window === 'weekly')!;
    expect(weekly).toMatchObject({ comparable: true, used_pct: 89.7, pct_source: 'ollama_balance_api', resets_at: '2026-10-27T00:00:00Z' });
    expect(o.state).toMatchObject({ state: 'limit_reached', until: '2026-10-25T15:00:00Z' });
    expect(o.state.reason).toMatch(/session 100 %/);
    expect(o.state.reason).toMatch(/15\.31/);
  });
  it('below 100 % keeps the existing state; no API percent leaves the rows uncompared', () => {
    const below = usageAccounts(d(), { now: NOW, planLimits: legacyLimits, ollamaAccountUsage: au({ session: { used_pct: 99.9, resets_at: null }, weekly: { used_pct: 10, resets_at: null } }) });
    expect(below.accounts.find((a) => a.id === 'ollama_cloud')!.state.state).toBe('no_limit_recorded');
    const none = usageAccounts(d(), { now: NOW, planLimits: legacyLimits, ollamaAccountUsage: au({}) }).accounts.find((a) => a.id === 'ollama_cloud')!;
    expect(none.limits.every((l) => l.comparable === false && l.used_pct === null && l.pct_source === undefined)).toBe(true);
  });
  it('route: mode off makes no outbound call and still returns the scope label and the reason', async () => {
    const f = vi.fn(async () => jsonRes(LEGACY));
    vi.stubGlobal('fetch', f);
    const prev = process.env.OLLAMA_BALANCE_MODE; delete process.env.OLLAMA_BALANCE_MODE;
    try {
      const auth = { requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() } as never;
      const res = await request(express().use('/usage', createUsageRoutes(d(), auth)).use(errorHandler)).get('/usage/accounts');
      expect(res.status).toBe(200);
      const o = res.body.accounts.find((a: { id: string }) => a.id === 'ollama_cloud');
      expect(o.scope).toBe('djimitflo_ledger');
      expect(o.account_usage).toMatchObject({ mode: 'off', session: null, weekly: null, credits: null });
      expect(f).not.toHaveBeenCalled();
    } finally { if (prev !== undefined) process.env.OLLAMA_BALANCE_MODE = prev; }
  });
  it('route: an injected account-usage source is shown and never leaks the key', async () => {
    const auth = { requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() } as never;
    const f = fakeFetch({ '/api/balance': () => jsonRes(LEGACY), '/api/usage': () => jsonRes(USAGE_7D) });
    const app = express().use('/usage', createUsageRoutes(d(), auth, { ollamaAccountUsage: () => fetchOllamaAccountUsage({ env: on, fetchImpl: f as never, now: NOW }) })).use(errorHandler);
    const res = await request(app).get('/usage/accounts');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(KEY);
    const o = res.body.accounts.find((a: { id: string }) => a.id === 'ollama_cloud');
    expect(o.account_usage).toMatchObject({ weekly: { used_pct: 89.7 }, credits: { balance_usd: 15.31 }, week: { request_count: 6612 } });
    expect(o.state.state).toBe('limit_reached');
  });
});
