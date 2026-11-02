import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { MissionDetail, MissionExecutions } from '../lib/api';
import { MissionDetailPage, MissionDetailView, missionRelationships, tokenText, UNKNOWN, UNRECORDED_MEASURES } from './MissionDetailPage';
import { MissionExecutionPanel } from './SwarmMissionControlPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const detail = (over: Partial<MissionDetail> = {}): MissionDetail => ({
  mission: { id: 'm1', title: 'Docs agree with code', description: '', risk_class: 'low', planning_status: 'observed', goal_id: 'g1', panel_id: null, evidence_refs: [], created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' },
  execution: { mission_id: 'm1', title: 'Docs agree with code', planning_status: 'observed', goal_id: 'g1', lineage: 'linked', goal_status: 'running',
    execution: { loop_runs: 2, by_status: { blocked: 1, completed: 1 }, latest_run: { id: 'run-2', loop_name: 'doc-drift', status: 'blocked', created_at: '2026-10-20T02:00:00Z' }, closed_runs: 1 } },
  goal: { id: 'g1', objective: 'Fix doc drift', status: 'running', updated_at: '2026-10-20T00:00:00Z' },
  runs: [
    { id: 'run-2', loop_name: 'doc-drift', status: 'blocked', created_at: '2026-10-20T02:00:00Z', updated_at: '2026-10-20T02:30:00Z', completed_at: null, failed_gates: ['tests_lint_typecheck'], next_actions: [], closure: null, attribution: null },
    { id: 'run-1', loop_name: 'doc-drift', status: 'completed', created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-20T01:30:00Z', completed_at: '2026-10-20T01:30:00Z', failed_gates: [], next_actions: [],
      closure: { eval_run_id: 'eval-1', score_delta: 0.1, created_at: '2026-10-20T01:35:00Z' }, attribution: { outcome: 'verified', reason: null, created_at: '2026-10-20T01:40:00Z', judgment_id: 'j1' } },
  ],
  leases: [
    { id: 'mk-1', loop_run_id: 'run-1', role: 'maker', runtime: 'codex', status: 'completed', created_at: '2026-10-20T01:01:00Z', verdict: null, maker_lease_id: null },
    { id: 'ck-1', loop_run_id: 'run-1', role: 'checker', runtime: 'claude', status: 'completed', created_at: '2026-10-20T01:02:00Z', verdict: 'accepted', maker_lease_id: 'mk-1' },
  ],
  tasks: [], decisions: [],
  blocker: { text: 'failed gates: tests_lint_typecheck', source: 'loop_runs.gates_json#run-2' },
  next_action: null,
  tokens: { value: 1200, events: 3, known: 1, coverage: 0.333, status: 'partial' },
  provenance: [],
  ...over,
});

const view = (d: MissionDetail) => render(<MemoryRouter><MissionDetailView detail={d} /></MemoryRouter>);

it('shows the unsourced outcome measures as unknown — never 0', () => {
  view(detail());
  const table = screen.getByRole('table', { name: 'Outcome measures without a source yet' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.textContent)).toEqual(UNRECORDED_MEASURES.map((m) => `${m}${UNKNOWN}`));
  expect(table.textContent).not.toMatch(/\b0\b/);
  // a recorded-nothing next action is unknown, the derived blocker names its record
  expect(screen.getByText('unknown — no next action recorded')).toBeTruthy();
  expect(screen.getByText('from loop_runs.gates_json#run-2')).toBeTruthy();
});

it('links every loop run to /goals-loops and shows closure and attribution only where recorded', () => {
  view(detail());
  const runs = screen.getByRole('table', { name: "Loop runs of the mission's goal, newest first" });
  expect(within(runs).getByRole('link', { name: 'run-2' }).getAttribute('href')).toBe('/goals-loops?run=run-2');
  expect(within(runs).getByRole('link', { name: 'run-1' }).getAttribute('href')).toBe('/goals-loops?run=run-1');
  const [, blocked, completed] = within(runs).getAllByRole('row');
  expect(blocked.textContent).toContain('no closure recorded');
  expect(blocked.textContent).toContain(UNKNOWN);
  expect(completed.textContent).toContain('closed · eval eval-1');
  expect(completed.textContent).toContain('verified');
});

it('shows relationships as a typed table and names the types the data does not record', () => {
  view(detail());
  const table = screen.getByRole('table', { name: 'Recorded relationships of the mission' });
  const rows = within(table).getAllByRole('row').slice(1).map((r) => r.querySelector('td')?.textContent);
  expect(rows).toEqual(['participation', 'participation', 'verification']);
  expect(table.textContent).toContain('maker lease mk-1');
  expect(screen.getByText(/Not recorded for this mission: delegation, agreement, reuse\./)).toBeTruthy();
});

it('derives delegation and agreement only from task assignments and quorum decisions', () => {
  const rel = missionRelationships({ leases: [],
    tasks: [{ id: 't1', title: 'Write fix', status: 'running', assigned_lease_id: 'mk-9', capability_id: null }, { id: 't2', title: 'Unassigned', status: 'observed', assigned_lease_id: null, capability_id: null }],
    decisions: [{ id: 'd1', task_id: null, decision_type: 'quorum', decision: 'approve', reason: '', actor: 'panel', blocked_reasons: [], created_at: '' },
      { id: 'd2', task_id: null, decision_type: 'state_transition', decision: 'observed->planned', reason: '', actor: 'system', blocked_reasons: [], created_at: '' }] });
  expect(rel.map((r) => [r.type, r.from, r.to])).toEqual([['delegation', 'task Write fix', 'lease mk-9'], ['agreement', 'panel', 'mission']]);
});

it('reports tokens with coverage, and unknown (not 0) without usage or linked runs', () => {
  expect(tokenText({ value: 1200, events: 3, known: 1, coverage: 0.333, status: 'partial' })).toBe('1,200 tokens (1 of 3 usage records reported; partial — a lower bound)');
  expect(tokenText({ value: null, events: 2, known: 0, coverage: 0, status: 'UNKNOWN' })).toBe('unknown — none of 2 usage records reported tokens');
  expect(tokenText(null)).toBe('unknown — no linked loop runs');
  view(detail({ goal: null, runs: [], leases: [], tokens: null, blocker: null, execution: { ...detail().execution, lineage: 'no_goal', goal_status: null, execution: null } }));
  expect(screen.getByText('unknown — no goal linked')).toBeTruthy();
  expect(screen.getByText('unknown — no blocker recorded')).toBeTruthy();
  expect(screen.getByText('unknown — no linked loop runs')).toBeTruthy();
});

it('renders a heading and a load error (no crash) when the API is down', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  render(<MemoryRouter initialEntries={['/swarm-mission-control/missions/m1']}><Routes><Route path="/swarm-mission-control/missions/:missionId" element={<MissionDetailPage />} /></Routes></MemoryRouter>);
  expect(screen.getByRole('heading', { level: 1, name: 'Mission detail' })).toBeTruthy();
  expect((await screen.findByRole('alert')).textContent).toContain('mission:');
  expect(screen.getByRole('link', { name: 'Back to Mission Control' }).getAttribute('href')).toBe('/swarm-mission-control');
});

it('Mission Control links each mission to its detail page', () => {
  const data: MissionExecutions = { totals: { registered: 1, loaded: 1, by_planning_status: { observed: 1 }, by_goal_status: { running: 1 } }, missions: [detail().execution] };
  render(<MemoryRouter><MissionExecutionPanel data={data} /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Docs agree with code' }).getAttribute('href')).toBe('/swarm-mission-control/missions/m1');
});
