import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DecisionsInboxPage, DraftPrsSection } from './DecisionsInboxPage';
import { CommandStrip, EvolutionFunnel, NeedsYou, type CockpitView } from './OperatorCockpitPage';
import { Layout } from '../components/Layout';
import { api, type DraftPrs, type EvolutionLineage } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

// Dashboard truth audit 2026-11-12: /decisions, the sidebar badge, the tab title and the cockpit tell one story.
const NEEDS_YOU = { approvals: 0, requeue: 23, labels: 4, memory_review: 0, audit_batch: 2, flagged_prs: 26, operator_stalls: 0, total: 51,
  system_requeue: { budgeted_requeue: 0, infra_failed: 4, attribution_unknown: 0, not_actionable: 0 } };
const inbox = {
  requeue: [
    { id: 'aaaaaaaa-1', title: 'Fix the flaky sweep', status: 'regressed', updated_at: '2026-11-10T12:00:00Z', requeued_as: null, queue_class: 'operator' },
    { id: 'ffffffff-1', title: 'Worker lost its lease', status: 'infra_failed', updated_at: '2026-11-10T12:00:00Z', requeued_as: null, queue_class: 'infra_failed' },
  ],
  prescreen: { items: [
    { id: 'bbbbbbbb-1', title: 'Unlabelled rejection', status: 'needs_more_evidence', reason: 'vague', verdict_at: '2026-11-01T00:00:00Z', label: null },
    { id: 'cccccccc-1', title: 'Already labelled rejection', status: 'needs_more_evidence', reason: 'vague', verdict_at: '2026-11-01T00:00:00Z', label: 'ok' },
  ], labelled: 1, wrong: 0, false_rejection_pct: null, enforce_threshold: '>= 30' },
  telegram: [], autonomy: [], memory: [],
  attribution_audit: { week_start: '2026-11-09T00:00:00.000Z', seed: 's', size: 0, frame_n: 0, strata: {}, items: [], audited: { total: 0, correct: 0, wrong: 0, unclear: 0 }, note: '' },
};
beforeEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never });
  vi.spyOn(api, 'getDecisionsInbox').mockResolvedValue(inbox as never);
  vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [] });
  vi.spyOn(api, 'getAuthorityStats').mockRejectedValue(new Error('x'));
  vi.spyOn(api, 'getDraftPrs').mockResolvedValue({ total: 0, unsettled: 0, by_settlement: null, closed_unmerged: 0, rows: [] });
  vi.spyOn(api, 'getE1LabelQueue').mockResolvedValue({ task: null, progress: { labelled: 0, tasks: 0, target: 30, max_tasks: 40 } });
  vi.spyOn(api, 'getRelevanceQueue').mockResolvedValue({ cards: [], progress: { protected: { labelled: 0, total: 0 }, relabel: { labelled: 0, total: 0, due: 0 }, al: { labelled: 0, total: 0 } }, today: { day: '2026-11-12', labels: 0, seconds: 0, median_seconds: null, target_seconds: 1800, remaining_seconds: 1800, est_cards_left: null } });
  vi.spyOn(api, 'getDependencyLane').mockResolvedValue({ mode: 'off', effective_mode: 'off', revoked_at: null, revoked_reason: null, max_per_day: 4, merged_24h: 0, open: 0, rows: [] });
  vi.spyOn(api, 'getNeedsYou').mockResolvedValue({ at: new Date().toISOString(), needs_you: NEEDS_YOU, warnings: [], errors: [] });
});
afterEach(() => { cleanup(); document.title = 'Djimitflo'; });

it('the sidebar badge and the tab title show the cockpit needs-you total, not only pending approvals (0)', async () => {
  document.title = 'Djimitflo';
  render(<MemoryRouter initialEntries={['/tasks']}><Layout /></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText('51 pending')).toBeTruthy());
  await waitFor(() => expect(document.title).toBe('(51) Djimitflo'));
});

it('/decisions header: the same needs-you number with its breakdown, each part an anchor on the page', async () => {
  render(<MemoryRouter><DecisionsInboxPage /></MemoryRouter>);
  const summary = await screen.findByTestId('decisions-needs-you');
  expect(summary.textContent).toContain('51 need you');
  expect(screen.getByRole('link', { name: '23 requeue candidates' }).getAttribute('href')).toBe('#requeue');
  expect(screen.getByRole('link', { name: '26 flagged loop PRs' }).getAttribute('href')).toBe('#draft-prs');
});

