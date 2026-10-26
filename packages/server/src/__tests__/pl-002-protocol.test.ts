import { expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { guardLines } from '../services/dream-evolution';
import { PROCEDURE_LINES, linesSha256 } from '../services/procedure-selector';

/**
 * PL-002 (docs/research/procedure-loop/PL-002_KARPATHY_DELTA.md): the frozen pre-registration and its candidate lines.
 * The lines live only here and in the protocol: nothing in this PR delivers them to any maker.
 */
const PL002_PREREG_SHA256 = '4d080a682fdcb75018b2295294e23013de091745f31a6133fb9f98aac94bad42';
const PL002_LINES_SHA256 = '095c9c956066b57dbdd5114e0cedfd17ae09d05fd759cdf5697f5f474b9ac532';
const PL002_LINES = [
  'Before the first edit, confirm yourself, in the source and the named test, each fact the fix depends on; nobody is available to answer questions.',
  'When the task allows more than one reading, pick the one that keeps the edit smallest and easiest to undo inside the named file, then continue.',
  'Before editing, state in one sentence the exact result that means done: which named test must pass and which single file may differ.',
  'For a behaviour change, do not stop at green: ask whether a plausible wrong solution would also pass the named test, and if so, make your work match the intended behaviour.',
];

it('the PL-002 protocol fingerprint matches its body, and it pins the candidate lines', () => {
  const doc = readFileSync(join(__dirname, '../../../../docs/research/procedure-loop/PL-002_KARPATHY_DELTA.md'), 'utf8');
  const [body, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(createHash('sha256').update(body).digest('hex')).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(PL002_PREREG_SHA256);
  expect(linesSha256(PL002_LINES)).toBe(PL002_LINES_SHA256);
  for (const line of PL002_LINES) expect(body).toContain(`\`${line}\``);
  expect(body).toContain(PL002_LINES_SHA256);
  // a different treatment from PL-001's procedure
  expect(linesSha256(PL002_LINES)).not.toBe(linesSha256(PROCEDURE_LINES));
});

it('the candidate lines pass the dream-evolution genome line guard unchanged, and the guard still bites', () => {
  expect(guardLines([...PL002_LINES])).toEqual(PL002_LINES);
  for (const line of PL002_LINES) expect(guardLines([line])).toEqual([line]);
  expect(guardLines(['Run the type-check first.'])).toBeNull();
});

it('the gym worker would deliver every candidate line and its fire check would find all four', async () => {
  const worker = await import(resolve(__dirname, '../../../../scripts/gym-worker.mjs'));
  const repair = { commit: 'c1', source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'] };
  const sentB = worker.makerInput({}, repair, false, PL002_LINES);
  expect(worker.fireCheck(sentB, PL002_LINES)).toMatchObject({ genome_lines: 4, genome_lines_found: 4 });
  const sentA = worker.makerInput({}, repair, false, []);
  expect(worker.fireCheck(sentA, PL002_LINES).genome_lines_found).toBe(0);
  const writeTest = { commit: 'w1', source: 'packages/server/src/__tests__/y.test.ts', target: 'packages/server/src/services/y.ts', tests: ['packages/server/src/__tests__/y.test.ts'] };
  expect(worker.fireCheck(worker.makerInput({}, writeTest, true, PL002_LINES), PL002_LINES).genome_lines_found).toBe(4);
});
