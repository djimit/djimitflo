import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CommandStrip, EfficiencySection, NeedsYou, OperatorCockpitPage, overallHealth, type CockpitView } from './OperatorCockpitPage';
import { api } from '../lib/api';

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(api, 'getServiceMap').mockResolvedValue({ services: [
  { names: ['event bus'], endpoint: 'http://100.86.47.122:8083', status: 'up', http: 404, ms: 12, error: null },
  { names: ['LiteLLM'], endpoint: 'http://192.168.1.28:4000', status: 'down', http: null, ms: null, error: 'timeout' },
] }); });

it('shows breached guardrails, stalls and gym species from the cockpit endpoint', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue({
    at: '2026-09-28T20:00:00Z', build: { commit: 'f9f481ad3eb5', build_time: null },
    scorecard: { verified_7d: 11, regressed_7d: 5 },
    guardrails: [{ name: 'regressions', ok: false, value: 5, limit: '<= verified/5 (2.2)', split: { maker: 2, reviewer: 3, environment: 0 } }],
    stalls: [{ subsystem: 'gym:atomic@llama-router', since: null, detail: 'no outcome for 9 h' }],
    gym: [{ species: 'atomic', outcomes: 27, successes: 24, success_pct: 89, avg_seconds: 588, avg_tokens: 0, last: '2026-09-28T08:53:00Z' }],
    remote_workers: [], maker_usage_7d: [], judgments_7d: [],
    deploys: [{ at: '2026-09-28T18:43:09Z', event: 'verdict_ok', sha: 'f9f481ad3eb5', detail: '' }],
  });
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
  expect(await screen.findByText('breached · limit <= verified/5 (2.2)')).toBeTruthy();
  expect(screen.getByText('maker 2 · reviewer 3 · environment 0')).toBeTruthy(); // funnel phase 3: whose regressions
  expect(screen.getAllByText('gym:atomic@llama-router').length).toBeGreaterThan(0); // command strip + stalls section
  expect(screen.getByText('89%')).toBeTruthy();
  expect(screen.getByText('No remote host has claimed work.')).toBeTruthy();
  expect(screen.getByText('verdict ok')).toBeTruthy();
  expect(await screen.findByText('down (timeout)')).toBeTruthy();
});

it('UX-2: shows real-maker outcomes per strategy genome with n, and an honest empty state', async () => {
  const base = { at: '2026-10-04T20:00:00Z', build: { commit: null, build_time: null }, scorecard: {}, guardrails: [], stalls: [], gym: [], remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [] };
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValueOnce({ ...base, genomes: [{ genome: 'g-abc123', skill_id: 'loop-maker:test-gap:opencode', outcomes: 12, wins: 7, win_pct: 58 }] });
  const { unmount } = render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
  expect(await screen.findByText('g-abc123')).toBeTruthy();
  expect(screen.getByText('58%')).toBeTruthy(); expect(screen.getByText('12')).toBeTruthy();
  unmount();
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValueOnce(base);
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
  expect(await screen.findByText('No production-maker outcome carries a genome yet.')).toBeTruthy();
});