it('requeue: infra_failed rows are system-side — no Requeue/Dismiss buttons, in their own group, like the cockpit', async () => {
  render(<MemoryRouter><DecisionsInboxPage /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Dismiss aaaaaaaa' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Dismiss ffffffff' })).toBeNull();
  expect(screen.queryByLabelText('Reason for requeueing ffffffff')).toBeNull();
  expect(screen.getByTestId('requeue-system').textContent).toContain('Worker lost its lease');
});

it('D5: the label table lists unlabelled rejections only, with a toggle for the labelled ones', async () => {
  render(<MemoryRouter><DecisionsInboxPage /></MemoryRouter>);
  expect(await screen.findByText('Unlabelled rejection')).toBeTruthy();
  expect(screen.queryByText('Already labelled rejection')).toBeNull();
  fireEvent.click(screen.getByLabelText(/Show labelled \(1\)/));
  expect(screen.getByText('Already labelled rejection')).toBeTruthy();
});

it('loop PRs: rows that need the operator say so; merged rows in the survival window only wait', async () => {
  const row = (r: Partial<DraftPrs['rows'][number]> & { run_id: string; pr_number: number }): DraftPrs['rows'][number] => ({
    lane: 'test-gap', pr_url: `https://github.com/o/r/pull/${r.pr_number}`, age_days: 34, outcome: null, survived: null, auto_merge: null,
    settlement: 'OPEN_BLOCKED', settlement_reason: 'open', settlement_terminal: false, settlement_age_days: 34, ...r });
  vi.spyOn(api, 'getDraftPrs').mockResolvedValue({ total: 2, unsettled: 2, by_settlement: null, closed_unmerged: 0, rows: [
    row({ run_id: 'a', pr_number: 713, outcome: 'open', needs_operator: true }),
    row({ run_id: 'b', pr_number: 900, outcome: 'merged', settlement: 'MERGED_SURVIVAL_PENDING', age_days: 2, needs_operator: false }),
  ] });
  render(<DraftPrsSection />);
  expect(await screen.findByText('#713')).toBeTruthy();
  expect(screen.getByText('you: merge or close')).toBeTruthy();
  expect(screen.getByText('waits: survival window')).toBeTruthy();
});

const snap = (over: Partial<CockpitView> = {}): CockpitView => ({ at: new Date().toISOString(), build: { commit: null, build_time: null },
  scorecard: {}, guardrails: [{ name: 'regressions', ok: true, value: 0, limit: '0' }], stalls: [], gym: [],
  remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [], ...over });

it('cockpit: a future admission expiry is a warning ("expires in 15 d"), not blocked work', () => {
  const html = renderToStaticMarkup(<MemoryRouter><CommandStrip d={snap({ warnings: [{ subsystem: 'runtime_admission:djimitsec', since: '2026-11-27T00:00:00Z', detail: 'reassess', due_in_days: 15 }] })} /></MemoryRouter>);
  expect(html).toContain('nothing blocked');
  expect(html).toContain('runtime_admission:djimitsec expires in 15 d');
});

it('cockpit: operator-action stalls count as needing you; infra_failed requeues are shown as system-side', () => {
  const html = renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ ...NEEDS_YOU, requeue: 0, audit_batch: 0, flagged_prs: 0, operator_stalls: 1, stalls: 0, total: 1 }} /></MemoryRouter>);
  expect(html).toContain('Needs you (1)');
  expect(html).toContain('1 stalls that need you');
  expect(html).not.toContain('silent stalls');
  expect(html).toContain('4 infra failed');
});

it('funnel: with no queue anywhere the bottleneck says "no queue" instead of a median over archived rows', () => {
  const e = { window_days: 60, stages: [], regression_split: { mutation_failure: 0, reviewer_rejection: 0, environment: 0, post_verification: 0, post_verification_follow_up_fix: null, unknown: 0 },
    bottleneck: { from: 'proposal', to: 'experiment', lost: 1152, conversion: 0.263, reason: 'archived (1152)', oldest_queue: null }, evolutionary_regressions: 0,
    nev: { status: 'INSUFFICIENT_EVIDENCE', reason: 'r', value: null, survived: 0, settled: 0, survival_rate: null, survival_ci: null, severity_weights: { removed: 1, follow_up_fix: 0.5 },
      per_m_cloud_tokens: null, per_kwh: null, per_kwh_status: 'x', per_operator_decision: null, operator_decisions: 0, cloud_tokens: null, note: '' },
    throughput: { verified: 0, label: 'throughput, not improvement' }, jev_semantic_routing: 'x', errors: [] } as unknown as EvolutionLineage;
  expect(renderToStaticMarkup(<MemoryRouter><EvolutionFunnel e={e} /></MemoryRouter>)).toContain('no queue');
});
