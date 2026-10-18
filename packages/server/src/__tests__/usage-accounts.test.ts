import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { accountOfCall, accountOfLease, limitView, loadPlanLimits, parsePlanLimits, PLAN_LIMITS_PATH, usageAccounts, windowSums, type UsageRecord } from '../services/usage-accounts';
import { createUsageRoutes } from '../routes/usage';
import { errorHandler } from '../middleware/error-handler';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE llm_model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, consumer TEXT NOT NULL, model TEXT NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER,
      out_chars INTEGER, shadow INTEGER NOT NULL DEFAULT 0, agree INTEGER, provider TEXT, tokens_in INTEGER, tokens_out INTEGER, task_kind TEXT, run_id TEXT, status TEXT,
      attempts INTEGER, purpose TEXT, experiment_id TEXT, cost_basis TEXT, list_price_cost REAL, marginal_cost REAL, created_at TEXT NOT NULL);
    CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT NOT NULL);
    CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL, role TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  return d;
}
const call = (d: Database.Database, c: Record<string, unknown>) => d.prepare(`INSERT INTO llm_model_calls (consumer, model, ok, provider, tokens_in, tokens_out, status, purpose, cost_basis, list_price_cost, created_at)
  VALUES (@consumer, @model, @ok, @provider, @tokens_in, @tokens_out, @status, @purpose, @cost_basis, @list_price_cost, @created_at)`)
  .run({ ok: 1, provider: null, tokens_in: null, tokens_out: null, status: 'ok', purpose: null, cost_basis: null, list_price_cost: null, ...c });
let n = 0;
const lease = (d: Database.Database, runtime: string, meta: Record<string, unknown>, at: string, role = 'maker', status = 'completed') =>
  d.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`l${++n}`, 'run-1', role, runtime, status, JSON.stringify(meta), at);

const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
const fresh = () => { const d = db(); dbs.push(d); d.prepare("INSERT INTO loop_runs VALUES ('run-1', 'self-improvement')").run(); return d; };
const noLimits = { limits: [], invalid: 0, account_plan: {}, source: 'test', error: null };

describe('account mapping', () => {
  it('maps ledger provider/model strings to provider accounts', () => {
    expect(accountOfCall('subscription-cli:claude', 'claude-sonnet')).toBe('claude_max');
    expect(accountOfCall('subscription-cli:codex', 'gpt-6')).toBe('chatgpt_pro');
    expect(accountOfCall('free-tier-cli:opencode', 'opencode/deepseek-v4.1-flash-free')).toBe('opencode_free');
    expect(accountOfCall('typesafe', 'jev-1.13.0', 'jev')).toBe('typesafe_jev');
    expect(accountOfCall('nvidia', 'nemotron')).toBe('nvidia');
    expect(accountOfCall('openai:https://integrate.api.nvidia.com/v1', 'moonshotai/kimi-k3')).toBe('nvidia');
    expect(accountOfCall('ollama:http://100.1.2.3:11434', 'kimi-k3:cloud')).toBe('ollama_cloud');
    expect(accountOfCall('ollama', 'glm-5.3')).toBe('ollama_cloud');
    expect(accountOfCall('llama-router', 'qwen3')).toBe('local_workstation');
    expect(accountOfCall('litellm', 'gpt-x')).toBe('other');
  });
  it('maps lease runtimes; a claude/codex lease without a subscription marker is not attributed to the subscription', () => {
    expect(accountOfLease('opencode', 'ollama/kimi-k3', false)).toBe('ollama_cloud');
    expect(accountOfLease('opencode', 'opencode/x-free', false)).toBe('opencode_free');
    expect(accountOfLease('claude', null, true)).toBe('claude_max');
    expect(accountOfLease('claude', null, false)).toBe('other');
    expect(accountOfLease('codex', null, true)).toBe('chatgpt_pro');
    expect(accountOfLease('remote', null, false)).toBe('local_workstation');
    expect(accountOfLease('manual', null, false)).toBeNull();
  });
});

describe('window sums', () => {
  const rec = (h: number, tokens: number | null, mirror = false): UsageRecord => ({ account: 'ollama_cloud', at: NOW - h * 3_600_000, tokens, ok: true, consumer: 'x',
    provider: 'ollama', model: 'm', mirror, limit_hit: false, error: null, list_price_cost: null, cost_basis: null });
  it('sums per window, skips mirrors, keeps unknown tokens apart and null when all are unknown', () => {
    const s = windowSums([rec(1, 100), rec(2, null), rec(1, 999, true), rec(10, 50), rec(24 * 6, 7), rec(24 * 9, 1000)], NOW);
    expect(s['5h']).toEqual({ calls: 2, tokens: 100, calls_without_tokens: 1 });
    expect(s.today).toEqual({ calls: 3, tokens: 150, calls_without_tokens: 1 }); // 12:00Z → 10 h ago is still today
    expect(s['7d']).toEqual({ calls: 4, tokens: 157, calls_without_tokens: 1 });
    expect(s.month).toEqual({ calls: 5, tokens: 1157, calls_without_tokens: 1 }); // 9 d ago = 9 Oct, same month
    expect(windowSums([rec(1, null)], NOW)['5h'].tokens).toBeNull();
    expect(windowSums([], NOW)['5h']).toEqual({ calls: 0, tokens: 0, calls_without_tokens: 0 });
  });
});

