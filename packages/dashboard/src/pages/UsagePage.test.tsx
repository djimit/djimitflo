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
