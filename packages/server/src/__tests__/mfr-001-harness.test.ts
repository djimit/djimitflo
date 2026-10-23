import { describe, expect, it } from 'vitest';
import { targetMutants } from '../services/gym-failure-tasks';

// MFR-001 harness rules (docs/research/eco/MFR-001_PROTOCOL.md): arm assignment, shown / held-out split, the leak check
// and the decision rule. Fake data only: no model, no docker, no network.
type Lib = typeof import('../../../../scripts/mfr-001/lib.mjs');
const lib = async () => (await import('../../../../scripts/mfr-001/lib.mjs')) as Lib;

const TARGET = 'packages/server/src/services/widget.ts';
const TEST = 'packages/server/src/__tests__/widget.exports.test.ts';
const SOURCE = [
  'export function widget(a: number, b: number): boolean {',
  '  if (a > 1 && b < 5) return true;',
  '  if (a === b || a <= 0) return false;',
  '  const c = a + 1;',
  '  if (c >= 10) return true;',
  '  if (b !== 3 && c < 7) return false;',
  '  return a - 1 > b;',
  '}',
  'export const enabled = (x: string) => x === "on" || x === "true";',
  'export const limit = (n: number) => (n > 100 ? 100 : n < 0 ? 0 : n);',
  '',
].join('\n');

describe('MFR-001 arm assignment', () => {
  it('is the parity of sha256(item id): even last hex digit = feedback, deterministic and balanced', async () => {
    const { armOf, armOrder, sha256 } = await lib();
    const ids = Array.from({ length: 400 }, (_, i) => `lease-${i}`);
    for (const id of ids.slice(0, 20)) {
      expect(armOf(id)).toBe(parseInt(sha256(id).slice(-1), 16) % 2 === 0 ? 'feedback' : 'control');
      expect(armOf(id)).toBe(armOf(id));
      expect(armOrder(id)[0]).toBe(armOf(id));
      expect([...armOrder(id)].sort()).toEqual(['control', 'feedback']);
    }
    const f = ids.filter((id) => armOf(id) === 'feedback').length;
    expect(f).toBeGreaterThan(160); expect(f).toBeLessThan(240);
  });

  it('orders items blind and seeded, independent of input order', async () => {
    const { itemOrder } = await lib();
    const ids = ['c', 'a', 'b', 'd', 'e'];
    expect(itemOrder(ids)).toEqual(itemOrder([...ids].reverse()));
    expect([...itemOrder(ids)].sort()).toEqual([...ids].sort());
  });
});

describe('MFR-001 mutants', () => {
  it('fresh mutants exclude the production 3; the seeded split gives 3 shown + 3 held out, disjoint', async () => {
    const { freshMutants, splitMutants, assertDisjoint, describeMutant, applyDescriptor, PROD_K, FRESH_K } = await lib();
    const prod = targetMutants(SOURCE, 'run-1', TARGET, PROD_K);
    const fresh = freshMutants(targetMutants(SOURCE, 'run-1', TARGET, PROD_K + FRESH_K + 3), prod);
    expect(prod).toHaveLength(3);
    expect(fresh).toHaveLength(6);
    for (const m of fresh!) expect(prod.map((p) => p.content)).not.toContain(m.content);
    const a = splitMutants(fresh!, 'item-1'); const b = splitMutants(fresh!, 'item-1');
    expect(a.shown.map((m) => m.key)).toEqual(b.shown.map((m) => m.key));
    expect(a.shown).toHaveLength(3); expect(a.held).toHaveLength(3);
    expect(new Set([...a.shown, ...a.held].map((m) => m.key)).size).toBe(6);
    expect(assertDisjoint(a.shown, a.held, prod)).toBe(true);
    expect(() => assertDisjoint(a.shown, [a.shown[0]], prod)).toThrow(/also shown/);
    expect(() => assertDisjoint(a.shown, [prod[0]], prod)).toThrow(/production mutant/);
    // a descriptor rebuilds the exact mutant content (the runner verifies sha256 too)
    for (const m of fresh!) expect(applyDescriptor(SOURCE, describeMutant(SOURCE, m.content)!)).toBe(m.content);
    expect(applyDescriptor(SOURCE, { line: 2, before: 'nope', after: 'x' })).toBeNull();
  });

  it('a target with too few mutants is not an item', async () => {
    const { freshMutants } = await lib();
    const prod = targetMutants(SOURCE, 'r', TARGET, 3);
    expect(freshMutants(targetMutants(SOURCE, 'r', TARGET, 8), prod)).toBeNull(); // 5 fresh < 6
    // the production mutants must be the generator's prefix (same seeds), otherwise H could contain one
    expect(() => freshMutants(targetMutants(SOURCE, 'other-run', TARGET, 12), prod)).toThrow(/prefix/);
  });
});

