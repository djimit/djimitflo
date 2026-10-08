import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { NeedsYou, OperatorCockpitPage } from './OperatorCockpitPage';
import { api } from '../lib/api';

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(api, 'getServiceMap').mockResolvedValue({ services: [
  { names: ['event bus'], endpoint: 'http://100.86.47.122:8083', status: 'up', http: 404, ms: 12, error: null },
  { names: ['LiteLLM'], endpoint: 'http://192.168.1.28:4000', status: 'down', http: null, ms: null, error: 'timeout' },
] }); });

it('shows breached guardrails, stalls and gym species from the cockpit endpoint', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue({
    at: '2026-09-28T20:00:00Z', build: { commit: 'f9f481ad3eb5', build_time: null },
    scorecard: { verified_7d: 11, regressed_7d: 5 },
    guardrails: [{ name: 'regressions', ok: false, value: 5, limit: '<= verified/5 (2.2)' }],
    stalls: [{ subsystem: 'gym:atomic@llama-router', since: null, detail: 'no outcome for 9 h' }],
    gym: [{ species: 'atomic', outcomes: 27, successes: 24, success_pct: 89, avg_seconds: 588, avg_tokens: 0, last: '2026-09-28T08:53:00Z' }],
    remote_workers: [], maker_usage_7d: [], judgments_7d: [],
    deploys: [{ at: '2026-09-28T18:43:09Z', event: 'verdict_ok', sha: 'f9f481ad3eb5', detail: '' }],
  });
  render(<OperatorCockpitPage />);
  expect(await screen.findByText('breached · limit <= verified/5 (2.2)')).toBeTruthy();
  expect(screen.getByText('gym:atomic@llama-router')).toBeTruthy();
  expect(screen.getByText('89%')).toBeTruthy();
  expect(screen.getByText('No remote host has claimed work.')).toBeTruthy();
  expect(screen.getByText('verdict ok')).toBeTruthy();
  expect(await screen.findByText('down (timeout)')).toBeTruthy();
});

it('UX-2: shows real-maker outcomes per strategy genome with n, and an honest empty state', async () => {
  const base = { at: '2026-10-04T20:00:00Z', build: { commit: null, build_time: null }, scorecard: {}, guardrails: [], stalls: [], gym: [], remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [] };
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValueOnce({ ...base, genomes: [{ genome: 'g-abc123', skill_id: 'loop-maker:test-gap:opencode', outcomes: 12, wins: 7, win_pct: 58 }] });
  const { unmount } = render(<OperatorCockpitPage />);
  expect(await screen.findByText('g-abc123')).toBeTruthy();
  expect(screen.getByText('58%')).toBeTruthy(); expect(screen.getByText('12')).toBeTruthy();
  unmount();
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValueOnce(base);
  render(<OperatorCockpitPage />);
  expect(await screen.findByText('No production-maker outcome carries a genome yet.')).toBeTruthy();
});

it('shows the error when the endpoint fails', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockRejectedValue(new Error('Access denied'));
  render(<OperatorCockpitPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('Access denied');
});

it('W3: shows what needs the operator with links into /decisions, and a calm line when nothing does', () => {
  const html = renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 2, requeue: 0, labels: 22, memory_review: 1 }} /></MemoryRouter>);
  expect(html).toContain('Needs you (25)');
  expect(html).toContain('href="/decisions#approvals"');
  expect(html).toContain('22 pre-screen labels');
  expect(html).not.toContain('requeue candidates');
  expect(renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 0, requeue: 0, labels: 0, memory_review: 0 }} /></MemoryRouter>)).toContain('Nothing needs you right now');
});

