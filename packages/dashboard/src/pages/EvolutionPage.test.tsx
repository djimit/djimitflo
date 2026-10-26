import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvolutionBody, EvolutionPage } from './EvolutionPage';
import { api, type EvolutionEvidence } from '../lib/api';

afterEach(() => vi.restoreAllMocks());

const EMPTY: EvolutionEvidence = {
  at: '2026-10-06T00:00:00Z', window_days: 30, flags: [], outcomes: [], outcomes_tagged: [],
  merge: { settled: [], merge_outcomes: 0, first_settled: null },
  drafts: { unsettled: 0, unsettled_open_or_recent: 0, age_days_p50: null, age_days_max: null, note: '' },
  genomes: { by_status: [], recent: [], holdout: { mined: null, mutant: null } },
  gym: [], trials: { by_state: [], recent: [] },
  models: { mode: 'off', rows: [], would_pick: {} },
  oracle: { n: 0, kappa: null, kappa_ci: null, agreement: { all: null, conf_ge_06: null, conf_lt_06: null }, accuracy: { n: 0, jev: null, checker: null }, kappa_jev_outcome: null, kappa_jev_outcome_ci: null, kappa_checker_outcome: null, enforce_eligible: false, note: '' },
  commons: { k: 0, n: 0, rate: null, ci: [0, 1], base_rate: null, base_ci: [0, 1], base_n: 0, verdict: 'unmeasured', note: '' },
  forecasts_v2: { scored: 0, decision_grade: 0, decision_grade_skilled: 0, insufficient: 0 },
  gates: {
    A: { state: 'unknown', reason: 'no settled trial with diagnostics yet' },
    B: { state: 'red', reason: '0 settled loop PRs; needs ≥ 30 with ≥ 8 per class' },
    C: { state: 'red', reason: '23 loop PRs open or merged < 14 d ago' },
    D: { state: 'green', reason: '1 of 18 forecaster(s) decision-grade' },
  },
};

const FULL: EvolutionEvidence = {
  ...EMPTY,
  flags: [{ name: 'MODEL_SELECTOR_MODE', acting: false, value: 'shadow' }, { name: 'LOOP_BANDIT_ENABLED', acting: true, value: 'true' }],
  outcomes_tagged: [{ skill: 'loop-maker:test-gap:opencode', total: 74, failures: 50, tagged: 12, share: 0.24 }],
  drafts: { unsettled: 23, unsettled_open_or_recent: 23, age_days_p50: 2.9, age_days_max: 10.2, note: '' },
  gym: [{ kind: 'mutant', tier: 5, status: 'success', n: 3 }, { kind: 'mutant', tier: 5, status: 'failure', n: 1 }],
  trials: { by_state: [{ state: 'blind', n: 2 }], recent: [{ trial_id: 'g-abc', parent_id: 'baseline', tier_set: '2,3', deciding_n: 20, f_parent_failures: 2, b: 0, c: 0, p: 1, power_q8_l05: 0, state: 'blind', recorded_at: '2026-10-05T20:00:00Z' }] },
  models: { mode: 'shadow', rows: [{ consumer: 'frontier_experts', model: 'glm-5.3-flash:cloud', n: 7, ok_rate: 1, agree_rate: 0.857, median_latency_ms: 5200, cost_weight: 1 }], would_pick: { frontier_experts: 'kimi-k3:cloud' } },
  oracle: { ...EMPTY.oracle, n: 41, kappa: 0.31, kappa_ci: [0.12, 0.5], agreement: { all: 0.71, conf_ge_06: 0.8, conf_lt_06: 0.5 } },
  commons: { ...EMPTY.commons, k: 1, n: 18, rate: 0.056, ci: [0.001, 0.27] },
  forecasts_v2: { scored: 18, decision_grade: 1, decision_grade_skilled: 1, insufficient: 17 },
  holdout_exposure: { limit: 10, reuse_risk: true, write_test_enabled: false, note: '', epochs: [
    { holdout: 'mined', epoch: 0, tasks: 20, frozen_at: '2026-10-01T06:10:23Z', current: true, candidates: 11, decisions: 0, evaluations: 251, reuse_risk: true },
    { holdout: 'mutant', epoch: 0, tasks: 20, frozen_at: '2026-10-02T23:22:59Z', current: true, candidates: 6, decisions: 8, evaluations: 140, reuse_risk: false },
  ] },
};

