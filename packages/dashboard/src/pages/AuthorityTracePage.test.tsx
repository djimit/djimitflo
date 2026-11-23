import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthorityTracePage } from './AuthorityTracePage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('distinguishes an unavailable ledger from zero events and allows retry', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: 'Authority ledger unavailable', code: 'AUTHORITY_LEDGER_UNAVAILABLE' } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ total: 3 }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [], total: 3 }) });
  vi.stubGlobal('fetch', fetch);
  render(<AuthorityTracePage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Authority ledger unavailable');
  expect(screen.queryByText('Total events')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('3')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

// Dashboard truth audit 2026-11-12 (/authority): "HOLD 677" in amber with 0 open holds, an always-empty Previous column,
// autonomy:* actors stored as actor_type 'human', and no subject per row.
const ev = (over: Record<string, unknown>) => ({
  event_id: `ev-${Math.random()}`, correlation_id: 'c-1', sequence: 1, occurred_at: '2026-10-01T10:00:00Z', previous_state: null,
  requested_state: 'EXECUTION_APPROVED', policy_decision: 'ALLOW', actor_subject: 'system', actor_type: 'service', source_system: 'djimitflo',
  subject: null, ...over,
});
function stub(stats: Record<string, unknown>, events: Array<Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).includes('/stats') ? stats : { events, total: events.length }) })));
}

it('shows open holds apart from the HOLD total, and the total is not an alarm', async () => {
  stub({ total: 1790, open_holds: 0, by_decision: [{ policy_decision: 'ALLOW', n: 1103 }, { policy_decision: 'HOLD', n: 677 }] }, []);
  render(<AuthorityTracePage />);
  const open = await screen.findByTestId('open-holds');
  expect(open.textContent).toMatch(/Open holds/);
  expect(open.textContent).toMatch(/0/);
  const total = screen.getByTestId('decision-HOLD');
  expect(total.textContent).toMatch(/HOLD.*677/);
  expect(total.innerHTML).not.toMatch(/amber/);
});

it('hides an all-empty Previous column, renders autonomy actors as automated, and links the subject', async () => {
  stub({ total: 2, open_holds: 0, by_decision: [] }, [
    ev({ actor_subject: 'autonomy:oracle-lane-v1', actor_type: 'human', subject: { kind: 'task', id: 'task-1', title: 'Fix the parser' } }),
    ev({ actor_subject: 'ee5e7993-user', actor_type: 'human', correlation_id: 'goal-1', subject: { kind: 'goal', id: 'goal-1', title: 'Remove dead code' } }),
  ]);
  render(<AuthorityTracePage />);
  expect(await screen.findByText('Fix the parser')).toBeTruthy();
  expect(screen.queryByText(/Previous/)).toBeNull();
  expect(screen.queryByText(/—\s*→/)).toBeNull();
  expect(screen.getByText(/autonomy:oracle-lane-v1 \(automated\)/)).toBeTruthy();
  expect(screen.getByText(/ee5e7993-user \(human\)/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Fix the parser' }).getAttribute('href')).toBe('/tasks/task-1');
  expect(screen.getByText('Remove dead code')).toBeTruthy();
});
