import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { createTestDb } from './helpers/test-db';
import { createAccountUsageSnapshotTables } from '../database/migrate';
import { createUsageRoutes } from '../routes/usage';
import { errorHandler } from '../middleware/error-handler';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { parseSnapshotPayload, recordSnapshot, withSnapshotPct } from '../services/usage-snapshots';
import { usageAccounts, type LimitView } from '../services/usage-accounts';
import type { OllamaAccountUsage } from '../services/ollama-balance';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ahead = (h: number) => new Date(NOW + h * 3_600_000).toISOString();
const noLimits = { limits: [], invalid: 0, account_plan: {}, source: 'test', error: null };
const claudeLimits = {
  limits: (['5h', 'weekly'] as const).map((window) => ({ account: 'claude_max' as const, plan: 'Max 5x ($100/mo)', window, unit: 'unknown' as const, limit: null,
    limit_text: 'not published', source_url: null, checked_at: null, confidence: null, note: null, exceed_behaviour: null })),
  invalid: 0, account_plan: { claude_max: 'Max 5x ($100/mo)' }, source: 'test', error: null,
};

const dbs: ReturnType<typeof createTestDb>[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
const fresh = () => { const d = createTestDb(); dbs.push(d); createAccountUsageSnapshotTables(d); return d; };

describe('snapshot payload validation', () => {
  const full = {
    plan: 'Max 20x', session: { used_pct: 42, resets_at: ahead(3) }, weekly: { used_pct: 61.5, resets_at: ahead(48) },
    model_weekly: [{ model: 'Opus', used_pct: 80, resets_at: ahead(48), cap_note: 'separate Opus cap' }],
    credits: [{ label: 'extra usage', remaining: 12.5, total: 50, currency: 'USD', expires_at: ahead(24 * 30) }],
    spend_limit: { spent: 37.5, limit: 50, currency: 'USD', period: 'monthly', auto_reload: false },
    by_product: [{ product: 'Claude Code', share_pct: 90 }, { product: 'claude.ai', share_pct: 10 }], note: 'read from claude.ai/settings/usage',
  };
  it('accepts a full payload and every field is optional', () => {
    expect(parseSnapshotPayload(full)).toEqual({ ok: true, payload: full });
    expect(parseSnapshotPayload({ weekly: { used_pct: 10 } })).toEqual({ ok: true, payload: { weekly: { used_pct: 10 } } });
  });
  it('rejects out-of-range percentages, bad timestamps, long notes, empty bodies and unknown keys', () => {
    for (const bad of [{ session: { used_pct: 101 } }, { weekly: { used_pct: -1 } }, { by_product: [{ product: 'x', share_pct: 120 }] },
      { session: { resets_at: 'tomorrow' } }, { note: 'x'.repeat(501) }, {}, { plan: 'Max', tokens_left: 5 }, { session: { used_pct: 5, extra: 1 } },
      { spend_limit: { auto_reload: 'yes' } }, { credits: [{ label: 'x', remaining: -3 }] }, [], null]) {
      expect(parseSnapshotPayload(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('refuses secret-looking values without echoing them', () => {
    const key = `sk-ant-${'a1B2'.repeat(14)}`;
    const r = parseSnapshotPayload({ note: `my key is ${key}` });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.ok === false && r.error).toMatch(/note.*looks like a secret/);
    expect(parseSnapshotPayload({ credits: [{ label: `ghp_${'x'.repeat(36)}` }] }).ok).toBe(false);
  });
});

describe('limit fill from a snapshot', () => {
  const view = (o: Partial<LimitView>): LimitView => ({ account: 'claude_max', plan: 'Max', window: 'weekly', unit: 'unknown', limit: null, limit_text: '', source_url: null,
    checked_at: null, confidence: null, note: null, exceed_behaviour: null, measured_window: '7d', measured_unit: 'tokens', used: 5, comparable: false, used_pct: null,
    unit_note: null, active: true, ...o });
  const snap = { reported_at: ago(2), stale: false, payload: { session: { used_pct: 30, resets_at: ahead(2) }, weekly: { used_pct: 70 } } };
  it('fills session (5h / session rows) and weekly with pct_source operator_snapshot', () => {
    expect(withSnapshotPct(view({ window: '5h' }), snap, NOW)).toMatchObject({ used_pct: 30, comparable: true, pct_source: 'operator_snapshot', reported_at: ago(2), resets_at: ahead(2) });
    expect(withSnapshotPct(view({ window: 'weekly' }), snap, NOW)).toMatchObject({ used_pct: 70, pct_source: 'operator_snapshot', resets_at: null });
    expect(withSnapshotPct(view({ window: 'monthly' }), snap, NOW).pct_source).toBeUndefined();
    expect(withSnapshotPct(view({ window: 'weekly', active: false }), snap, NOW).pct_source).toBeUndefined(); // reference plan
  });
  it('never overwrites an API-sourced figure, and skips a window that has reset since', () => {
    const api = view({ window: 'weekly', used_pct: 89.7, comparable: true, pct_source: 'ollama_balance_api' });
    expect(withSnapshotPct(api, snap, NOW)).toBe(api);
    const expired = { ...snap, payload: { session: { used_pct: 100, resets_at: ago(1) } } };
    expect(withSnapshotPct(view({ window: '5h' }), expired, NOW).used_pct).toBeNull();
  });
});

describe('usageAccounts with operator snapshots', () => {
  it('latest snapshot per account with age and stale flag; unknown stays absent', () => {
    const d = fresh();
    recordSnapshot(d, 'claude_max', 'u1', { weekly: { used_pct: 40 } }, ago(30));
    recordSnapshot(d, 'claude_max', 'u1', { weekly: { used_pct: 55 }, plan: 'Max 5x' }, ago(3));
    recordSnapshot(d, 'chatgpt_pro', 'u1', { session: { used_pct: 12 } }, ago(26));
    const r = usageAccounts(d, { now: NOW, planLimits: claudeLimits });
    const claude = r.accounts.find((a) => a.id === 'claude_max')!;
    expect(claude.operator_snapshot).toEqual({ reported_at: ago(3), age_hours: 3, stale: false, weekly: { used_pct: 55 }, plan: 'Max 5x' });
    expect(claude.limits.find((l) => l.window === 'weekly')).toMatchObject({ used_pct: 55, pct_source: 'operator_snapshot', reported_at: ago(3) });
    expect(claude.limits.find((l) => l.window === '5h')!.used_pct).toBeNull(); // no session figure reported → unknown, not 0
    expect(r.accounts.find((a) => a.id === 'chatgpt_pro')!.operator_snapshot).toMatchObject({ age_hours: 26, stale: true });
    expect(r.accounts.find((a) => a.id === 'ollama_cloud')!.operator_snapshot).toBeNull();
    expect(d.prepare('SELECT count(*) n FROM account_usage_snapshots').get()).toEqual({ n: 3 }); // append-only
  });
  it('limit_reached only from a fresh snapshot at >= 100 % whose window has not reset', () => {
    const d = fresh();
    recordSnapshot(d, 'claude_max', 'u1', { session: { used_pct: 100, resets_at: ahead(2) } }, ago(1));
    const s = usageAccounts(d, { now: NOW, env: {}, planLimits: noLimits }).accounts.find((a) => a.id === 'claude_max')!.state;
    expect(s).toMatchObject({ state: 'limit_reached', since: ago(1), until: ahead(2) });
    expect(s.reason).toMatch(/operator snapshot/);
    recordSnapshot(d, 'chatgpt_pro', 'u1', { weekly: { used_pct: 100 } }, ago(25)); // stale
    recordSnapshot(d, 'opencode_free', 'u1', { session: { used_pct: 100, resets_at: ago(0.5) } }, ago(2)); // window reset since
    const r = usageAccounts(d, { now: NOW, env: {}, planLimits: noLimits });
    expect(r.accounts.find((a) => a.id === 'chatgpt_pro')!.state.state).toBe('no_limit_recorded');
    expect(r.accounts.find((a) => a.id === 'opencode_free')!.state.state).toBe('no_limit_recorded');
  });
  it('the Ollama balance API figure wins over a snapshot', () => {
    const d = fresh();
    recordSnapshot(d, 'ollama_cloud', 'u1', { session: { used_pct: 100 }, weekly: { used_pct: 100 } }, ago(1));
    const api: OllamaAccountUsage = { source: 'ollama_balance_api', mode: 'on', fetched_at: ago(0), session: { used_pct: 20, resets_at: ahead(1) },
      weekly: { used_pct: 50, resets_at: ahead(40) }, credits: null, week: null };
    const plan = { ...claudeLimits, limits: claudeLimits.limits.map((l) => ({ ...l, account: 'ollama_cloud' as const, window: l.window === '5h' ? 'session' as const : l.window })),
      account_plan: { ollama_cloud: 'Max 5x ($100/mo)' } };
    const o = usageAccounts(d, { now: NOW, planLimits: plan, ollamaAccountUsage: api }).accounts.find((a) => a.id === 'ollama_cloud')!;
    expect(o.limits.map((l) => [l.window, l.used_pct, l.pct_source])).toEqual([['session', 20, 'ollama_balance_api'], ['weekly', 50, 'ollama_balance_api']]);
    expect(o.state.state).toBe('no_limit_recorded');
    expect(o.operator_snapshot).toMatchObject({ session: { used_pct: 100 } }); // still shown, labelled as operator-reported
  });
  it('a missing table reads as no snapshot, never an error', () => {
    const d = createTestDb(); dbs.push(d);
    expect(usageAccounts(d, { now: NOW, planLimits: noLimits }).accounts.every((a) => a.operator_snapshot === null)).toBe(true);
  });
});

describe('POST /usage/accounts/:account/snapshot', () => {
  beforeAll(() => { vi.stubEnv('JWT_SECRET', 'usage-snapshot-fixture-secret-only'); });
  function app() {
    const d = fresh();
    const service = new AuthService(d);
    const token = (role: UserRole) => service.generateToken(service.createUser(`${role}@example.test`, 'disposable-fixture-only', role));
    const auth = createAuthMiddleware(service);
    const a = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use(express.json()).use('/usage', auth.requireAuth, createUsageRoutes(d, auth, { ollamaAccountUsage: async () => null as never })).use(errorHandler);
    return { d, a, admin: token(UserRole.ADMIN), viewer: token(UserRole.VIEWER) };
  }
  it('403 without manage:config; 201 with it; two posts keep both rows and show the latest', async () => {
    const { d, a, admin, viewer } = app();
    const post = (tok: string, body: object, account = 'claude_max') => request(a).post(`/usage/accounts/${account}/snapshot`).set('Authorization', `Bearer ${tok}`).send(body);
    expect((await post(viewer, { weekly: { used_pct: 10 } })).status).toBe(403);
    const first = await post(admin, { weekly: { used_pct: 10 } });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ account: 'claude_max', source: 'operator_snapshot', payload: { weekly: { used_pct: 10 } } });
    expect(typeof first.body.id).toBe('string');
    expect((await post(admin, { weekly: { used_pct: 20 }, note: 'second' })).status).toBe(201);
    const rows = d.prepare('SELECT account, reported_by, source, payload_json FROM account_usage_snapshots ORDER BY rowid').all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'operator_snapshot' && r.reported_by.length > 0)).toBe(true);
    const got = await request(a).get('/usage/accounts').set('Authorization', `Bearer ${admin}`);
    expect(got.status).toBe(200);
    expect(got.body.accounts.find((x: { id: string }) => x.id === 'claude_max').operator_snapshot).toMatchObject({ weekly: { used_pct: 20 }, note: 'second', stale: false });
  });
  it('400 for invalid bodies, secrets and unknown accounts; nothing is stored', async () => {
    const { d, a, admin } = app();
    const post = (body: object, account = 'claude_max') => request(a).post(`/usage/accounts/${account}/snapshot`).set('Authorization', `Bearer ${admin}`).send(body);
    expect((await post({ session: { used_pct: 150 } })).status).toBe(400);
    expect((await post({ unknown_field: 1 })).status).toBe(400);
    const secret = await post({ note: `token: ${'Zx9'.repeat(10)}` });
    expect(secret.status).toBe(400);
    expect(JSON.stringify(secret.body)).not.toContain('Zx9Zx9Zx9');
    expect((await post({ weekly: { used_pct: 1 } }, 'not_an_account')).status).toBe(400);
    expect((await post({ weekly: { used_pct: 1 } }, 'other')).status).toBe(400);
    expect(d.prepare('SELECT count(*) n FROM account_usage_snapshots').get()).toEqual({ n: 0 });
  });
});
