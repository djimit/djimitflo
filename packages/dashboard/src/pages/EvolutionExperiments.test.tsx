import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperimentsSection } from './EvolutionExperiments';
import type { EvolutionEvidence } from '../lib/api';

afterEach(() => cleanup());

// L6-04: the registered experiments, each with its own evidence section and learning-ledger rows, read-only
type Exp = NonNullable<EvolutionEvidence['experiments']>['experiments'][number];
const power = (p: Partial<Exp['power']> = {}): Exp['power'] => ({ n_so_far: null, target_per_arm: null, days_to_stop: null, accrual_window_days: null, accrual_per_day: null,
  projected_min_arm_n: null, projected_reaches_target: null, ...p });
const exp = (e: Partial<Exp> & Pick<Exp, 'id'>): Exp => ({ flag: `${e.id}_MODE`, protocol: `docs/research/${e.id}.md`, started_at: '2026-10-12T00:00:00.000Z', target_n: 50,
  stop_by: '2026-11-15T00:00:00.000Z', stop_note: 'stop condition added 2026-10-19', stop_source: `docs/research/${e.id}.md#amendment`, population: 'oracle_goals',
  n_per_arm: null, min_arm_n: null, verdict: null, overdue: false, overdue_reason: null, power: power(), ...e });

const EMPTY = { experiments: undefined } as unknown as EvolutionEvidence;