describe('MFR-001 prompts and the held-out leak check', () => {
  it('feedback = control text + the surviving shown mutants; control carries no mutant', async () => {
    const { buildPrompt, renderMutant } = await lib();
    const shown = [{ key: 'mut:k1', line: 2, before: '  if (a > 1 && b < 5) return true;', after: '  if (a > 1 || b < 5) return true;' }];
    const control = buildPrompt({ test: TEST, target: TARGET, arm: 'control' });
    const feedback = buildPrompt({ test: TEST, target: TARGET, arm: 'feedback', survivors: shown });
    expect(control).toContain('Strengthen the assertions of this test.');
    expect(control).not.toContain('was changed to');
    expect(feedback.startsWith(control.slice(0, -1))).toBe(true);
    expect(feedback).toContain(renderMutant(TARGET, shown[0]));
    expect(feedback).not.toMatch(/\n/);
    expect(() => buildPrompt({ test: TEST, target: TARGET, arm: 'treatment' })).toThrow(/unknown arm/);
  });

  it('throws MFR_LEAK when a held-out mutant reaches the prompt (key, description or mutated line)', async () => {
    const { buildPrompt, assertNoLeak, findLeaks, renderMutant } = await lib();
    const shown = [{ key: 'mut:s1', line: 2, before: '  if (a > 1 && b < 5) return true;', after: '  if (a > 1 || b < 5) return true;' }];
    const held = [{ key: 'mut:h1', line: 5, before: '  if (c >= 10) return true;', after: '  if (c < 10) return true;' }];
    const ok = buildPrompt({ test: TEST, target: TARGET, arm: 'feedback', survivors: shown });
    expect(assertNoLeak(ok, held, { target: TARGET, shown })).toBe(true);
    expect(findLeaks(`${ok} ${held[0].key}`, held, { target: TARGET, shown })[0].via).toBe('key');
    expect(findLeaks(`${ok} ${renderMutant(TARGET, held[0])}`, held, { target: TARGET, shown })[0].via).toBe('description');
    expect(findLeaks(`${ok} try if (c < 10) return true;`, held, { target: TARGET, shown })[0].via).toBe('mutated_line');
    // the harness passes every held-out mutant: leaking one in a feedback list must abort
    const leaky = buildPrompt({ test: TEST, target: TARGET, arm: 'feedback', survivors: [...shown, ...held] });
    expect(() => assertNoLeak(leaky, held, { target: TARGET, shown })).toThrow(/MFR-001 LEAK/);
    try { assertNoLeak(leaky, held, { target: TARGET, shown }); } catch (e) { expect((e as { code?: string }).code).toBe('MFR_LEAK'); }
    // an identical line elsewhere: the shown description is the shown mutant's text, not a leak
    const twin = [{ key: 'mut:h2', line: 9, before: '  if (a > 1 && b < 5) return true;', after: '  if (a > 1 || b < 5) return true;' }];
    expect(findLeaks(ok, twin, { target: TARGET, shown })).toEqual([]);
  });
});

describe('MFR-001 outcome classes', () => {
  it('only ok scores held-out kills; no change, timeout, out of scope and red baseline score 0; infra is excluded', async () => {
    const { classify, heldScore } = await lib();
    expect(classify({ infra: true, test: TEST })).toBe('infra');
    expect(classify({ termination: 'timeout', changed: [], test: TEST })).toBe('timeout');
    expect(classify({ termination: 'exit:0', changed: [], test: TEST })).toBe('no_change');
    expect(classify({ termination: 'exit:0', changed: [TEST, TARGET], test: TEST, baseline: 'pass' })).toBe('out_of_scope');
    expect(classify({ termination: 'exit:0', changed: [TEST], test: TEST, baseline: 'fail' })).toBe('baseline_red');
    expect(classify({ termination: 'exit:0', changed: [TEST], test: TEST, baseline: 'timeout' })).toBe('baseline_red');
    expect(classify({ termination: 'timeout', changed: [TEST], test: TEST, baseline: 'pass' })).toBe('ok');
    expect(heldScore('ok', ['fail', 'pass', 'timeout'])).toBeCloseTo(2 / 3);
    expect(heldScore('baseline_red', undefined)).toBe(0);
    expect(heldScore('no_change', undefined)).toBe(0);
    expect(() => heldScore('ok', ['fail'])).toThrow();
  });
});

