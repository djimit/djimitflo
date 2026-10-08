import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { DecisionsInboxPage, DependencyLaneSection, DraftPrsSection } from './DecisionsInboxPage';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

// UX-4: actions are gated by role; these cases exercise them as an admin
beforeEach(() => { useAuthStore.setState({ user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never }); });

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
  vi.spyOn(api, 'getDraftPrs').mockResolvedValue({ total: 0, unsettled: 0, rows: [] });
  vi.spyOn(api, 'getDependencyLane').mockResolvedValue({ mode: 'off', effective_mode: 'off', revoked_at: null, revoked_reason: null, max_per_day: 4, merged_24h: 0, open: 0, rows: [] });
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

it('UX-7: lists loop draft PRs with n, age and settlement, and says so honestly when there are none', async () => {
  vi.spyOn(api, 'getDraftPrs').mockResolvedValueOnce({ total: 2, unsettled: 1, rows: [
    { run_id: 'r2', lane: 'mutation-gap', pr_url: 'https://github.com/o/r/pull/616', pr_number: 616, age_days: 1, outcome: 'merged', survived: true },
    { run_id: 'r1', lane: 'test-gap', pr_url: 'https://github.com/o/r/pull/474', pr_number: 474, age_days: 8, outcome: null, survived: null },
  ] });
  const { unmount } = render(<DraftPrsSection />);
  expect(await screen.findByText('#616')).toBeTruthy();
  expect(screen.getByText('merged · survived')).toBeTruthy();
  expect(screen.getByText('not settled')).toBeTruthy();
  expect(screen.getByText(/2 PRs \(n\), 1 not settled yet/)).toBeTruthy();
  unmount();
  render(<DraftPrsSection />);
  expect(await screen.findByText('The loop has opened no draft PR yet.')).toBeTruthy();
});

it('D2: dismisses a requeue candidate (with the optional reason) without requiring a requeue', async () => {
  const dismiss = vi.spyOn(api, 'dismissRequeue').mockResolvedValue(undefined);
  const requeue = vi.spyOn(api, 'requeueProposal');
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss aaaaaaaa' }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('aaaaaaaa-1', undefined));
  fireEvent.change(screen.getByLabelText('Reason for requeueing aaaaaaaa'), { target: { value: 'superseded by #700' } });
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss aaaaaaaa' }));
  await waitFor(() => expect(dismiss).toHaveBeenLastCalledWith('aaaaaaaa-1', 'superseded by #700'));
  expect(requeue).not.toHaveBeenCalled();
  expect(await screen.findByText('Dismissed aaaaaaaa')).toBeTruthy();
});

it('dependency lane: shows the Dependabot queue read-only with bump, age, checks and decision, and a revoked act mode', async () => {
  vi.spyOn(api, 'getDependencyLane').mockResolvedValueOnce({ mode: 'act', effective_mode: 'shadow', revoked_at: '2026-10-07T10:00:00Z', revoked_reason: 'main CI red after merging #652', max_per_day: 4, merged_24h: 1, open: 2, rows: [
    { pr_number: 239, title: 'bump postcss from 8.5.26 to 8.5.28', html_url: 'https://github.com/o/r/pull/239', bump: 'patch', age_days: 23, check_state: 'success', decision: 'would_merge', reason: 'act revoked', updated_at: '' },
    { pr_number: 291, title: 'bump the testing group', html_url: null, bump: 'major', age_days: 17, check_state: null, decision: 'skip_major', reason: 'vitest 4.1.11→5.0.1', updated_at: '' },
  ] });
  render(<DependencyLaneSection />);
  expect(await screen.findByText('#239')).toBeTruthy();
  expect(screen.getByText('would_merge')).toBeTruthy();
  expect(screen.getByText('skip_major')).toBeTruthy();
  expect(screen.getByText(/act revoked 2026-10-07T10:00: main CI red after merging #652/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull(); // read-only
});

it('earned auto-merge: an audit-sample loop PR is flagged for the human; auto-merged ones say so', async () => {
  vi.spyOn(api, 'getDraftPrs').mockResolvedValueOnce({ total: 2, unsettled: 2, rows: [
    { run_id: 'r5', lane: 'test-gap', pr_url: 'https://github.com/o/r/pull/705', pr_number: 705, age_days: 0, outcome: null, survived: null, auto_merge: 'audit_sample' },
    { run_id: 'r6', lane: 'test-gap', pr_url: 'https://github.com/o/r/pull/706', pr_number: 706, age_days: 0, outcome: null, survived: null, auto_merge: 'merged' },
  ] });
  render(<DraftPrsSection />);
  expect(await screen.findByText('audit sample — review it')).toBeTruthy();
  expect(screen.getByText('merged')).toBeTruthy();
});
