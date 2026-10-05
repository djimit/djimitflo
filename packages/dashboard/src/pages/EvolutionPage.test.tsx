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