it('UX-9: shows the four Realm Gates with their state as text and the reason', () => {
  const html = renderToStaticMarkup(<EvolutionBody data={FULL} />);
  for (const text of ['Gate A', 'Gate B', 'Gate C', 'Gate D', 'unknown', 'red', 'green', 'no settled trial with diagnostics yet', '0 settled loop PRs; needs ≥ 30 with ≥ 8 per class']) expect(html).toContain(text);
});

it('UX-9: an empty evidence snapshot renders honest empty states, not zeros dressed up as results', () => {
  const html = renderToStaticMarkup(<EvolutionBody data={EMPTY} />);
  for (const text of ['No settled trial has diagnostics yet.', 'No gym attempts in the window.', 'No model calls recorded yet.', 'No checker second opinions yet.', 'No Commons child attempted yet.', 'No forecaster scored yet.', 'No tagged production outcomes yet.']) expect(html).toContain(text);
});

it('UX-9: every metric row shows its sample size n', () => {
  const html = renderToStaticMarkup(<EvolutionBody data={FULL} />);
  for (const text of ['n = 7', 'n = 41', 'n = 18', 'n = 74', 'n = 4', 'n = 20']) expect(html).toContain(text);
});

it('UX-9: shadow values are labelled as shadow — did not act', () => {
  const html = renderToStaticMarkup(<EvolutionBody data={FULL} />);
  const labels = html.match(/shadow — did not act/g) ?? [];
  expect(labels.length).toBeGreaterThanOrEqual(3); // model selector, forecasts V2, oracle
  expect(html).toContain('would pick kimi-k3:cloud');
});

it('UX-9: a failed load shows the error instead of an empty page', async () => {
  vi.spyOn(api, 'getEvolutionEvidence').mockRejectedValue(new Error('Insufficient permissions'));
  render(<EvolutionPage />);
  expect((await screen.findByRole('alert')).textContent).toContain('Insufficient permissions');
});

it('earned auto-merge: shows the class state, why it was revoked, and the counts', () => {
  const auto_merge: EvolutionEvidence['auto_merge'] = { mode: 'act', max_per_day: 10, audit_sample_pct: 10,
    class: { state: 'revoked', reason: 'PR #700: reverted on main by rev1' },
    counts: { merged: 4, merged_24h: 1, would_merge: 0, audit_samples: 1, audit_samples_open: 1, waiting: 0, ineligible: 2 }, ineligible_by_reason: {} };
  const html = renderToStaticMarkup(<EvolutionBody data={{ ...FULL, auto_merge }} />);
  for (const text of ['Test-only auto-merge (mode act)', 'revoked', 'PR #700: reverted on main by rev1', 'n = 4 merged', '1 audit sample(s) open']) expect(html).toContain(text);
  expect(renderToStaticMarkup(<EvolutionBody data={{ ...FULL, auto_merge: { ...auto_merge, mode: 'off' } }} />)).not.toContain('Test-only auto-merge');
});

it('earned auto-merge: shows the re-check split (transient vs permanent) and the re-checks in 24 h when reported', () => {
  const auto_merge: EvolutionEvidence['auto_merge'] = { mode: 'act', max_per_day: 10, audit_sample_pct: 10, class: { state: 'active' },
    counts: { merged: 0, merged_24h: 0, would_merge: 0, audit_samples: 13, audit_samples_open: 13, waiting: 0, ineligible: 31 }, ineligible_by_reason: { checks_failed: 20, assertion_strength_missing: 11 },
    recheck: { enabled: true, window_hours: 6, per_tick: 5, ineligible_by_class: { permanent: 0, transient: 31 }, by_decision_reason: {}, rechecked_24h: 5, rechecked_24h_by_decision: { waiting: 5 } } };
  const html = renderToStaticMarkup(<EvolutionBody data={{ ...FULL, auto_merge }} />);
  for (const text of ['Re-check on (6 h window, ≤ 5 per tick)', 'ineligible 31 transient / 0 permanent', '5 re-checked in 24 h']) expect(html).toContain(text);
  expect(renderToStaticMarkup(<EvolutionBody data={{ ...FULL, auto_merge: { ...auto_merge, recheck: undefined } }} />)).not.toContain('Re-check');
});

