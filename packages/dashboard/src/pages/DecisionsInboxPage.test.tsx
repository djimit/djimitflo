import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { DecisionsInboxPage } from './DecisionsInboxPage';
import { api } from '../lib/api';

vi.mock('../hooks/usePendingApprovals', () => ({ usePendingApprovals: () => ({ count: 2 }) }));
const inbox = {
  requeue: [{ id: 'aaaaaaaa-1', title: 'Add unit tests for foo', status: 'regressed', updated_at: '2026-09-28T12:00:00Z', requeued_as: null }],
  prescreen: { items: [{ id: 'bbbbbbbb-1', title: 'Vague idea', status: 'needs_more_evidence', reason: 'names no concrete file', verdict_at: '2026-09-27T00:00:00Z', label: null }], labelled: 0, wrong: 0, false_rejection_pct: null, enforce_threshold: '>= 30 labelled and <= 5 % wrong (D5)' },
  telegram: [],
  autonomy: [{ cls: 'maker:test-gap:opencode', human_approved: 14, auto_approved: 8, denied: 0, expired: 1, verified: 10, regressed: 7, infra: 0, pending: 5, earned: false, why: '6 more human approvals' }],
  memory: [{ id: 'm1', title: 'djimit-unguarded-json-extract', content: 'Never JSON.parse model output without a guard', memory_type: 'engineering_rule', status: 'review_required', created_at: '' }],
};
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getDecisionsInbox').mockResolvedValue(inbox as never);
  vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [] }); // the approval queue is embedded (W2)
});
const renderPage = () => render(<MemoryRouter><DecisionsInboxPage /></MemoryRouter>);

it('requeues only with a reason, and labels a pre-screen rejection', async () => {
  const requeue = vi.spyOn(api, 'requeueProposal').mockResolvedValue({ id: 'c', created: true, goalCreated: true });
  const label = vi.spyOn(api, 'labelPrescreen').mockResolvedValue(undefined);
  renderPage();
  const button = await screen.findByRole('button', { name: 'Requeue' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Reason for requeueing aaaaaaaa'), { target: { value: 'deps fixed in #514' } });
  fireEvent.click(button);
  await waitFor(() => expect(requeue).toHaveBeenCalledWith('aaaaaaaa-1', 'deps fixed in #514'));
  fireEvent.click(screen.getByRole('button', { name: 'wrong' }));
  await waitFor(() => expect(label).toHaveBeenCalledWith('bbbbbbbb-1', 'wrong'));
  expect(screen.getByText('2 approvals pending')).toBeTruthy();
  expect(screen.getByText('maker:test-gap:opencode')).toBeTruthy();
  expect(screen.getByText('6 more human approvals')).toBeTruthy();
  expect(screen.getByText('Empty — no Telegram user is recognised.')).toBeTruthy();
});

it('rejects a non-numeric Telegram id before calling the API', async () => {
  const set = vi.spyOn(api, 'setTelegramIdentity').mockResolvedValue(undefined);
  renderPage();
  fireEvent.change(await screen.findByLabelText('Telegram user id'), { target: { value: '@dennis' } });
  fireEvent.change(screen.getByLabelText('Djimitflo user id'), { target: { value: 'u1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect((await screen.findByRole('alert')).textContent).toContain('digits');
  expect(set).not.toHaveBeenCalled();
});

it('promotes or rejects a memory waiting for review', async () => {
  const promote = vi.spyOn(api, 'promoteMemoryCandidate').mockResolvedValue({ candidate: {} as never, sinks: [] });
  const reject = vi.spyOn(api, 'rejectMemoryCandidate').mockResolvedValue({});
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Promote' }));
  await waitFor(() => expect(promote).toHaveBeenCalledWith('m1'));
  fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(reject).toHaveBeenCalledWith('m1'));
});