it('UX-6: shows every blocking category with a deep link; /decisions links point at ids that exist on the Decisions page', async () => {
  const n = { approvals: 2, requeue: 1, labels: 0, memory_review: 1, proposals: 3, draft_prs: 4, stalls: 1, approvals_expiring: 1, join_requests: 1, shell_requests: 2 };
  const html = renderToStaticMarkup(<MemoryRouter><NeedsYou n={n} /></MemoryRouter>);
  expect(html).toContain('Needs you (11)'); // 2+1+1+3+1+1+2 — expiring and unsettled PRs are not double-counted
  for (const t of ['3 proposals awaiting approval', '4 loop PRs unsettled', '1 silent stalls', '1 Commons join requests', '2 fleet shell requests', '1 approvals expiring within 1 h']) expect(html).toContain(t);
  const anchors = [...html.matchAll(/href="\/decisions#([a-z-]+)"/g)].map((m) => m[1]);
  expect(new Set(anchors)).toEqual(new Set(['approvals', 'requeue', 'memory', 'draft-prs']));
  const fs = await import('node:fs'); const path = await import('node:path');
  const src = ['DecisionsInboxPage.tsx', 'ApprovalQueuePage.tsx'].map((f) => fs.readFileSync(path.join(process.cwd(), 'src/pages', f), 'utf8')).join('\n');
  for (const a of [...anchors, 'prescreen']) expect(src).toContain(`id="${a}"`);
});

it('honest needs-you: open loop draft PRs wait for the operator and count; unsettled ones stay informational', () => {
  const html = renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 1, requeue: 0, labels: 0, memory_review: 0, draft_prs: 5, open_prs: 3 }} /></MemoryRouter>);
  expect(html).toContain('Needs you (4)');
  expect(html).toContain('3 open loop PRs');
  expect(html).toContain('5 loop PRs unsettled');
  expect(renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 0, requeue: 0, labels: 0, memory_review: 0, open_prs: 2 }} /></MemoryRouter>)).toContain('Needs you (2)');
});

it('UX-8: the cockpit shows how many schedulers are armed', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue({
    at: '2026-10-06T12:00:00Z', build: { commit: null, build_time: null }, scorecard: {}, guardrails: [], stalls: [], gym: [], remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [],
    schedulers: { armed: 9, off: 5 },
  });
  render(<OperatorCockpitPage />);
  expect(await screen.findByText('Schedulers: 9 armed, 5 off')).toBeTruthy();
});

it('honest cockpit: tokens per verified change, stale gym species, gym vs production genomes, a 404 is not "up"', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue({
    at: '2026-10-08T12:00:00Z', build: { commit: null, build_time: null },
    scorecard: { tokens_per_verified_change_7d: 2_415_385 }, guardrails: [], stalls: [], remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [],
    gym: [
      { species: 'atomic@llama-router', outcomes: 3, successes: 3, success_pct: 100, avg_seconds: 60, avg_tokens: 0, last: '2026-10-08T10:00:00Z', benched: false, stale: false },
      { species: 'pi@qwen', outcomes: 40, successes: 20, success_pct: 50, avg_seconds: 60, avg_tokens: 0, last: '2026-10-01T10:00:00Z', benched: false, stale: true },
    ],
    genomes: [
      { genome: 'g-prod', skill_id: 'loop-maker:test-gap:opencode', scope: 'production', outcomes: 4, wins: 1, win_pct: 25 },
      { genome: 'g-gym', skill_id: 'loop-maker:gym:atomic', scope: 'gym', outcomes: 30, wins: 27, win_pct: 90 },
    ],
  });
  render(<OperatorCockpitPage />);
  expect(await screen.findByText('Tokens per verified change (7 d, maker + reviewers)')).toBeTruthy();
  expect(screen.queryByText('Tokens per outcome (7 d)')).toBeNull();
  expect(screen.getByText('stale')).toBeTruthy();
  expect(screen.getByText('active')).toBeTruthy();
  expect(screen.queryByText('Strategy genomes on real makers (30 d)')).toBeNull();
  const production = screen.getByRole('table', { name: 'Production-maker outcomes per strategy genome' });
  const gym = screen.getByRole('table', { name: 'Gym-maker outcomes per strategy genome' });
  expect(production.textContent).toContain('g-prod'); expect(production.textContent).not.toContain('g-gym');
  expect(gym.textContent).toContain('g-gym'); expect(gym.textContent).not.toContain('g-prod');
  expect(await screen.findByText('reachable (404)')).toBeTruthy();
  expect(screen.queryByText('up')).toBeNull();
});
