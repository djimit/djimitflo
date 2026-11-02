import { describe, expect, it } from 'vitest';
import { mutate, rng as gymRng } from '../services/gym-mutants';

// STR-001 Stage A harness rules (docs/research/eco/STR-001_STAGE_A_PROTOCOL.md): mutant-family disjointness, Stryker
// mutant identity / content, the strengthen-arm classes, the statistics and the decision rule. Fake data only: no model,
// no docker, no network.
type Lib = typeof import('../../../../scripts/str-001/lib.mjs');
const lib = async () => (await import('../../../../scripts/str-001/lib.mjs')) as Lib;

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

describe('STR-001 family (a): fresh gym mutants under a new seed', () => {
  it('is deterministic, single-line, and excludes every MFR-001 mutant by content', async () => {
    const { familyA, assertDisjoint, applyDescriptor, sha256 } = await lib();
    const all = familyA({ original: SOURCE, itemId: 'lease-1', mutate, rngFn: gymRng, k: 50 });
    expect(all.length).toBeGreaterThan(5);
    expect(familyA({ original: SOURCE, itemId: 'lease-1', mutate, rngFn: gymRng, k: 50 }).map((m) => m.sha256)).toEqual(all.map((m) => m.sha256));
    for (const m of all) { expect(applyDescriptor(SOURCE, m)).toBe(m.content); expect(sha256(m.content)).toBe(m.sha256); }
    // pretend the first three were MFR's production / shown / held-out mutants
    const mfr = all.slice(0, 3).map((m, i) => ({ ...m, key: `mut:run:${i}` }));
    const fresh = familyA({ original: SOURCE, itemId: 'lease-1', mutate, rngFn: gymRng, exclude: mfr.map((m) => m.content), k: 50 });
    expect(fresh.some((m) => mfr.some((x) => x.content === m.content))).toBe(false);
    expect(fresh.length).toBe(all.length - 3);
    expect(assertDisjoint(fresh, mfr)).toBe(true);
  });

  it('assertDisjoint rejects shared content, shared keys and internal duplicates', async () => {
    const { assertDisjoint } = await lib();
    const a = { key: 'str-a:1', content: 'x' }; const b = { key: 'str-a:2', content: 'y' };
    expect(() => assertDisjoint([a, b], [{ key: 'mut:9', content: 'y' }])).toThrow(/content of an MFR-001 mutant/);
    expect(() => assertDisjoint([a], [{ key: 'str-a:1', content: 'z' }])).toThrow(/MFR-001 mutant key/);
    expect(() => assertDisjoint([a, { key: 'str-a:3', content: 'x' }], [])).toThrow(/duplicate content/);
  });
});