const EXPERIMENTS: Exp[] = [
  exp({ id: 'ACE-001', n_per_arm: { '00': 3, '01': 2, '10': 0, '11': 1 }, min_arm_n: 0,
    effects: { kb_retrieval: { metric: 'verified rate, factor on − off (interim, descriptive)', estimate: null, ci: null, p: null } } }),
  exp({ id: 'MAKER-DEPS-001', started_at: '2026-10-01T00:00:00.000Z', target_n: 10, stop_by: '2026-12-16T00:00:00.000Z', n_per_arm: { A: 12, B: 10 }, min_arm_n: 10,
    overdue: true, overdue_reason: 'every arm reached target 10 without a verdict',
    approved_over_limit: 'running before the G1.5 WIP limit existed (2026-10-19); finishes under its registered stop_by',
    effects: { deps_prep: { metric: 'ITT verified rate, B − A; cluster-bootstrap 95 % CI (descriptive)', estimate: 0.042, ci: [-0.11, 0.19], p: null } } }),
  exp({ id: 'F2', verdict: 'reversed', n_per_arm: { same: 40, cross: 40 }, min_arm_n: 40, target_n: 40,
    effects: { checker_family: { metric: 'Δkappa cross − same on outcome_wo_checker (final); seeded bootstrap 95 % CI', estimate: -0.21, ci: [-0.4, -0.02], p: 0.03 } } }),
  exp({ id: 'TG-001', population: 'gym_tasks', started_at: '2026-10-11T23:20:22.000Z', target_n: 20, n_per_arm: { A: 20, B: 20 }, min_arm_n: 20 }),
];
const LEDGER: NonNullable<EvolutionEvidence['learning_ledger']> = {
  loops_closed: { k: 0, n: 3, headline: 'loops closed 0/3' }, by_status: { ADOPTED: 0, REJECTED: 1, RUNNING: 2, INSUFFICIENT: 0, NOT_MEASURED: 0 }, note: '',
  mechanisms: [
    { mechanism: 'kb_retrieval', name: 'KB retrieval', data_source: 'ace', experiment: 'ACE-001', metric: 'verified rate, factor on − off (interim, descriptive)', estimate: null, ci: null, p: null, status: 'RUNNING', closed: false, note: 'ACE-001: n per arm …' },
    { mechanism: 'deps_prep', name: 'Maker dependency preparation', data_source: 'deps', experiment: 'MAKER-DEPS-001', metric: 'ITT', estimate: 0.042, ci: [-0.11, 0.19], p: null, status: 'RUNNING', closed: false, note: '' },
    { mechanism: 'checker_family', name: 'Checker family', data_source: 'f2', experiment: 'F2', metric: 'Δkappa', estimate: -0.21, ci: [-0.4, -0.02], p: 0.03, status: 'REJECTED', closed: false, note: '' },
  ],
};
const cfCmp = { delta_kappa: null, delta_kappa_ci: null, fisher_p: 1, n: { same: 0, cross: 0 } };
const DATA = {
  at: '2026-10-24T00:00:00.000Z', window_days: 7,
  experiments: { experiments: EXPERIMENTS, overdue: ['MAKER-DEPS-001'], no_stop_date: [], note: '',
    wip: { population: 'oracle_goals', limit: 4, active: ['ACE-001', 'MAKER-DEPS-001'], active_count: 2, over_wip_limit: false, counted: ['ACE-001'],
      approved_over_limit: [{ id: 'MAKER-DEPS-001', reason: 'running before the G1.5 WIP limit existed (2026-10-19); finishes under its registered stop_by' }], guard_ok: true } },
  learning_ledger: LEDGER,
  ace_001: { mode: 'on', target_per_arm: 50, status: 'collecting', analysis_since: '2026-10-17T00:00:00.000Z', delivery_invalid: 9,
    delivery: { per_arm: {}, retrieval_rate: null, examples_rate: 0.8, fallback_reasons: { no_kb_hit: 2 } },
    arms: { '00': { n: 3, verified: 1, verified_rate: 0.333, ci: [0.06, 0.79], graded_n: 0, graded_mean: null, tokens_mean: null },
      '01': { n: 2, verified: 1, verified_rate: 0.5, ci: [0.09, 0.91], graded_n: 0, graded_mean: null, tokens_mean: null },
      '10': { n: 0, verified: 0, verified_rate: null, ci: null, graded_n: 0, graded_mean: null, tokens_mean: null },
      '11': { n: 1, verified: 0, verified_rate: 0, ci: [0, 0.79], graded_n: 0, graded_mean: null, tokens_mean: null } },
    main_effects: { retrieval: { on_n: 1, off_n: 5, diff: null }, examples: { on_n: 3, off_n: 3, diff: null } }, note: '' },
  maker_deps_001: { experiment: 'MAKER-DEPS-001', version: 'v1', mode: 'on', target_per_arm: 10, status: 'analysable', diff: 0.042, diff_ci_descriptive: [-0.11, 0.19],
    arms: { A: { goals: 14, terminal: 12, verified: 6, regressed: 6, censored: 2, verified_rate: 0.5, preparations: 0, preparation_failed: 0, maker_leases: 14, maker_failed: 1, maker_timed_out: 0, tokens_mean: null },
      B: { goals: 11, terminal: 10, verified: 5, regressed: 5, censored: 1, verified_rate: 0.5, preparations: 11, preparation_failed: 1, maker_leases: 11, maker_failed: 0, maker_timed_out: 0, tokens_mean: null } }, note: '' },
  checker_family: { enabled: 'true', cross_model: 'kimi-k3', target_per_arm: 40, version: 'v2', versions: { v1: { label: 'closed 17-10 interim', closed: true, evidence: {} } },
    same: {}, cross: {}, weak_fisher_p: 1,
    primary: { ...cfCmp, delta_kappa: -0.21, delta_kappa_ci: [-0.4, -0.02], fisher_p: 0.03, n: { same: 40, cross: 40 }, endpoint: 'outcome_wo_checker', read: 'final' },
    secondary_circular: { ...cfCmp, delta_kappa: 0.05, delta_kappa_ci: [-0.1, 0.2], n: { same: 40, cross: 40 }, endpoint: 'outcome', circular: true },
    stop: { per_arm: 40, reached: true, verdict: 'reversed' }, note: '' },
  tg_001: { mode: 'on', experiment_id: 'TG-001-r2', generation: 'r2', status: 'complete', tasks: 20, skipped: 0,
    prior_generations: [{ generation: 'r1', experiment_id: 'TG-001', status: 'ABORTED_DATA_LOSS', frozen_at: '', first_attempt_at: '', attempts_executed: '', cause: 'provider rollback', pooled: false }],
    arms: [{ arm: 'A', name: 'gym', n: 20, success: 9, rate: 0.45, ci95: [0.26, 0.66], failures: {}, tokens_mean: null, tokens_known: 0, duration_ms_mean: null, pending: 0, invalid: 1, infra_censored: 2 }],
    paired: [{ arms: 'A-B', n_pairs: 19, effect: null, ci95: null, mcnemar_exact_p: null, excluded_tasks: 1 }],
    prior_exposure: { exposed: 19, unexposed: 1, prior_attempts: 40 },
    result: { verdict: 'inconclusive', falsified: null, supported: null, not_tested: [], next_experiment: null } },
} as unknown as EvolutionEvidence;