it('§16 step 7: holdout exposure per epoch is shown with n and a reuse-risk flag; absent evidence renders nothing', () => {
  const html = renderToStaticMarkup(<EvolutionBody data={FULL} />);
  expect(html).toContain('mined epoch 0: 11 candidates (limit 10) — reuse risk, introduce a fresh epoch');
  expect(html).toContain('mutant epoch 0: 6 candidates (limit 10)');
  expect(renderToStaticMarkup(<EvolutionBody data={EMPTY} />)).not.toContain('reuse risk');
});

// L6-04: the registered experiments, each with its own evidence section and learning-ledger rows, read-only
type Exp = NonNullable<EvolutionEvidence['experiments']>['experiments'][number];
const power = (p: Partial<Exp['power']> = {}): Exp['power'] => ({ n_so_far: null, target_per_arm: null, days_to_stop: null, accrual_window_days: null, accrual_per_day: null,
  projected_min_arm_n: null, projected_reaches_target: null, ...p });
const exp = (e: Partial<Exp> & Pick<Exp, 'id'>): Exp => ({ flag: `${e.id}_MODE`, protocol: `docs/research/${e.id}.md`, started_at: '2026-10-12T00:00:00.000Z', target_n: 50,
  stop_by: '2026-11-15T00:00:00.000Z', stop_note: 'stop condition added 2026-10-19', stop_source: `docs/research/${e.id}.md#amendment`, population: 'oracle_goals',
  n_per_arm: null, min_arm_n: null, verdict: null, overdue: false, overdue_reason: null, power: power(), ...e });
