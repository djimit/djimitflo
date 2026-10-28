import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Pl001Card } from './EvolutionPl001';
import type { Pl001Evidence } from '../lib/api';

afterEach(() => cleanup());

const BASE: Pl001Evidence = {
  mode: 'on', experiment_id: 'pl-001', protocol: 'docs/research/procedure-loop/PL-001_PROTOCOL.md', prereg_sha256: 'fa136ae5'.padEnd(64, '0'), loop_name: 'pl-001',
  status: 'not_frozen', procedure: { id: 'ts-build-error-repair-v1', version: null, lines_sha256: null, protocol_lines_sha256: '6dddbba133cd'.padEnd(64, '0'), digest_matches: null, status: null, lifecycle: null },
  start_condition: { genomes: [{ id: 'g-a187f81f', status: 'trial' }, { id: 'g-d14c1156', status: null }], settled: false, cap_share: 0, open: false, rule: 'waiting' },
  selector_check: null, targets: { pairs: 60, tasks: 75, max_days: 14, alpha: 0.05 }, freeze_refused: null, manifest: null, pairs: null, arms: [], primary: null, sensitivity: null,
  secondary: null, harm: null, stop: null, verdict: null, runs: [],
};

it('before the freeze: nothing is shown as 0 — pairs, verdict and lifecycle read unknown / none', () => {
  render(<Pl001Card data={BASE} />);
  const card = screen.getByTestId('pl-001-card');
  expect(card.textContent).toContain('Pairs: unknown (not frozen)');
  expect(card.textContent).toContain('Verdict: none yet');
  expect(card.textContent).toContain('Lifecycle: unknown — no verdict recorded');
  expect(card.textContent).toContain('Primary (ITT): no completed pair yet');
  expect(card.textContent).toContain('start condition waiting (g-a187f81f trial, g-d14c1156 absent; cap share 0)');
  expect(card.textContent).not.toMatch(/\b0 \/ 60\b/);
  expect(within(card).queryByRole('table')).toBeNull();
});

it('collecting: procedure digest, frozen set, pairs done / target, per-arm outcomes with unknown tokens, verdict state, lifecycle and run links', () => {
  const data: Pl001Evidence = { ...BASE, status: 'collecting',
    procedure: { ...BASE.procedure, version: 1, lines_sha256: BASE.procedure.protocol_lines_sha256, digest_matches: true, status: 'candidate' },
    start_condition: { ...BASE.start_condition, genomes: [{ id: 'g-a187f81f', status: 'retired' }, { id: 'g-d14c1156', status: 'active' }], settled: true, open: true, rule: 'settled' },
    selector_check: { n: 12, does_not_apply: 12, applies: [], ok: true },
    manifest: { frozen_at: '2026-10-27T08:00:00.000Z', sha256: 'abcdef123456'.padEnd(64, '0'), tasks: 75, species: 'atomic@llama-router', step_budget: 40, by_kind: { mutant: 70, mined: 5 },
      by_tier: { 3: 20, 4: 18, 5: 17, 6: 15 }, first_arm: { A: 37, B: 38 }, valid: true, reason: null },
    pairs: { done: 7, analysed: 7, target: 60, invalid_tasks: 1, tasks: 75 },
    arms: [
      { arm: 'A', name: 'baseline (gym goal, no lines)', observations: 8, verified: 3, not_verified: 5, infra_censored: 0, invalid: 1, pending: 66, physical_attempts: 10, infra_attempts: 1, void_attempts: 0, infra_rate: 0.1,
        tokens: { known: 0, unknown: 8, mean_known: null }, graded_mean: 0.4, maker_ms_median: null, out_of_scope_or_hack: 0 },
      { arm: 'B', name: 'candidate (gym goal + procedure lines)', observations: 7, verified: 4, not_verified: 3, infra_censored: 0, invalid: 1, pending: 67, physical_attempts: 8, infra_attempts: 0, void_attempts: 1, infra_rate: 0,
        tokens: { known: 2, unknown: 5, mean_known: 1500 }, graded_mean: 0.6, maker_ms_median: 120_000, out_of_scope_or_hack: 1 },
    ],
    primary: { n_pairs: 7, both_verified: 2, b_only_B: 2, c_only_A: 1, neither: 2, verified_A: 3, verified_B: 4, rate_A: 3 / 7, rate_B: 4 / 7, p_one_sided: 0.5, supported: false },
    harm: { e_value: 0.75, threshold: 20, canary_solved: 0, scope_hack: { A: 0, B: 1 }, margin: 3, triggered: false, reason: null },
    stop: { first_attempt_at: '2026-10-27T09:00:00.000Z', day_limit_at: '2026-11-10T09:00:00.000Z', stopped: false, reason: null },
    runs: [{ task_key: 'mut:abc:packages/server/src/services/a.ts:3:1', arm: 'B', run_id: 'run-12345678-x', status: 'success', reason: 'tests green', void: null, verified: true, at: '2026-10-27T10:00:00.000Z' }] };
  render(<Pl001Card data={data} />);
  const card = screen.getByTestId('pl-001-card');
  expect(card.textContent).toContain('ts-build-error-repair-v1 v1 · lines digest 6dddbba133cd… (protocol digest)');
  expect(card.textContent).toContain('Frozen set: 75 tasks (70 mutant, 5 mined');
  expect(card.textContent).toContain('Pairs: 7 done / target 60, 1 invalid tasks');
  expect(card.textContent).toContain('selector check 12/12 unfit tasks rejected');
  expect(card.textContent).toContain('Lifecycle: candidate — no verdict recorded');
  expect(card.textContent).toContain('Verdict: none yet · day 14 at 2026-11-10T09:00');
  const rows = within(card).getAllByRole('row');
  expect(rows[1].textContent).toContain('3 / 8');
  expect(rows[1].textContent).toContain('unknown (0 / 8)'); // no token count printed: unknown, not 0
  expect(rows[1].textContent).toContain('unknown'); // maker time not reported
  expect(rows[2].textContent).toContain('mean 1500 (2 / 5)');
  expect(rows[2].textContent).toContain('120 s');
  expect(card.textContent).toContain('Primary (ITT): 7 pairs — B only 2, A only 1, both 2, neither 2; verified A 43 %, B 57 %; one-sided exact McNemar p 0.500');
  expect(within(card).getByRole('link', { name: 'run-1234' }).getAttribute('href')).toBe('/goals-loops?run=run-12345678-x');
});

it('a recorded verdict shows the lifecycle decision; a manifest with another digest is flagged', () => {
  const data: Pl001Evidence = { ...BASE, status: 'stopped', verdict: 'SUPPORTED',
    procedure: { ...BASE.procedure, version: 1, lines_sha256: 'ffff'.padEnd(64, '0'), digest_matches: false, status: 'validated',
      lifecycle: { verdict: 'SUPPORTED', status: 'validated', decided_at: '2026-11-08T00:00:00.000Z', reason: 'PL-001 SUPPORTED: 60 pairs', promoted: false } },
    stop: { first_attempt_at: '2026-10-27T09:00:00.000Z', day_limit_at: '2026-11-10T09:00:00.000Z', stopped: true, reason: '60 completed pairs' } };
  render(<Pl001Card data={data} />);
  const card = screen.getByTestId('pl-001-card');
  expect(card.textContent).toContain('Lifecycle: validated — SUPPORTED on 2026-11-08: PL-001 SUPPORTED: 60 pairs');
  expect(card.textContent).toContain('Verdict: SUPPORTED — 60 completed pairs');
  expect(card.textContent).toContain('not the protocol digest 6dddbba133cd…');
});
