import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import type { ProjectRoomDossier } from '../../lib/api';
import { ProjectRoomBody } from './ProjectRoom';

const base: ProjectRoomDossier = {
  mode: 'on', selected: true, variant: 'two_stage',
  goal: { id: 'g1', objective: 'sum must add its arguments', constraints: ['keep the signature'], acceptance_criteria: ['sum(2, 3) returns 5'], status: 'running', budget: {}, proposal_id: null,
    source: { slug: 'r', base_commit: 'abcdef0123456789', local_changes_digest: null }, tokens_used_by_room: 3000, max_tokens: 100000 },
  review: { version: 1, claims: [{ id: 'c1', claim: 'sum subtracts', refs: [{ path: 'sum.js' }], refs_resolved: true }, { id: 'c2', claim: 'results are cached', refs: [{ path: 'cache.js' }], refs_resolved: false }],
    open_questions: ['negative numbers?'], assumptions: [], proposal: 'change one operator' },
  plan: { plan_id: 'plan:g1', version: 2, digest: 'd'.repeat(64), versions: [{ version: 1, digest: 'a', created_at: '' }, { version: 2, digest: 'b', created_at: '' }], decisions: ['change the operator'], open_questions: [], uncertainties: [],
    findings_review: [{ claim_id: 'c2', status: 'rejected', note: '' }], steps: [{ id: 's1', title: 'make sum add', depends_on: [], scope: ['sum.js'], expected_artifacts: [], verification: ['test:changed'] }] },
  calls: [],
  execution: [{ run_id: 'run-12345678', status: 'running', events: [], pr_url: null, outcome_verified: null, survival: 'UNKNOWN', leases: [
    { id: 'l1', role: 'maker', runtime: 'codex', status: 'prepared', superseded: false, task: { id: 't1', status: 'running' }, plan: { plan_id: 'plan:g1', version: 1, delivered: true, loaded: null },
      checks: [{ name: 'test', status: 'pass' }], verdict: null, maker_lease_id: null,
      agent: { id: 'a1', name: 'codex-maker', capabilities: ['codex', 'maker'] }, identity: { model: 'gpt-x', provider: null, model_family: null, genome_id: null },
      context: [{ name: 'memory_rules', ids: ['r1', 'r2'] }], skill: { capability_id: 'cap-1', version: '3', state: 'invoked_ok', invoked: null },
      capability: { credited_id: null, runner_decision: null }, trace: { id: 'tr', spans: 2, span_errors: 1, steps: [], task: { task_id: 't1', events: null, errors: null, admission: null } } }] }],
  call_tasks: [], authority_events: null, commons_review: null,
  candidates: [], gaps: [],
};

it('shows goal, findings, plan, execution, checks and outcome, with claims and verified facts kept apart', () => {
  render(<MemoryRouter><ProjectRoomBody dossier={base} /></MemoryRouter>);
  expect(screen.getByText('sum must add its arguments')).toBeTruthy();
  expect(screen.getByText('abcdef012345')).toBeTruthy();
  expect(screen.getByText('3000 of 100000')).toBeTruthy();
  expect(screen.getByText('source found')).toBeTruthy();
  expect(screen.getByText('source not found')).toBeTruthy();
  expect(screen.getByText('version 2 of 2')).toBeTruthy();
  expect(screen.getByText('make sum add')).toBeTruthy();
  // a prepared lease whose engine task already runs shows both facts
  expect(screen.getByText('prepared (task running)')).toBeTruthy();
  // delivered is proven, loaded was not measured: never shown as yes or no
  expect(screen.getByText('delivered: yes · loaded: not measured')).toBeTruthy();
  expect(screen.getByText('test: pass')).toBeTruthy();
  expect(screen.getByText('not settled')).toBeTruthy();
  expect(screen.getByText('unknown (no pull request to observe)')).toBeTruthy();
  // wiring: who ran, what it was given, which skill, and where the trace is; a missing record is named, never shown as zero
  expect(screen.getByText('maker · codex-maker')).toBeTruthy();
  expect(screen.getByText('memory rules (2)')).toBeTruthy();
  expect(screen.getByText('cap-1@3 · run by the maker: not measured')).toBeTruthy();
  expect(screen.getByText('not recorded')).toBeTruthy(); // runner decision
  expect(screen.getByText('events not recorded').getAttribute('href')).toBe('/tasks/t1');
  expect(screen.getByText(/Authority decisions for this goal: not recorded/)).toBeTruthy();
});

it('names what is missing and the next action instead of showing an empty or passing state', () => {
  render(<MemoryRouter><ProjectRoomBody dossier={{ ...base, review: null, plan: null, execution: [],
    gaps: [{ what: 'plan', reason: 'no valid plan issued', next_action: 'runs before the next maker for this goal' }] }} /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toContain('plan: no valid plan issued. Next: runs before the next maker for this goal.');
  expect(screen.getByText('No plan issued.')).toBeTruthy();
  expect(screen.getByText('No worker has been started for this goal.')).toBeTruthy();
  expect(screen.getByText('No run yet.')).toBeTruthy();
  expect(screen.queryByText('verified')).toBeNull();
});