describe('plan limits', () => {
  it('the repo seed file parses with no invalid entries and no invented numbers', () => {
    const p = loadPlanLimits(PLAN_LIMITS_PATH);
    expect(p.error).toBeNull();
    expect(p.invalid).toBe(0);
    expect(p.limits.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(PLAN_LIMITS_PATH, 'utf8')).provider_plan_limits.length).toBe(p.limits.length);
    for (const l of p.limits) {
      expect(l.limit_text.length).toBeGreaterThan(0);
      if (l.limit !== null) expect(l.source_url && l.checked_at).toBeTruthy(); // a number only with a source and a date
    }
    // operator-picked plans (18-10) must each name an existing row of that account
    for (const [account, plan] of Object.entries(p.account_plan)) {
      expect(p.limits.some((l) => l.account === account && l.plan === plan)).toBe(true);
    }
  });
  it('rejects malformed entries', () => {
    expect(parsePlanLimits({ provider_plan_limits: [{ account: 'nope', plan: 'x', window: '5h', unit: 'tokens', limit: null }, { account: 'nvidia', plan: 'x', window: 'hourly', unit: 'tokens', limit: 1 }] }))
      .toEqual({ limits: [], invalid: 2, account_plan: {} });
  });
  const sums = { '5h': { calls: 3, tokens: 500, calls_without_tokens: 1 }, today: { calls: 3, tokens: 500, calls_without_tokens: 1 },
    '7d': { calls: 4, tokens: 900, calls_without_tokens: 1 }, month: { calls: 4, tokens: 900, calls_without_tokens: 1 } };
  const base = { account: 'claude_max' as const, plan: 'Max', limit_text: 'see vendor', source_url: null, checked_at: null, confidence: null, note: null, exceed_behaviour: null };
  it('null limit: no bar, vendor text kept', () => {
    const v = limitView({ ...base, window: 'weekly', unit: 'tokens', limit: null }, sums);
    expect(v).toMatchObject({ comparable: false, used_pct: null, limit_text: 'see vendor', measured_window: '7d', used: 900 });
  });
  it('unit mismatch is labelled and never drawn as a bar', () => {
    const v = limitView({ ...base, window: '5h', unit: 'messages', limit: 200 }, sums);
    expect(v.comparable).toBe(false);
    expect(v.used_pct).toBeNull();
    expect(v.unit_note).toBe('vendor counts messages; we measure tokens — not comparable');
  });
  it('account_plan marks the configured plan active and the others as reference; session windows are labelled', () => {
    const v = limitView({ ...base, window: 'session', unit: 'unknown', limit: null }, sums, { claude_max: 'Max' });
    expect(v.active).toBe(true);
    expect(v.measured_window).toBe('5h');
    expect(v.unit_note).toMatch(/^session length not published/);
    expect(limitView({ ...base, window: 'weekly', unit: 'unknown', limit: null }, sums, { claude_max: 'Max 20x' }).active).toBe(false);
    expect(limitView({ ...base, window: 'weekly', unit: 'unknown', limit: null }, sums).active).toBeNull();
    expect(parsePlanLimits({ account_plan: { claude_max: 'Max 5x ($100/mo)', chatgpt_pro: 'unknown', bogus: 'x' } }).account_plan).toEqual({ claude_max: 'Max 5x ($100/mo)' });
  });
  it('tokens vs tokens draws a bar; requests compare with calls and a caveat', () => {
    expect(limitView({ ...base, window: '5h', unit: 'tokens', limit: 1000 }, sums)).toMatchObject({ comparable: true, used_pct: 50 });
    const r = limitView({ ...base, window: 'daily', unit: 'requests', limit: 30 }, sums);
    expect(r).toMatchObject({ comparable: true, used: 3, used_pct: 10, measured_unit: 'calls' });
    expect(r.unit_note).toMatch(/vendor counts requests; we count calls/);
  });
});