const EXPERIMENTS: Exp[] = [
  // running, effect not computed yet (null diff)
  exp({ id: 'ACE-001', n_per_arm: { '00': 3, '01': 2, '10': 0, '11': 1 }, min_arm_n: 0,
    effects: { kb_retrieval: { metric: 'verified rate, factor on − off (interim, descriptive)', estimate: null, ci: null, p: null } } }),
  // at target, no verdict: overdue, grandfathered over the WIP limit, started before the 7-day evidence window
  exp({ id: 'MAKER-DEPS-001', started_at: '2026-10-01T00:00:00.000Z', target_n: 10, stop_by: '2026-12-16T00:00:00.000Z', n_per_arm: { A: 12, B: 10 }, min_arm_n: 10,
    overdue: true, overdue_reason: 'every arm reached target 10 without a verdict',
    approved_over_limit: 'running before the G1.5 WIP limit existed (2026-10-19); finishes under its registered stop_by',
    effects: { deps_prep: { metric: 'ITT verified rate, B − A; cluster-bootstrap 95 % CI (descriptive)', estimate: 0.042, ci: [-0.11, 0.19], p: null } } }),
  // closed with a recorded verdict
  exp({ id: 'F2', verdict: 'reversed', n_per_arm: { same: 40, cross: 40 }, min_arm_n: 40, target_n: 40,
    effects: { checker_family: { metric: 'Δkappa cross − same on outcome_wo_checker (final); seeded bootstrap 95 % CI', estimate: -0.21, ci: [-0.4, -0.02], p: 0.03 } } }),
  // interim inconclusive: the registry keeps the verdict null (the stopping rule extends once), not windowed
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
const EXP_DATA = {
  ...FULL, at: '2026-10-24T00:00:00.000Z', window_days: 7,
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

it('L6-04: one row per registered experiment shows running, overdue, closed and interim-inconclusive states truthfully', () => {
  const { container } = render(<EvolutionBody data={EXP_DATA} />);
  expect(screen.getByRole('heading', { name: 'Experiments' })).toBeTruthy();
  const ace = rowText(container, 'ACE-001');
  expect(ace).toContain('running'); expect(ace).toContain('no verdict recorded'); expect(ace).toContain('00 3 · 01 2 · 10 0 · 11 1 / target 50');
  const deps = rowText(container, 'MAKER-DEPS-001');
  expect(deps).toContain('overdue'); expect(deps).toContain('every arm reached target 10 without a verdict'); expect(deps).toContain('no verdict recorded');
  expect(deps).toContain('version v1');
  const f2 = rowText(container, 'F2');
  expect(f2).toContain('closed'); expect(f2).toContain('reversed'); expect(f2).toContain('version v2');
  const tg = rowText(container, 'TG-001');
  expect(tg).toContain('running'); expect(tg).toContain('interim result inconclusive — not a closing verdict'); expect(tg).toContain('no verdict recorded');
});

it('L6-04: a null effect or CI is shown as not computed, never as 0', () => {
  const { container } = render(<EvolutionBody data={EXP_DATA} />);
  const ace = detailText(container, 'ACE-001');
  expect(ace).toContain('estimate not computed'); expect(ace).toContain('no CI computed');
  expect(ace).not.toMatch(/estimate 0(\.0+)?\b/);
  expect(ace).toContain('retrieval delivery unknown'); // null delivery rate
  expect(ace).toContain('examples delivery 80 %');
  expect(ace).toContain('arm 10: n = 0, verified rate unknown'); // null rate on an empty arm is not 0 %
  // the paired TG effect with null estimate
  expect(detailText(container, 'TG-001')).toContain('A-B: n pairs 19, effect not computed, no CI computed');
});

it('L6-04: reaching the target is never shown as supported; only a recorded verdict closes an experiment', () => {
  const html = renderToStaticMarkup(<EvolutionBody data={EXP_DATA} />);
  expect(html).not.toMatch(/supported/i);
  expect(html).not.toContain('ADOPTED');
  const { container } = render(<EvolutionBody data={EXP_DATA} />);
  expect(rowText(container, 'MAKER-DEPS-001')).not.toContain('closed');
  expect(detailText(container, 'MAKER-DEPS-001')).toContain('evidence status analysable — target reached, no analysis verdict recorded');
});

it('L6-04: each section states its own window; a grandfathered WIP exception is labelled with its reason', () => {
  const { container } = render(<EvolutionBody data={EXP_DATA} />);
  // MAKER-DEPS started before the 7-day evidence window: the section is not the whole experiment
  expect(detailText(container, 'MAKER-DEPS-001')).toContain('section counts the last 7 d only (from 2026-10-17); the registry row counts from 2026-10-01');
  expect(detailText(container, 'ACE-001')).toContain('section counts from analysis_since 2026-10-17 (Amendment 1); 9 earlier outcomes excluded');
  expect(detailText(container, 'TG-001')).toContain('section is not windowed (whole experiment)');
  expect(rowText(container, 'MAKER-DEPS-001')).toContain('grandfathered: running before the G1.5 WIP limit existed');
  expect(rowText(container, 'ACE-001')).toContain('counts toward WIP limit 4');
  expect(rowText(container, 'TG-001')).toContain('not on the oracle-goal population');
  expect(container.textContent).toContain('2 active on oracle goals (limit 4): 1 counted, 1 grandfathered exception(s) — guard ok');
});

it('L6-04: circular / secondary endpoints, closed versions and prior generations are labelled as the evidence says', () => {
  const { container } = render(<EvolutionBody data={EXP_DATA} />);
  const f2 = detailText(container, 'F2');
  expect(f2).toContain('primary (outcome_wo_checker, final)');
  expect(f2).toContain('secondary, circular — contains the checker\'s own rejection');
  expect(f2).toContain('v1 (closed 17-10 interim) reported apart, never pooled');
  const tg = detailText(container, 'TG-001');
  expect(tg).toContain('r1 ABORTED_DATA_LOSS — never pooled');
  expect(tg).toContain('prior exposure: 19 exposed, 1 unexposed');
});

it('L6-04: the learning ledger shows mechanism, effect, CI and status, with null as not computed', () => {
  const { container } = render(<EvolutionBody data={EXP_DATA} />);
  expect(detailText(container, 'ACE-001')).toContain('KB retrieval (kb_retrieval): RUNNING — estimate not computed, no CI computed');
  expect(detailText(container, 'F2')).toContain('Checker family (checker_family): REJECTED — estimate -0.210, CI [-0.400, -0.020]');
  expect(container.textContent).toContain('loops closed 0/3');
});

it('L6-04: a server without the experiment registry renders an honest empty state', () => {
  expect(renderToStaticMarkup(<EvolutionBody data={EMPTY} />)).toContain('Experiment registry not reported by this server.');
});