it('shows the error when the endpoint fails', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockRejectedValue(new Error('Access denied'));
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
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
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
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
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
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

it('E3: the Efficiency section shows tokens, GPU time, measured vs not-measured energy, value with intervals and the north star', async () => {
  const consumer = { local_tokens: 0, gpu_seconds: 0, jobs: 0, wh: null, energy: 'not_measured' as const, energy_coverage: null, verified: null, attempts: null, lanes: null, per_m_tokens: null, per_kwh: null };
  vi.spyOn(api, 'getEfficiency').mockResolvedValue({
    at: '2026-10-08T12:00:00Z', window_days: 7, ledger_enabled: true,
    consumers: [
      { ...consumer, consumer: 'maker:opencode@glm-5', cloud_tokens: 39_300_000, verified: 26, attempts: 60, lanes: { 'test-gap': 20, exports: 6 },
        per_m_tokens: { value: 0.66, low: 0.48, high: 0.86, n: 60 } },
      { ...consumer, consumer: 'gym:atomic@llama-router', cloud_tokens: 0, gpu_seconds: 55_440, jobs: 115, wh: 4_620, energy: 'measured', energy_coverage: 0.97 },
      { ...consumer, consumer: 'maker:remote@ws/atomic@llama-router', cloud_tokens: 0, local_tokens: 400_000, gpu_seconds: 3_600, jobs: 3, wh: 120, energy: 'partial', energy_coverage: 0.5, verified: 2, attempts: 3,
        per_m_tokens: null },
      { ...consumer, consumer: 'committee', cloud_tokens: 0, gpu_seconds: 4_680, jobs: 26 },
    ],
    ledger: [],
    hosts: [{ host: 'workstation', samples: 20_000, last_sample: '2026-10-08T11:59:30Z', avg_watts: 180.2, gpu_kwh: 6.42, covered_h: 166.5 }],
    north_star: { weeks: [
      { week_start: '2026-10-01', verified: 26, cloud_m_tokens: 62.8, local_kwh: 6.42, local_covered_h: 166.5, per_m_tokens: 0.414, per_kwh: 4.05 },
      { week_start: '2026-09-24', verified: 18, cloud_m_tokens: 70.1, local_kwh: null, local_covered_h: 0, per_m_tokens: 0.257, per_kwh: null },
    ] },
    notes: ['Energy is GPU package power from the host agent.'],
  });
  render(<EfficiencySection />);
  expect(await screen.findByRole('heading', { name: 'Efficiency (7 d)' })).toBeTruthy();
  const consumers = screen.getByRole('table', { name: 'Resources and value per consumer' });
  expect(consumers.textContent).toContain('39.30'); // cloud M tokens
  expect(consumers.textContent).toContain('26/60 (test-gap 20, exports 6)');
  expect(consumers.textContent).toContain('0.66 [0.48–0.86]');
  expect(consumers.textContent).toContain('15.4'); // GPU-h of the gym
  expect(consumers.textContent).toContain('4,620 Wh');
  expect(consumers.textContent).toContain('≥ 120 Wh (50 % sampled)');
  expect(consumers.textContent).toContain('not measured'); // committee: jobs without power samples, never a guessed figure
  const weeks = screen.getByRole('table', { name: 'North star per week' });
  expect(weeks.textContent).toContain('0.41'); expect(weeks.textContent).toContain('4.05'); expect(weeks.textContent).toContain('not measured');
  expect(screen.getByRole('table', { name: 'Measured GPU energy per host' }).textContent).toContain('6.42');
  expect(screen.queryByText(/RESOURCE_LEDGER_ENABLED/)).toBeNull();
});

it('E3: says energy is not measured while power sampling is off, and degrades quietly when the endpoint fails', async () => {
  vi.spyOn(api, 'getEfficiency').mockResolvedValueOnce({ at: '2026-10-08T12:00:00Z', window_days: 7, ledger_enabled: false, consumers: [], ledger: [], hosts: [],
    north_star: { weeks: [{ week_start: '2026-10-01', verified: 0, cloud_m_tokens: 0, local_kwh: null, local_covered_h: 0, per_m_tokens: null, per_kwh: null }] }, notes: [] });
  const { unmount } = render(<EfficiencySection />);
  expect(await screen.findByText('RESOURCE_LEDGER_ENABLED')).toBeTruthy();
  expect(screen.getByText('No host has reported GPU power yet.')).toBeTruthy();
  unmount();
  vi.spyOn(api, 'getEfficiency').mockRejectedValueOnce(new Error('Access denied'));
  render(<EfficiencySection />);
  expect(await screen.findByText('Efficiency view unavailable.')).toBeTruthy();
});

const snap = (over: Partial<CockpitView> = {}): CockpitView => ({ at: new Date().toISOString(), build: { commit: null, build_time: null },
  scorecard: { verified_7d: 3, regressed_7d: 1 }, guardrails: [{ name: 'regressions', ok: true, value: 0, limit: '<= 0.6' }], stalls: [], gym: [],
  remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [], ...over });

it('Cockpit 3.0: an UNKNOWN guardrail (or a null value from an old server that said ok) never renders healthy', () => {
  expect(overallHealth(snap()).state).toBe('HEALTHY');
  const oldServer = snap({ guardrails: [{ name: 'panel unparseable (7 d)', ok: true, value: null, limit: '0' }] }); // failed SQL → null, old server said ok
  expect(overallHealth(oldServer).state).toBe('UNKNOWN');
  expect(overallHealth(snap({ guardrails: [{ name: 'x', ok: true, value: 1, limit: '', state: 'UNKNOWN' }] })).state).toBe('UNKNOWN');
  expect(overallHealth(snap({ guardrails: [] })).state).toBe('UNKNOWN');
  expect(overallHealth(snap({ errors: [{ section: 'gym', message: 'no such table' }] })).state).toBe('UNKNOWN');
  expect(overallHealth(snap({ health: 'HEALTHY', guardrails: [{ name: 'r', ok: false, value: 9, limit: '' }] })).state).toBe('BREACHED');
  expect(overallHealth(snap({ at: '2026-01-01T00:00:00Z' })).state).toBe('STALE');
  const html = renderToStaticMarkup(<MemoryRouter><CommandStrip d={oldServer} /></MemoryRouter>);
  expect(html).toContain('unknown'); expect(html).not.toContain('>healthy<');
  expect(html).toContain('throughput, not intelligence'); expect(html).toContain('href="/evolution"');
});

it('Cockpit 3.0: null needs-you counts render as unknown, never as a calm zero', () => {
  const html = renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: null, requeue: 0, labels: 0, memory_review: 0 }} /></MemoryRouter>);
  expect(html).toContain('Needs you: unknown'); expect(html).toContain('Could not count: approvals');
  expect(html).not.toContain('Nothing needs you right now');
  expect(renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 2, requeue: null, labels: 0, memory_review: 0 }} /></MemoryRouter>)).toContain('Needs you (≥ 2)');
  expect(renderToStaticMarkup(<MemoryRouter><CommandStrip d={snap({ needs_you: undefined })} /></MemoryRouter>)).toMatch(/What needs you\?.*unknown/);
});

