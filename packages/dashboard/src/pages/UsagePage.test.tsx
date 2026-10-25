import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const win = (calls: number, tokens: number | null, unknown = 0) => ({ calls, tokens, calls_without_tokens: unknown });
const limit = (o: Record<string, unknown>) => ({ account: 'x', plan: 'P', window: 'weekly', unit: 'unknown', limit: null, limit_text: '', source_url: null, checked_at: null,
  confidence: null, note: null, exceed_behaviour: null, measured_window: '7d', measured_unit: 'tokens', used: 10, comparable: false, used_pct: null, unit_note: null, active: null, ...o });
const account = (o: Record<string, unknown>) => ({ id: 'x', label: 'X', windows: { '5h': win(0, 0), today: win(0, 0), '7d': win(0, 0), month: win(0, 0) }, consumers_7d: [],
  providers_seen: [], last_error: null, last_limit_hit: null, state: { state: 'no_limit_recorded', since: null, until: null, reason: null },
  cost: { basis: 'flat_subscription', observed_bases: [], list_price_usd_month: null, calls_without_list_price_month: 0 }, plan: 'unknown', limits: [], ...o });

const body = {
  generated_at: '2026-10-18T12:00:00Z', window_starts: {}, sources: { llm_model_calls: 'ok', worker_leases: 'ok' },
  plan_limits: { source: 'docs/usage-plan-limits.json', entries: 3, invalid: 0, error: null }, note: 'n',
  accounts: [
    account({ id: 'ollama_cloud', label: 'Ollama Cloud (subscription)', windows: { '5h': win(3, 5120, 1), today: win(3, 5120, 1), '7d': win(3, 5120, 1), month: win(3, 5120, 1) },
      state: { state: 'limited', since: '2026-10-18T10:00:00Z', until: null, reason: 'weekly usage limit (reached your weekly usage limit)' },
      limits: [limit({ plan: 'Legacy Max', window: 'weekly', limit: null, limit_text: 'numbers not published', source_url: 'https://ollama.com/blog/transparent-pricing' })] }),
    account({ id: 'claude_max', label: 'Claude Max (subscription via Claude Code)', plan: 'Max 5x',
      limits: [limit({ plan: 'Max 5x', window: '5h', unit: 'messages', limit: 200, active: true, unit_note: 'vendor counts messages; we measure tokens — not comparable' }),
        limit({ plan: 'Max 5x', window: 'weekly', unit: 'tokens', limit: 1000, used: 250, comparable: true, used_pct: 25, active: true })] }),
  ],
};

it('renders per-account windows, the limited state, null limits as text and unit mismatches without a bar', async () => {
  const fetch = vi.fn(async (url: string) => (String(url).includes('/usage/accounts')
    ? { ok: true, status: 200, json: async () => body }
    : { ok: true, status: 200, json: async () => ({ total_tokens: 0, total_cost: 0, breakdown: [] }) }));
  vi.stubGlobal('fetch', fetch);
  render(<UsagePage />);
  const ollama = await screen.findByRole('region', { name: 'Ollama Cloud (subscription)' });
  expect(within(ollama).getByText(/limited since/)).toBeTruthy();
  expect(within(ollama).getAllByText(/5[,.]?120/).length).toBeGreaterThan(0);
  expect(within(ollama).getAllByText(/\+1 unreported/).length).toBe(4);
  expect(within(ollama).getByText('Legacy Max · weekly: no published number')).toBeTruthy();
  expect(within(ollama).getByText(/plan: unknown/)).toBeTruthy();
  expect(within(ollama).queryByRole('meter')).toBeNull();

  const claude = screen.getByRole('region', { name: 'Claude Max (subscription via Claude Code)' });
  expect(within(claude).getByText('vendor counts messages; we measure tokens — not comparable')).toBeTruthy();
  const meters = within(claude).getAllByRole('meter');
  expect(meters).toHaveLength(1); // only the tokens-vs-tokens limit gets a bar
  expect(meters[0].getAttribute('aria-label')).toBe('Max 5x · weekly');
  expect(screen.queryByText(/Legacy token_usage_log/)).toBeNull(); // legacy panel hidden while empty
});

