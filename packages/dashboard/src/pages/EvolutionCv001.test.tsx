import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Cv001Card } from './EvolutionCv001';
import type { Cv001Evidence } from '../lib/api';

afterEach(() => cleanup());

const BASE: Cv001Evidence = {
  mode: 'on', experiment_id: 'cv-001', protocol: 'docs/research/cv-001/CV-001_PROTOCOL.md', prereg_sha256: 'b6e1bb31'.padEnd(64, '0'), loop_name: 'cv-001', status: 'not_frozen',
  treatment: { aliases: { A: 'qwen38-27b', B: 'qwen38-27b-cvd15' }, vector_sha256: 'db1893a4d129'.padEnd(64, '0'), scale: 1.5 },
  serving: { open: false, reason: 'outside the window 0:00-6:00Z', window: '0-6', maker_jobs: null },
  targets: { tasks: 60, repeats: 2, units: 120, block_size: 6, alpha: 0.05, max_days: 28 },
  freeze_refused: null, manifest: null, pairs: null, arms: [], primary: null, sensitivity: null, repeat1: null, stop: null, verdict: null, runs: [],
};

it('before the freeze: the window state and the treatment show; nothing is shown as 0', () => {
  render(<Cv001Card data={BASE} />);
  const card = screen.getByTestId('cv-001-card');
  expect(card.textContent).toContain('A qwen38-27b vs B qwen38-27b-cvd15 (vector db1893a4d129… × 1.5)');
  expect(card.textContent).toContain('Window 0-6 UTC: closed — outside the window 0:00-6:00Z · remote maker jobs waiting unknown');
  expect(card.textContent).toContain('Pairs: unknown (not frozen)');
  expect(card.textContent).toContain('Decision rules: not computed');
  expect(card.textContent).toContain('Verdict: none yet');
  expect(within(card).queryByRole('table')).toBeNull();
});

it('collecting: per-arm clean / plain outcomes, the rules and the verdict state', () => {
  const arm = (a: 'A' | 'B') => ({ arm: a, name: a, alias: BASE.treatment.aliases[a], observations: 10, clean: a === 'B' ? 6 : 3, plain: 7, timeouts: 1, degenerate: 0, loops: 0, post_pass_edits: 2,
    censored: 0, invalid: 0, pending: 50, physical_attempts: 11, void_attempts: 1, infra_attempts: 0, maker_ms_median: null, tokens: { known: 0, unknown: 10 } });
  const p = { n_pairs: 10, both_clean: 3, b_only_B: 3, c_only_A: 0, neither_clean: 4, clean_rate_A: 0.3, clean_rate_B: 0.6, p_one_sided: 0.125, plain_rate_A: 0.7, plain_rate_B: 0.7,
    observed: { A: 10, B: 10 }, degenerate_rate_A: 0, degenerate_rate_B: 0, timeout_rate_A: 0.1, timeout_rate_B: 0.1,
    rules: { clean_plus_10_and_significant: false, plain_drop_at_most_5: true, degenerate_rise_at_most_2: true, timeouts_not_higher: true }, adopt: false };
  render(<Cv001Card data={{ ...BASE, status: 'collecting', serving: { open: true, reason: null, window: '0-6', maker_jobs: 0 }, arms: [arm('A'), arm('B')], primary: p,
    pairs: { done: 10, open: 110, invalid_units: 0, target: 120 } }} />);
  const card = screen.getByTestId('cv-001-card');
  expect(card.textContent).toContain('Window 0-6 UTC: open now');
  expect(card.textContent).toContain('Pairs: 10 done / target 120, 110 open');
  expect(card.textContent).toContain('clean A 30 %, B 60 %');
  expect(card.textContent).toContain('clean +10 pt, p < 0.05 fails · plain drop ≤ 5 pt holds');
  expect(within(card).getAllByRole('row')).toHaveLength(3);
  expect(card.textContent).toContain('unknown'); // maker time median not known
});