describe('usageAccounts', () => {
  it('combines ledger + leases per account without double counting the maker mirror', () => {
    const d = fresh();
    call(d, { consumer: 'panel', model: 'kimi-k3:cloud', provider: 'ollama:http://ws:11434', tokens_in: 100, tokens_out: 20, purpose: 'panel:review', cost_basis: 'flat_subscription', created_at: ago(1) });
    call(d, { consumer: 'maker', model: 'ollama/kimi-k3', provider: 'opencode', tokens_in: 5000, created_at: ago(1) }); // mirror of the lease below
    lease(d, 'opencode', { model: 'ollama/kimi-k3', token_accounting: { version: 1, total_tokens: 5000, model_id: 'ollama/kimi-k3' } }, ago(1));
    lease(d, 'opencode', { model: 'ollama/glm-5.3' }, ago(2), 'checker'); // no tokens reported
    call(d, { consumer: 'jev', model: 'jev-1', provider: 'typesafe', tokens_in: 10, list_price_cost: 0.5, cost_basis: 'metered', created_at: ago(3) });
    const r = usageAccounts(d, { now: NOW, planLimits: noLimits });
    const ollama = r.accounts.find((a) => a.id === 'ollama_cloud')!;
    expect(ollama.windows['5h']).toEqual({ calls: 3, tokens: 5120, calls_without_tokens: 1 });
    expect(ollama.consumers_7d.map((c) => c.consumer).sort()).toEqual(['lease:checker:self-improvement', 'lease:maker:self-improvement', 'panel:review']);
    expect(ollama.consumers_7d.find((c) => c.consumer === 'lease:checker:self-improvement')!.tokens).toBeNull();
    expect(ollama.state.state).toBe('no_limit_recorded');
    const jev = r.accounts.find((a) => a.id === 'typesafe_jev')!;
    expect(jev.cost).toMatchObject({ basis: 'metered', observed_bases: ['metered'], list_price_usd_month: 0.5, calls_without_list_price_month: 0 });
    expect(r.accounts.find((a) => a.id === 'claude_max')!.cost.list_price_usd_month).toBeNull(); // no calls → unknown, not $0
    expect(r.accounts.some((a) => a.id === 'other')).toBe(false);
  });
  it('limited state from inference_ollama_state, with the limit message as last limit hit', () => {
    const d = fresh();
    d.prepare('INSERT INTO system_state VALUES (?, ?, ?)').run('inference_ollama_state', JSON.stringify({ state: 'ollama_limited', detected_at: ago(2), error_class: 'weekly',
      source: 'panel', excerpt: 'reached your weekly usage limit' }), ago(2));
    call(d, { consumer: 'panel', model: 'kimi-k3:cloud', provider: 'ollama', ok: 0, status: 'you have reached your weekly usage limit, add usage credits', created_at: ago(2) });
    const o = usageAccounts(d, { now: NOW, planLimits: noLimits }).accounts.find((a) => a.id === 'ollama_cloud')!;
    expect(o.state).toMatchObject({ state: 'limited', since: ago(2), until: null });
    expect(o.state.reason).toMatch(/weekly usage limit/);
    expect(o.last_limit_hit?.message).toMatch(/weekly usage limit/);
    expect(o.last_error?.at).toBe(ago(2));
  });
  it('subscription backoff from a gym limit hit (mirror row counts as limit evidence, not as a call)', () => {
    const d = fresh();
    call(d, { consumer: 'evolution_gym', model: 'claude-cli', provider: 'subscription-cli:claude', ok: 0, status: 'subscription_limit', purpose: 'evolution_gym:subscription_maker', created_at: ago(1) });
    const c = usageAccounts(d, { now: NOW, env: {}, planLimits: noLimits }).accounts.find((a) => a.id === 'claude_max')!;
    expect(c.windows['5h'].calls).toBe(0);
    expect(c.state).toMatchObject({ state: 'backoff', since: ago(1), until: new Date(NOW + 4 * 3_600_000).toISOString() });
    expect(usageAccounts(d, { now: NOW + 5 * 3_600_000, env: {}, planLimits: noLimits }).accounts.find((a) => a.id === 'claude_max')!.state.state).toBe('no_limit_recorded');
  });
  it('lists unmapped providers under other and reports a missing table as missing', async () => {
    const d = fresh();
    call(d, { consumer: 'x', model: 'm', provider: 'litellm', created_at: ago(1) });
    d.exec('DROP TABLE worker_leases');
    const r = usageAccounts(d, { now: NOW, planLimits: noLimits });
    expect(r.sources).toEqual({ llm_model_calls: 'ok', worker_leases: 'missing' });
    expect(r.accounts.find((a) => a.id === 'other')!.providers_seen).toEqual(['litellm']);
    const auth = { requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() } as never;
    const res = await request(express().use('/usage', createUsageRoutes(d, auth)).use(errorHandler)).get('/usage/accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts.length).toBeGreaterThan(0);
  });
});