it('Cockpit 3.0: a partial failure shows the errors banner and the page still renders old-server payloads', async () => {
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue(snap({ errors: [{ section: 'judgments_7d', message: 'no such table: judgments' }], snapshot_id: 's1' }) as never);
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('judgments_7d'); expect(alert.textContent).toContain('not as healthy');
  expect(screen.getByRole('status').textContent).toContain('unknown');
});

it('Cockpit 3.0: a slower older response never overwrites a newer one', async () => {
  let resolveOld: (v: CockpitView) => void = () => {};
  const spy = vi.spyOn(api, 'getOperatorCockpit')
    .mockImplementationOnce(() => new Promise((r) => { resolveOld = r as never; }) as never)
    .mockResolvedValueOnce(snap({ build: { commit: 'newer000aaaa', build_time: null } }) as never);
  render(<MemoryRouter><OperatorCockpitPage /></MemoryRouter>);
  (await screen.findByRole('button', { name: /refresh/i })).click();
  expect(await screen.findByText('newer000')).toBeTruthy();
  resolveOld(snap({ build: { commit: 'older111bbbb', build_time: null } }));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('older111')).toBeNull(); expect(spy).toHaveBeenCalledTimes(2);
});

it('Cockpit 3.0: the server total wins and system-side requeue candidates are shown, not counted', () => {
  const deduped = renderToStaticMarkup(<MemoryRouter><NeedsYou n={{ approvals: 0, requeue: 1, labels: 1, memory_review: 0, total: 1,
    system_requeue: { budgeted_requeue: 22, attribution_unknown: 17, not_actionable: 3 } }} /></MemoryRouter>);
  expect(deduped).toContain('Needs you (1)');
  expect(deduped).toContain('22 budgeted requeue');
});
