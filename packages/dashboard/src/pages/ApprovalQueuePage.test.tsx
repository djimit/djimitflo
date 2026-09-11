import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@djimitflo/shared';
import { ApprovalQueuePage } from './ApprovalQueuePage';
import { ApprovalCard } from '../components/ApprovalCard';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const fixture = { id: 'approval', title: 'Review local artifact', status: 'pending', risk_level: 'low', request_type: 'high_risk_action', request_data: {}, request_message: 'Manual fixture', expires_at: null } as ApprovalRequest;
const denied = { ...fixture, status: 'denied', denial_reason: 'Evidence missing', decided_by: 'independent-checker', decided_at: '2026-09-09T10:00:00Z', denied_at: '2026-09-09T10:00:00Z', approved_by: null } as ApprovalRequest;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const unavailable = () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'Approval service unavailable' } }) });

it('shows request failure instead of claiming no approvals and can retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok({ approvals: [] })));
  render(<ApprovalQueuePage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Approval service unavailable');
  expect(screen.queryByText(/No pending approvals/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No pending approvals in this queue.')).toBeTruthy();
  expect(screen.queryByText(/unblocked/)).toBeNull();
});

it('preserves denial title, reason and independent decision identity in history', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ok({ approvals: url.endsWith('status=denied') ? [denied] : [] })));
  render(<ApprovalQueuePage />);
  fireEvent.click(screen.getByRole('button', { name: 'Denied', exact: true }));
  expect(await screen.findByText('Evidence missing')).toBeTruthy();
  expect(screen.getByText('Review local artifact')).toBeTruthy();
  expect(screen.getByText(/Denied by independent-checker/)).toBeTruthy();
});

it('ignores a late previous-tab response', async () => {
  let release!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('status=pending') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(ok({ approvals: [denied] }))));
  render(<ApprovalQueuePage />);
  fireEvent.click(screen.getByRole('button', { name: 'Denied', exact: true }));
  await screen.findByText('Evidence missing');
  await act(async () => { release(ok({ approvals: [fixture] })); });
  expect(screen.getByText('Evidence missing')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Deny', exact: true })).toBeNull();
});

it('refreshes the current tab when an old-tab denial finishes', async () => {
  let complete!: (value: unknown) => void;
  let decided = false;
  vi.stubGlobal('prompt', () => 'Evidence missing');
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return new Promise(resolve => { complete = resolve; });
    return ok({ approvals: url.endsWith('status=pending') ? (decided ? [] : [fixture]) : (decided ? [denied] : []) });
  }));
  render(<ApprovalQueuePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Deny', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Denied', exact: true }));
  await screen.findByText('No denied approvals found.');
  await act(async () => { decided = true; complete(ok(denied)); });
  expect(await screen.findByText('Evidence missing')).toBeTruthy();
});

it('rejects whitespace denial reasons locally without issuing a mutation', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('prompt', () => '   ');
  render(<ApprovalCard approval={fixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Deny', exact: true }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'A denial reason is required.');
  expect(fetch).not.toHaveBeenCalled();
});

it('surfaces a denied mutation failure and retries with the real returned decision', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok(denied));
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('prompt', () => ' Evidence missing ');
  const updated = vi.fn(); render(<ApprovalCard approval={fixture} onUpdated={updated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Deny', exact: true }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Approval service unavailable');
  expect(updated).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Deny', exact: true }));
  await waitFor(() => expect(updated).toHaveBeenCalledWith(denied));
  expect(screen.getByText('Evidence missing')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetch).toHaveBeenLastCalledWith('/api/approvals/approval/deny', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Evidence missing' }) }));
});

it('updates decision state when new props arrive from a websocket refresh', () => {
  const view = render(<ApprovalCard approval={fixture} />);
  expect(screen.getByRole('button', { name: 'Deny', exact: true })).toBeTruthy();
  view.rerender(<ApprovalCard approval={denied} />);
  expect(screen.queryByRole('button', { name: 'Deny', exact: true })).toBeNull();
  expect(screen.getByText('Evidence missing')).toBeTruthy();
});