const stub = (accounts: unknown[]) => vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/usage/accounts')
  ? { ok: true, status: 200, json: async () => ({ ...body, accounts }) }
  : { ok: true, status: 200, json: async () => ({ total_tokens: 0, total_cost: 0, breakdown: [] }) })));
const accountWide = (o: Record<string, unknown>) => ({ source: 'ollama_balance_api', mode: 'on', fetched_at: '2026-10-25T12:00:00Z', session: null, weekly: null,
  credits: null, week: null, ...o });

it('shows the account-wide session %, weekly %, resets and credits next to the Djimitflo share', async () => {
  stub([account({ id: 'ollama_cloud', label: 'Ollama Cloud (subscription)', scope: 'djimitflo_ledger',
    windows: { '5h': win(10, 100), today: win(20, 200), '7d': win(118, 1000), month: win(200, 2000) }, lease_sessions: { '5h': 2, today: 4, '7d': 40, month: 60 },
    state: { state: 'limit_reached', since: '2026-10-25T12:00:00Z', until: '2026-10-25T15:00:00Z', reason: 'Ollama balance API: session 100 % used' },
    account_usage: accountWide({ session: { used_pct: 100, resets_at: '2026-10-25T15:00:00Z' }, weekly: { used_pct: 89.7, resets_at: '2026-10-27T00:00:00Z' },
      credits: { balance_usd: 15.31 }, week: { request_count: 6612, usage_value_usd: 3.99, from: null, until: null } }),
    plan: 'Legacy Max', limits: [limit({ plan: 'Legacy Max', window: 'weekly', limit: null, active: true, comparable: true, used_pct: 89.7, pct_source: 'ollama_balance_api',
      resets_at: '2026-10-27T00:00:00Z' })] })]);
  render(<UsagePage />);
  const o = await screen.findByRole('region', { name: 'Ollama Cloud (subscription)' });
  expect(within(o).getByText(/limit reached/)).toBeTruthy();
  expect(within(o).getByText(/^session: 100 % used/)).toBeTruthy();
  expect(within(o).getByText(/^weekly: 89\.7 % used/)).toBeTruthy();
  expect(within(o).getByText(/purchased usage credits: \$15\.31 left/)).toBeTruthy();
  expect(within(o).getByText(/account requests \(7 d\): 6,612/)).toBeTruthy();
  expect(within(o).getByText(/Djimitflo's share: 118 calls/)).toBeTruthy();
  expect(within(o).getAllByText(/Djimitflo's share, as recorded/).length).toBeGreaterThan(0);
  expect(within(o).getAllByText(/counts once/).length).toBeGreaterThan(0);
  const meter = within(o).getByRole('meter');
  expect(meter.getAttribute('aria-valuenow')).toBe('89.7'); // the API percent draws a bar although the plan publishes no number
});

it('shows unknown with the reason when the balance API is off or failed, never 0', async () => {
  stub([account({ id: 'ollama_cloud', label: 'Ollama Cloud (subscription)', scope: 'djimitflo_ledger', lease_sessions: { '5h': 0, today: 0, '7d': 0, month: 0 },
    account_usage: accountWide({ mode: 'off', fetched_at: null, error: 'OLLAMA_BALANCE_MODE is not on' }) })]);
  render(<UsagePage />);
  const o = await screen.findByRole('region', { name: 'Ollama Cloud (subscription)' });
  expect(within(o).getByText('Account-wide (Ollama): unknown — balance API off (OLLAMA_BALANCE_MODE is not on)')).toBeTruthy();
  expect(within(o).queryByText(/% used/)).toBeNull();
  expect(within(o).queryByText(/\$0/)).toBeNull();
  cleanup();
  stub([account({ id: 'ollama_cloud', label: 'Ollama Cloud (subscription)', account_usage: accountWide({ error: 'balance: HTTP 503; usage: timeout' }) })]);
  render(<UsagePage />);
  const o2 = await screen.findByRole('region', { name: 'Ollama Cloud (subscription)' });
  expect(within(o2).getByText(/unknown — balance API unavailable \(balance: HTTP 503; usage: timeout\)/)).toBeTruthy();
});