describe('STR-001 family (b): Stryker mutants', () => {
  // `a === b` on line 3 (1-based), columns 7..14 (1-based, end exclusive) as Stryker reports it
  const eq = { mutatorName: 'EqualityOperator', replacement: 'a !== b', status: 'Killed', location: { start: { line: 3, column: 7 }, end: { line: 3, column: 14 } } };
  it('rebuilds the mutated text from a 1-based location and replacement', async () => {
    const { strykerSlice, strykerContent } = await lib();
    expect(strykerSlice(SOURCE, eq)).toBe('a === b');
    expect(strykerContent(SOURCE, eq)).toBe(SOURCE.replace('a === b ||', 'a !== b ||'));
  });

  it('drops invalid statuses and every mutant whose content equals an MFR-001 mutant; scores Killed + Timeout', async () => {
    const { strykerTable, strykerSet, strykerKill } = await lib();
    const flip = { mutatorName: 'LogicalOperator', replacement: 'a > 1 || b < 5', status: 'Survived', location: { start: { line: 2, column: 7 }, end: { line: 2, column: 21 } } };
    const nocov = { mutatorName: 'ArithmeticOperator', replacement: 'a - 1', status: 'NoCoverage', location: { start: { line: 4, column: 13 }, end: { line: 4, column: 18 } } };
    const tout = { mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Timeout', location: { start: { line: 5, column: 7 }, end: { line: 5, column: 14 } } };
    const cerr = { mutatorName: 'BooleanLiteral', replacement: 'false', status: 'CompileError', location: { start: { line: 2, column: 30 }, end: { line: 2, column: 34 } } };
    const report = (ms: object[]) => ({ files: { 'src/services/widget.ts': { mutants: ms } } });
    const orig = strykerTable(report([eq, flip, nocov, tout, cerr]));
    const mfrContent = SOURCE.replace('a > 1 && b < 5', 'a > 1 || b < 5'); // the gym && -> || mutant on the same line
    const set = strykerSet(SOURCE, orig, [mfrContent]);
    expect(set.keys.length).toBe(3);
    expect(set.dropped).toEqual({ invalid: 1, mfr_overlap: 1, unbuildable: 0 });
    expect(strykerKill(orig, set.keys)).toBeCloseTo(2 / 3); // Killed + Timeout of {Killed, NoCoverage, Timeout}
    const retried = strykerTable(report([{ ...eq }, { ...flip }, { ...nocov, status: 'Killed' }, { ...tout }, cerr]));
    expect(strykerKill(retried, set.keys)).toBe(1);
    expect(() => strykerKill(strykerTable(report([eq])), set.keys)).toThrow(/missing/);
    expect(() => strykerTable({ files: { a: { mutants: [] }, b: { mutants: [] } } })).toThrow(/one mutated file/);
  });
});

describe('STR-001 strengthen classes and size', () => {
  it('no retried test and a red retried test score 0 under ITT; ok is scored', async () => {
    const { strengthenClass, familyRows } = await lib();
    expect(strengthenClass({ hasRetried: false, baseline: null })).toBe('no_retry');
    expect(strengthenClass({ hasRetried: true, baseline: 'fail' })).toBe('baseline_red');
    expect(strengthenClass({ hasRetried: true, baseline: 'timeout' })).toBe('baseline_red');
    expect(strengthenClass({ hasRetried: true, baseline: 'pass' })).toBe('ok');
    const unit = (id: string, cls: string, o: number | null, s: number | null, extra = {}) => ({ id, eligible: true, strengthen: { class: cls }, size: { added: 10, added_expects: 2 }, families: { stryker: { original: o, strengthen: s, n_mutants: 10, ...extra } } });
    const rows = familyRows([
      unit('a', 'ok', 0.2, 0.5), unit('b', 'no_retry', 0.3, null), unit('c', 'baseline_red', 0.4, null),
      unit('d', 'ok', 0.1, null), // family infra on the retried run: dropped
      unit('e', 'ok', null, null, { excluded: 'stryker_infra_original' }),
      { id: 'f', eligible: false, exclusion: 'original_red_at_base', strengthen: {}, size: {}, families: {} },
    ] as never, 'stryker');
    expect(rows.map((r) => [r.id, r.original, r.strengthen])).toEqual([['a', 0.2, 0.5], ['b', 0.3, 0], ['c', 0.4, 0]]);
  });

  it('counts added / removed lines and added expect( calls of a unified diff', async () => {
    const { diffSize } = await lib();
    const diff = ['diff --git a/t.ts b/t.ts', '--- a/t.ts', '+++ b/t.ts', '@@ -1,2 +1,3 @@', ' it("x", () => {', '-  expect(1).toBe(1);', '+  expect(f(1)).toBe(2); expect(f(2)).toBe(3);', '+  // more', ' });'].join('\n');
    expect(diffSize(diff)).toEqual({ added: 2, removed: 1, added_expects: 2 });
  });
});

describe('STR-001 statistics and decision rule', () => {
  it('exact one-sided sign test drops ties', async () => {
    const { signTest } = await lib();
    expect(signTest([1, 1, 1, 1, 1]).p).toBeCloseTo(1 / 32, 6);
    expect(signTest([1, 1, 1, 1, 1, 0, 0]).same).toBe(2);
    expect(signTest([1, -1]).p).toBeCloseTo(0.75, 6);
    expect(signTest([0, 0]).p).toBe(1);
    // 23 up / 0 down (the exploratory MFR observation): p = 2^-23
    expect(signTest([...Array(23).fill(0.3), ...Array(17).fill(0)]).p).toBeCloseTo(2 ** -23, 9);
  });

  it('Holm adjusts in input order and is monotone', async () => {
    const { holm } = await lib();
    expect(holm([0.01, 0.04])).toEqual([0.02, 0.04]);
    expect(holm([0.04, 0.01])).toEqual([0.04, 0.02]);
    expect(holm([0.03, 0.02])).toEqual([0.04, 0.04]);
    expect(holm([0.6, 0.9])).toEqual([1, 1]);
  });

  it('bootstrap CI is seeded and brackets the mean', async () => {
    const { bootCI } = await lib();
    const d = Array.from({ length: 40 }, (_, i) => (i % 4) / 10);
    const ci = bootCI(d, { nBoot: 2000, seed: 1 });
    expect(bootCI(d, { nBoot: 2000, seed: 1 })).toEqual(ci);
    expect(ci[0]!).toBeLessThan(0.15); expect(ci[1]!).toBeGreaterThan(0.15);
  });

  it('SUPPORTED needs Holm p < 0.05 and CI lower > 0.05 (and n >= 30); FALSIFIED needs CI upper < 0.05', async () => {
    const { decide } = await lib();
    expect(decide({ n: 40, pHolm: 0.001, ci: [0.2, 0.4] }).verdict).toBe('SUPPORTED');
    expect(decide({ n: 40, pHolm: 0.001, ci: [0.04, 0.4] }).verdict).toBe('INCONCLUSIVE'); // lower bound not > 0.05
    expect(decide({ n: 40, pHolm: 0.06, ci: [0.2, 0.4] }).verdict).toBe('INCONCLUSIVE');
    expect(decide({ n: 20, pHolm: 0.001, ci: [0.2, 0.4] }).verdict).toBe('INCONCLUSIVE'); // acceptance failure
    expect(decide({ n: 40, pHolm: 0.9, ci: [-0.1, 0.049] }).verdict).toBe('FALSIFIED');
    expect(decide({ n: 40, pHolm: 0.9, ci: [-0.1, 0.05] }).verdict).toBe('INCONCLUSIVE');
    expect(decide({ n: 0, pHolm: 1, ci: [null, null] }).verdict).toBe('INCONCLUSIVE');
  });

  it('summarize: primary on Stryker, Holm across both families, size controls, Stage B flagged unavailable', async () => {
    const { summarize } = await lib();
    const results = Array.from({ length: 36 }, (_, i) => ({
      id: `u${i}`, eligible: true, strengthen: { class: i < 2 ? 'no_retry' : 'ok' }, size: { added: i < 2 ? 0 : 50 + 10 * i, added_expects: i },
      families: { stryker: { n_mutants: 100, original: 0.3, strengthen: i < 2 ? null : 0.3 + ((i % 3) + 1) / 10 }, gym: { n_mutants: 12, original: 0.25, strengthen: i < 2 ? null : 0.25 } },
    }));
    const s = summarize(results as never, { nBoot: 500 });
    expect(s.families.stryker.n).toBe(36);
    expect(s.families.stryker.delta).toBeGreaterThan(0);
    expect(s.families.gym.sign.up).toBe(0);
    expect(s.families.stryker.p_holm).toBeGreaterThanOrEqual(s.families.stryker.sign.p);
    expect(s.families.stryker.per_protocol_ok_only.n).toBe(34);
    expect(s.families.stryker.size.small_subset.n).toBeGreaterThan(0);
    expect(s.families.stryker.size.regression_on_added_lines_per_100.n).toBe(36);
    expect(s.decision.verdict).toBe('SUPPORTED');
    expect(s.fresh_attempt_comparison.available).toBe(false);
  });
});
