import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FitnessContractsCard } from './EvolutionFitness';
import type { FitnessContractRow, FitnessContractsReport } from '../lib/api';

afterEach(() => cleanup());

const row = (r: Partial<FitnessContractRow> & Pick<FitnessContractRow, 'component' | 'status'>): FitnessContractRow => ({
  class: 'maker', name: r.component, unit: 'one run', flags: [], outcome: { metric: 'verified', source: 'self_improvements.status', independence: 'independent' },
  cost: { tokens: null, kwh: null, operator_minutes: null }, comparison: { kind: 'none', ref: null }, decision_rule: null, inheritance: null, note: '', ledger_status: null, ...r,
});
const REPORT: FitnessContractsReport = {
  total: 3, by_status: { closed_loop: 1, measured_no_selection: 0, circular: 1, unmeasured: 1 },
  coverage: { acting_flags: 10, mapped: 7, exempt: 3, unmapped: [] }, violations: [], note: 'static registry',
  contracts: [
    row({ component: 'expert_units', name: 'Expert units', status: 'unmeasured', outcome: { metric: 'none', source: 'none', independence: 'none' } }),
    row({ component: 'gym_genomes', name: 'Gym genomes', status: 'closed_loop', comparison: { kind: 'holdout', ref: 'gym_holdout' }, decision_rule: 'McNemar p < alpha',
      cost: { tokens: 'llm_model_calls', kwh: null, operator_minutes: null } }),
    row({ component: 'specialist_panel', name: 'Specialist panel', status: 'circular', outcome: { metric: 'approve rate', source: 'specialist_reviews', independence: 'circular' }, ledger_status: 'NOT_MEASURED' }),
  ],
};

it('counts by status and acting-flag coverage; closed loops listed first, missing values read none / not recorded', () => {
  render(<FitnessContractsCard data={REPORT} />);
  const card = screen.getByTestId('fitness-contracts');
  expect(card.textContent).toContain('3 components: 1 closed loop · 0 measured, no selection · 1 circular outcome · 1 unmeasured');
  expect(card.textContent).toContain('7 under a contract, 3 exempt');
  expect(card.textContent).toContain('none without a contract');
  const rows = within(card).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.getAttribute('data-fitness'))).toEqual(['gym_genomes', 'specialist_panel', 'expert_units']);
  expect(rows[0].textContent).toContain('holdout (gym_holdout)');
  expect(rows[0].textContent).toContain('tokens');
  expect(rows[2].textContent).toContain('not recorded');
  expect(rows[1].textContent).toContain('approve rate (circular)');
  expect(rows[1].textContent).toContain('NOT_MEASURED');
});

it('an acting flag without a contract and registry violations are shown as errors', () => {
  render(<FitnessContractsCard data={{ ...REPORT, coverage: { ...REPORT.coverage, unmapped: ['NEW_FLAG'] }, violations: ['x: closed_loop needs a decision_rule'] }} />);
  const card = screen.getByTestId('fitness-contracts');
  expect(card.textContent).toContain('1 without a contract: NEW_FLAG');
  expect(card.textContent).toContain('Registry violations: x: closed_loop needs a decision_rule');
});
