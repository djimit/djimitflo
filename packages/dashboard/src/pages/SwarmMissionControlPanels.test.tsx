import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { CapabilityCountsLine, EvidenceStrip, LearningCurvePanel, MissionExecutionPanel } from './SwarmMissionControlPage';

afterEach(cleanup);

const tokens = { value: null, events: 0, known: 0, coverage: null, status: 'UNKNOWN' };
const usd = { value: null, reason: 'no usage record' };
// the server's /swarms/learning-curve answer for the audit fixture: completed, failed, completed, no usage records
const auditFixture = {
  runs: [
    { run_id: 'a', created_at: '2026-10-20T01:00:00Z', success: true, retries: 0, dollars: null, loop_name: 'repo-maintenance-loop', status: 'completed', tokens: null, cost_status: 'UNKNOWN' },
    { run_id: 'b', created_at: '2026-10-20T02:00:00Z', success: false, retries: 0, dollars: null, loop_name: 'repo-maintenance-loop', status: 'failed', tokens: null, cost_status: 'UNKNOWN' },
    { run_id: 'c', created_at: '2026-10-20T03:00:00Z', success: true, retries: 0, dollars: null, loop_name: 'repo-maintenance-loop', status: 'completed', tokens: null, cost_status: 'UNKNOWN' },
  ],
  first_vs_last: { first_success_rate: null, last_success_rate: null, first_cost: null, last_cost: null, first_run_success: true, last_run_success: true },
  cohorts: [{ loop_name: 'repo-maintenance-loop', run_class: 'maintenance',
    windows: { prior: { n: 0, completed: 0, rate: null, ci: null, censored: 0, tokens, usd }, recent: { n: 3, completed: 2, rate: 0.667, ci: [0.2, 0.94], censored: 0, tokens, usd } },
    comparison: { status: 'insufficient', delta: null, reason: 'each window needs ≥ 10 terminal runs (prior 0, recent 3)' } }],
  window: { days: 7 }, min_n_per_window: 10, pooled: false,
  registered_readouts: [{ id: 'memory-holdout', stop_by: '2026-10-27T00:00:00.000Z', analysis: 'registered single analysis', causal_conclusion: null }],
};

it('SW-01: the audit 3-run fixture renders 2/3 with n = 3 and unknown cost, not 100% -> 100% and $0', () => {
  render(<MemoryRouter><LearningCurvePanel curve={auditFixture} /></MemoryRouter>);
  const row = screen.getByTestId('cohort-repo-maintenance-loop');
  expect(row.textContent).toContain('maintenance');
  expect(row.textContent).toContain('2/3 (67 %)');
  expect(row.textContent).toContain('n = 3');
  expect(row.textContent).toContain('insufficient');
  expect(row.textContent).toContain('unknown');
  expect(document.body.textContent).not.toMatch(/100% -> 100%/);
  expect(document.body.textContent).not.toMatch(/\$0\.0000/);
  // the binary per-run status stays its own column
  expect(screen.getAllByTestId('run-status').map((n) => n.textContent)).toEqual(['completed', 'failed', 'completed']);
});

it('SW-01: gym, maintenance and production cohorts are listed separately, never pooled', () => {
  const cohort = (loop_name: string, run_class: string, n: number, completed: number) => ({ loop_name, run_class,
    windows: { prior: { n: 0, completed: 0, rate: null, ci: null, censored: 0, tokens, usd }, recent: { n, completed, rate: completed / n, ci: null, censored: 0, tokens, usd } },
    comparison: { status: 'insufficient', delta: null, reason: '' } });
  render(<MemoryRouter><LearningCurvePanel curve={{ ...auditFixture, runs: [], cohorts: [cohort('evolution-gym', 'gym', 4, 1), cohort('repo-maintenance-loop', 'maintenance', 5, 5), cohort('doc-drift-and-small-fix-loop', 'production', 2, 1)] }} /></MemoryRouter>);
  expect(screen.getAllByTestId(/^cohort-/)).toHaveLength(3);
  expect(screen.getByTestId('cohort-evolution-gym').textContent).toContain('1/4');
  expect(screen.queryByText(/all runs/i)).toBeNull();
});

it('SW-02: capability counts name the registry total, the loaded slice and what is shown', () => {
  render(<CapabilityCountsLine health={{ total: 100, loaded: 100, load_limit: 100, registry_total: 512, registry_by_status: { candidate: 35, deprecated: 477 }, validated: 0, routable: 0, blocked: 3 }} shown={3} />);
  expect(screen.getByTestId('capability-counts').textContent).toBe('registry 512 (candidate 35 · deprecated 477) · loaded 100 (latest 100 by update) · shown 3');
});

it('SW-02: an observed mission shows its completed goal and loop execution side by side, with a link to the run', () => {
  render(<MemoryRouter><MissionExecutionPanel data={{
    totals: { registered: 2, loaded: 2, by_planning_status: { observed: 2 }, by_goal_status: { completed: 1, unknown: 1 } },
    missions: [
      { mission_id: 'm-linked', title: 'Linked', planning_status: 'observed', goal_id: 'g-done', lineage: 'linked', goal_status: 'completed',
        execution: { loop_runs: 2, by_status: { failed: 1, completed: 1 }, latest_run: { id: 'run-2', loop_name: 'doc-drift-and-small-fix-loop', status: 'completed', created_at: '2026-10-20T02:00:00Z' }, closed_runs: 1 } },
      { mission_id: 'm-orphan', title: 'Orphan', planning_status: 'observed', goal_id: null, lineage: 'no_goal', goal_status: null, execution: null },
    ],
  }} /></MemoryRouter>);
  const linked = screen.getByTestId('mission-m-linked');
  expect(linked.textContent).toContain('observed');
  expect(linked.textContent).toContain('goal completed');
  expect(linked.textContent).toContain('2 runs');
  expect(linked.textContent).toContain('1 closed');
  expect(screen.getByRole('link', { name: /run-2/ }).getAttribute('href')).toBe('/goals-loops?run=run-2');
  expect(screen.getByTestId('mission-m-orphan').textContent).toContain('lineage unknown');
});

it('SW-08: a small strip links the existing evolution/experiment evidence and states the memory-holdout readout without an effect', () => {
  render(<MemoryRouter><EvidenceStrip readouts={auditFixture.registered_readouts} /></MemoryRouter>);
  expect(screen.getByText(/memory-holdout: readout due 2026-10-27 \(registered single analysis\); no causal conclusion/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Experiments/ }).getAttribute('href')).toBe('/evolution');
  expect(screen.getByRole('link', { name: /Resource coverage/ }).getAttribute('href')).toBe('/usage');
  expect(document.body.textContent).not.toMatch(/p\s*=|Fisher|verified rate/);
});