describe('MFR-001 decision rule (fake data)', () => {
  type Run = { class: string; held_score: number };
  const item = (id: string, f: Run, c: Run) => ({ id, eligible: true, runs: { feedback: f, control: c } });
  const ok = (s: number): Run => ({ class: 'ok', held_score: s });
  const red: Run = { class: 'baseline_red', held_score: 0 };

  it('SUPPORTED: a large paired gain, CI above 0, baseline-red within margin', async () => {
    const { summarize } = await lib();
    const rs = Array.from({ length: 40 }, (_, i) => item(`i${i}`, ok(i % 4 === 0 ? 1 : 2 / 3), ok(i % 3 === 0 ? 1 / 3 : 0)));
    const s = summarize(rs, { nPerm: 2000, nBoot: 2000 });
    expect(s.n_scored_pairs).toBe(40);
    expect(s.paired.delta!).toBeGreaterThan(0.5);
    expect(s.paired.ci[0]!).toBeGreaterThan(0);
    expect(s.paired.p!).toBeLessThan(0.01);
    expect(s.decision.verdict).toBe('SUPPORTED');
    expect(s.decision.acceptance).toBe(true);
  });

  it('a gain bought with red baselines is not SUPPORTED', async () => {
    const { summarize } = await lib();
    const rs = Array.from({ length: 40 }, (_, i) => item(`i${i}`, i % 5 === 0 ? red : ok(1), ok(i % 2 ? 1 / 3 : 0)));
    const s = summarize(rs, { nPerm: 2000, nBoot: 2000 });
    expect(s.paired.delta!).toBeGreaterThan(0.15);
    expect(s.baseline_red_rate.feedback).toBe(0.2);
    expect(s.decision.verdict).not.toBe('SUPPORTED');
  });

  it('FALSIFIED: no effect, CI upper below +0.15', async () => {
    const { summarize } = await lib();
    const rs = Array.from({ length: 40 }, (_, i) => item(`i${i}`, ok(i % 3 === 0 ? 1 / 3 : 0), ok(i % 3 === 1 ? 1 / 3 : 0)));
    const s = summarize(rs, { nPerm: 2000, nBoot: 2000 });
    expect(Math.abs(s.paired.delta!)).toBeLessThan(0.05);
    expect(s.paired.ci[1]!).toBeLessThan(0.15);
    expect(s.decision.verdict).toBe('FALSIFIED');
  });

  it('INCONCLUSIVE: a noisy small effect whose CI straddles +0.15; infra runs drop the pair; < 30 pairs fails acceptance', async () => {
    const { summarize, decide } = await lib();
    const rs = Array.from({ length: 12 }, (_, i) => item(`i${i}`, ok(i % 2 ? 1 : 0), ok(i % 3 ? 0 : 1)));
    const s = summarize([...rs, { id: 'x', eligible: true, runs: { feedback: { class: 'infra', held_score: 0 }, control: ok(0) } }, { id: 'y', eligible: false, exclusion: 'no_shown_survivor' }], { nPerm: 2000, nBoot: 2000 });
    expect(s.n_scored_pairs).toBe(12);
    expect(s.infra_runs).toBe(1);
    expect(s.excluded).toEqual({ no_shown_survivor: 1 });
    expect(s.decision.verdict).toBe('INCONCLUSIVE');
    expect(s.decision.acceptance).toBe(false);
    expect(decide({ delta: 0.2, ci: [-0.01, 0.4], redFeedback: 0, redControl: 0, nFeedback: 30, nControl: 30 }).verdict).toBe('INCONCLUSIVE');
    expect(decide({ delta: 0.15, ci: [0.01, 0.3], redFeedback: 0.1, redControl: 0.05, nFeedback: 30, nControl: 30 }).verdict).toBe('SUPPORTED');
    expect(decide({ delta: 0.15, ci: [0.01, 0.3], redFeedback: 0.11, redControl: 0.05, nFeedback: 30, nControl: 30 }).verdict).toBe('INCONCLUSIVE');
    expect(decide({ delta: 0.05, ci: [-0.05, 0.1499], redFeedback: 0, redControl: 0, nFeedback: 30, nControl: 30 }).verdict).toBe('FALSIFIED');
  });

  it('statistics are seeded: the same data give the same p and CI', async () => {
    const { pairedStats } = await lib();
    const pairs = Array.from({ length: 30 }, (_, i) => ({ feedback: (i % 3) / 3, control: (i % 2) / 3 }));
    expect(pairedStats(pairs, { nPerm: 500, nBoot: 500 })).toEqual(pairedStats(pairs, { nPerm: 500, nBoot: 500 }));
  });
});
