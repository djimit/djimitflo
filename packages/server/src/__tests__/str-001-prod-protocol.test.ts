import { expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { experimentDefs } from '../services/experiment-registry';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

/**
 * STR-001-PROD (docs/research/str-001-prod/PROTOCOL.md): the frozen pre-registration of the strengthen retry as a production
 * procedure. Nothing here runs a retry; it pins the protocol body, the frozen instruction text (byte-equal to the MFR-001
 * CONTROL / STR-001 Stage A strengthen arm) and the fact that nothing is activated before the start PR.
 */
const STR_PROD_PREREG_SHA256 = '279fb5fe84efe19ee81990c76cec3f5a5a21488571273f883ba16b1adfe8c405';
const STR_TEXT_SHA256 = '1a7cc5b85ae01a9f0d92ef434e9917406cd46984e4ed7e5126ed2491e2c8710f';
const STR_RENDERED_SHA256 = '2747d68433ce41602af0b0ab7193f3680c9b227b4aa00bcbaac7c028d5b8a0aa';
const STR_TEXT = 'Retry of a test-writing task: the vitest test file {test} already exists and covers {target}, but it is too weak: a subtly broken {target} can still pass it. Edit {test} so that it still passes against the real {target} and fails when {target} is subtly broken. Keep importing {target} with a relative import, do not mock it, skip nothing, and make it pass with: cd packages/server && npx vitest run {test_rel}. Change only {test}; do not edit {target} or any other file. Strengthen the assertions of this test.';
const render = (test: string, target: string) => STR_TEXT.replaceAll('{test_rel}', test.replace(/^packages\/server\//, ''))
  .replaceAll('{test}', test).replaceAll('{target}', target);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ROOT = join(__dirname, '../../../..');

it('the STR-001-PROD protocol fingerprint matches its body', () => {
  const doc = readFileSync(join(ROOT, 'docs/research/str-001-prod/PROTOCOL.md'), 'utf8');
  const [body, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(sha(body)).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(STR_PROD_PREREG_SHA256);
  // the registered design numbers and salts
  expect(body).toContain('**Required n: 49 labelled goals per arm**');
  expect(body).toContain("sha256('str-prod-001:' + root_goal_id)");
  expect(body).toContain("sha256('str-prod-001/holdout:' + root_goal_id)");
  expect(body).toContain('**10 % holdout**');
});

it('the protocol carries the frozen strengthen text verbatim, and its hash', () => {
  const body = readFileSync(join(ROOT, 'docs/research/str-001-prod/PROTOCOL.md'), 'utf8').split('\n---\nPREREG_SHA256: ')[0];
  expect(body).toContain(`\`${STR_TEXT}\``);
  expect(sha(STR_TEXT)).toBe(STR_TEXT_SHA256);
  expect(body).toContain(STR_TEXT_SHA256);
  expect(body).toContain(STR_RENDERED_SHA256);
});

it('the frozen text renders byte-equal to the MFR-001 CONTROL prompt (STR-001 Stage A strengthen arm)', async () => {
  const lib = await import(resolve(ROOT, 'scripts/mfr-001/lib.mjs'));
  // the source file is the one MFR-001 pinned at registration
  expect(sha(readFileSync(resolve(ROOT, 'scripts/mfr-001/lib.mjs'), 'utf8'))).toBe('16334c1b1521fc210f971cf8624e863578a2cd4adf98f919dab698d63be70fcd');
  const test = 'packages/server/src/__tests__/usage-telemetry.exports.test.ts'; const target = 'packages/server/src/services/usage-telemetry.ts';
  const ref = lib.buildPrompt({ test, target, arm: 'control' });
  expect(render(test, target)).toBe(ref);
  expect(sha(ref)).toBe(STR_RENDERED_SHA256);
  const other = { test: 'packages/server/src/__tests__/a/b.test.ts', target: 'packages/server/src/services/a/b.ts' };
  expect(render(other.test, other.target)).toBe(lib.buildPrompt({ ...other, arm: 'control' }));
  // the feedback arm (falsified, MFR-001) is never the treatment
  expect(lib.buildPrompt({ test, target, arm: 'feedback', survivors: [{ key: 'k', line: 1, before: 'a', after: 'b' }] })).not.toBe(ref);
});

it('pre-registration only: no registry entry and no flag exist before the start PR', () => {
  expect(experimentDefs().map((d) => d.id)).not.toContain('STR-001-PROD');
  expect(EVOLUTION_FLAGS.map((f) => f.name)).not.toContain('STR_PROD_001_MODE');
  // its salt is independent of every running experiment's salt
  for (const other of ['ace-001:', 'ste-001:', 'maker-deps-001:', 'effort-x1:', 'checker-family:']) {
    expect('str-prod-001:'.startsWith(other)).toBe(false);
    expect(other.startsWith('str-prod-001')).toBe(false);
  }
});
