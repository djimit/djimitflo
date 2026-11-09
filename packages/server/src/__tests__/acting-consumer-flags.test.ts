import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

// Drift guard (fitness-contract review, PR #1188): SETTLEMENT_EXECUTION_MODE, GRADED_FITNESS_MODE and DREAM_PROMOTION_RULE
// were registered acting:false although auto-merge / promotion read them or what they record, so the fitness-contract
// coverage skipped them. A flag that a merge, promotion or gate decision reads must be registered acting.

const ROOT = path.resolve(__dirname, '..');
/** Code paths whose output is a merge, a promotion or a gate verdict. */
const ACTING_CONSUMERS = [
  'services/loop-auto-merge.ts', 'services/loop-auto-merge-state.ts', // test-only auto-merge, value gate, settlement revoke
  'services/dream-evolution.ts', 'services/genome-promotion.ts', // genome trial decision and promotion
  'services/evolve-selection.ts', // evolve winner (graded contest)
  'services/governance-gate-service.ts', 'services/gym-gate-policy.ts', // gates
];
/** Registered flags a consumer reads that never change its decision. Each needs the reason it is safe. */
const RECORD_ONLY_READS: Readonly<Record<string, string>> = {
  TRIAL_DIAGNOSTICS_ENABLED: 'dream-evolution.ts RX-4: writes genome_trial_results power rows after the decision; never changes it',
};
/** Flags read elsewhere whose recorded output a consumer reads: [consumer, source pattern that proves the read]. */
const PRODUCER_FLAGS: Readonly<Record<string, Array<[string, RegExp]>>> = {
  GRADED_FITNESS_MODE: [
    ['services/loop-auto-merge.ts', /\$\.graded'/], // maker lease metadata.graded → autoMergeValueSignal (value gate)
    ['services/dream-evolution.ts', /startsWith\('graded:'\)/], // gym graded: refs → DREAM_PROMOTION_RULE=graded
  ],
  SETTLEMENT_EXECUTION_MODE: [['services/loop-auto-merge.ts', /latestSettlements\(db\)/]], // settlement_execution rows → lane revoke
};

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** env.X / process.env.X / env['X'] names in a source text, comments removed */
function envReads(src: string): string[] {
  const names = new Set<string>();
  for (const m of stripComments(src).matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g)) names.add(m[1] || m[2]);
  return [...names].sort();
}
/** registered non-acting flags read by a consumer, minus the reasoned record-only reads */
function violations(sources: Array<[string, string]>, flags: ReadonlyArray<{ name: string; acting: boolean }>, recordOnly = RECORD_ONLY_READS): string[] {
  const nonActing = new Set(flags.filter((f) => !f.acting).map((f) => f.name));
  return sources.flatMap(([file, src]) => envReads(src).filter((n) => nonActing.has(n) && !(recordOnly[n] ?? '').trim()).map((n) => `${n} (${file})`));
}
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const consumerSources = (): Array<[string, string]> => ACTING_CONSUMERS.map((f) => [f, read(f)]);

it('every registered flag an acting consumer reads is acting (or a reasoned record-only read)', () => {
  const sources = consumerSources();
  expect(sources.flatMap(([, s]) => envReads(s)).length).toBeGreaterThan(10); // the scan sees the reads
  expect(violations(sources, EVOLUTION_FLAGS)).toEqual([]);
});

it('a flag whose recorded output an acting consumer reads is acting, and the read still exists', () => {
  for (const [flag, reads] of Object.entries(PRODUCER_FLAGS)) {
    expect(EVOLUTION_FLAGS, flag).toContainEqual({ name: flag, acting: true });
    for (const [file, re] of reads) expect(re.test(read(file)), `${flag}: ${file} no longer matches ${re}`).toBe(true);
  }
});

it('the record-only list stays honest: registered non-acting, read by a consumer, a reason each', () => {
  const seen = new Set(consumerSources().flatMap(([, s]) => envReads(s)));
  for (const [flag, why] of Object.entries(RECORD_ONLY_READS)) {
    expect(EVOLUTION_FLAGS, flag).toContainEqual({ name: flag, acting: false });
    expect(seen.has(flag), `${flag} is no longer read by an acting consumer`).toBe(true);
    expect(why.trim().length).toBeGreaterThanOrEqual(20);
  }
});

it('negative: a non-acting flag read in a consumer is reported; comments and acting flags are not', () => {
  const flags = [{ name: 'FAKE_SHADOW_FLAG', acting: false }, { name: 'FAKE_ACTING_FLAG', acting: true }];
  const src = `const a = process.env.FAKE_SHADOW_FLAG === 'on'; const b = env['FAKE_ACTING_FLAG']; // env.FAKE_SHADOW_FLAG in a comment`;
  expect(violations([['services/fake.ts', src]], flags, {})).toEqual(['FAKE_SHADOW_FLAG (services/fake.ts)']);
  expect(violations([['services/fake.ts', '/* env.FAKE_SHADOW_FLAG */ const c = env.FAKE_ACTING_FLAG;']], flags, {})).toEqual([]);
  expect(violations([['services/fake.ts', src]], flags, { FAKE_SHADOW_FLAG: 'records only, never changes the decision' })).toEqual([]);
});