const rowText = (container: HTMLElement, id: string) => container.querySelector(`[data-experiment="${id}"]`)?.textContent ?? '';
const detailText = (container: HTMLElement, id: string) => container.querySelector(`[data-experiment-detail="${id}"]`)?.textContent ?? '';

it('renders an honest empty state when the server did not report the experiment registry', () => {
  expect(renderToStaticMarkup(<ExperimentsSection data={EMPTY} />)).toContain('Experiment registry not reported by this server.');
});

it('one row per registered experiment shows running, overdue, closed and interim states truthfully; reaching target is never "supported"', () => {
  const { container } = render(<ExperimentsSection data={DATA} />);
  const rows = within(container).getAllByRole('row');
  // 1 header + 2 rows (data + detail) per experiment
  expect(rows.length).toBe(1 + EXPERIMENTS.length * 2);
  expect(rowText(container, 'ACE-001')).toContain('running');
  expect(rowText(container, 'ACE-001')).toContain('00 3 · 01 2 · 10 0 · 11 1 / target 50');
  expect(rowText(container, 'MAKER-DEPS-001')).toContain('overdue');
  expect(rowText(container, 'MAKER-DEPS-001')).toContain('every arm reached target 10 without a verdict');
  expect(rowText(container, 'F2')).toContain('closed — verdict reversed');
  expect(rowText(container, 'TG-001')).toContain('interim result inconclusive — not a closing verdict');
  expect(container.textContent).toContain('2 active on oracle goals (limit 4): 1 counted, 1 grandfathered exception(s) — guard ok');
  expect(container.textContent).not.toMatch(/supported/i);
});

it('a null effect, CI or rate reads "not computed" / "unknown", never 0; each section states its own window', () => {
  const { container } = render(<ExperimentsSection data={DATA} />);
  const ace = detailText(container, 'ACE-001');
  expect(ace).toContain('estimate not computed');
  expect(ace).toContain('no CI computed');
  expect(ace).not.toMatch(/estimate 0(\.0+)?\b/);
  expect(ace).toContain('retrieval delivery unknown'); // null delivery rate
  expect(ace).toContain('examples delivery 80 %');
  expect(ace).toContain('arm 10: n = 0, verified rate unknown'); // null rate on an empty arm is not 0 %
  expect(ace).toContain('section counts from analysis_since 2026-10-17 (Amendment 1); 9 earlier outcomes excluded');
  expect(detailText(container, 'MAKER-DEPS-001')).toContain('section counts the last 7 d only (from 2026-10-17); the registry row counts from 2026-10-01');
  expect(detailText(container, 'MAKER-DEPS-001')).toContain('evidence status analysable — target reached, no analysis verdict recorded');
  expect(detailText(container, 'TG-001')).toContain('section is not windowed (whole experiment)');
  expect(detailText(container, 'TG-001')).toContain('A-B: n pairs 19, effect not computed, no CI computed');
});

it('the learning ledger shows mechanism, effect, CI and status; closed versions and prior generations are labelled as the evidence says', () => {
  const { container } = render(<ExperimentsSection data={DATA} />);
  expect(detailText(container, 'ACE-001')).toContain('KB retrieval (kb_retrieval): RUNNING — estimate not computed, no CI computed');
  expect(detailText(container, 'F2')).toContain('Checker family (checker_family): REJECTED — estimate -0.210, CI [-0.400, -0.020]');
  expect(detailText(container, 'F2')).toContain('secondary, circular — contains the checker\'s own rejection');
  expect(detailText(container, 'F2')).toContain('v1 (closed 17-10 interim) reported apart, never pooled');
  expect(detailText(container, 'TG-001')).toContain('r1 ABORTED_DATA_LOSS — never pooled');
  expect(container.textContent).toContain('loops closed 0/3');
});
