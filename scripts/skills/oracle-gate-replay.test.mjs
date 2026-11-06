// L1/M1 oracle-gate replay harness: reference verdicts, command dir, lockfile choice, and the dry-run default.
// Run: node scripts/skills/oracle-gate-replay.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandCwd, lockDiff, referenceVerdict } from './oracle-gate-replay.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oracle-gate-replay.mjs');
const oracle = (status, pass, before = 60, after = 75) => JSON.stringify({ mutation_gain: { status, before, after, pass } });
const prod = (...pairs) => pairs.map(([name, exit_status]) => ({ name, exit_status }));

test('mutation reference: the lane-oracle replay decides; no test change = FAIL; baseline_unavailable falls back to prod, else undecidable', () => {
  const m = { lane: 'mutation' };
  assert.equal(referenceVerdict(m, { changed: 'M a.test.ts', oracle: oracle('ok', true) }).verdict, true);
  assert.equal(referenceVerdict(m, { changed: 'M a.test.ts', oracle: oracle('ok', false) }).verdict, false);
  assert.equal(referenceVerdict(m, { changed: 'M a.test.ts', oracle: oracle('candidate_unavailable', false) }).verdict, false);
  assert.equal(referenceVerdict(m, { changed: '' }).verdict, false);
  assert.equal(referenceVerdict({ ...m, deterministic_checks: prod(['test:mutation:grounded', 1]) }, { changed: 'M', oracle: oracle('baseline_unavailable', false) }).verdict, false);
  assert.equal(referenceVerdict(m, { changed: 'M', oracle: oracle('baseline_unavailable', false) }).verdict, null);
  assert.equal(referenceVerdict(m, undefined).verdict, null);
});

test('exports reference: prod daemon checks all exit 0 = PASS, any failure or timeout = FAIL, not recorded = undecidable', () => {
  const e = (checks) => referenceVerdict({ lane: 'exports', deterministic_checks: checks }, undefined).verdict;
  assert.equal(e(prod(['test:changed', 0], ['lint', 0], ['type-check', 0])), true);
  assert.equal(e(prod(['test:changed', 1], ['lint', 0], ['type-check', 0])), false);
  assert.equal(e(prod(['test:changed', null], ['lint', 0], ['type-check', 0])), false);
  assert.equal(e([]), null);
});

test('commandCwd: the root for root-relative paths, the package dir for package-relative test paths', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ogr-cwd-'));
  fs.mkdirSync(path.join(wt, 'packages/server/src/__tests__'), { recursive: true });
  // agent-catalog sorts first and also has src/__tests__: the package holding the file wins, not the first with the dir
  fs.mkdirSync(path.join(wt, 'packages/agent-catalog/src/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'packages/server/src/__tests__/x.exports.test.ts'), '');
  assert.equal(commandCwd(['npx', 'vitest', 'run', 'src/__tests__/x.exports.test.ts'], wt), 'packages/server');
  assert.equal(commandCwd(['npx', 'vitest', 'run', 'src/__tests__/missing.test.ts'], wt), '.');
  assert.equal(commandCwd(['MUTATE_TEST=packages/server/src/__tests__/x.test.ts', 'npm', 'run', 'test:mutation:grounded'], wt), '.');
  fs.writeFileSync(path.join(wt, 'packages/server/src/__tests__/y.test.ts'), '');
  assert.equal(commandCwd(['npx', 'vitest', 'run', 'packages/server/src/__tests__/y.test.ts'], wt), '.');
});

test('lockDiff lists the base lock versions an installed checkout does not have', () => {
  const lock = (v) => ({ packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: v } } });
  assert.deepEqual(lockDiff(lock('2.0.0'), lock('2.0.0')), []);
  assert.deepEqual(lockDiff(lock('2.0.0'), lock('2.1.0')), ['b@2.0.0']);
  assert.deepEqual(lockDiff(lock('2.0.0'), null), ['a@1.0.0', 'b@2.0.0']);
});

test('without --apply it is a dry run that creates no worktree; an unknown flag exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogr-dry-'));
  const cases = path.join(dir, 'cases.json');
  fs.writeFileSync(cases, JSON.stringify([{ lane: 'mutation', lease: 'abcdef0123', created: '2026-11-01T00:00:00Z', status: 'failed', rt: 'opencode',
    grounding: { runtimeCommand: 'MUTATE_FILE=a.ts MUTATE_TEST=a.test.ts npm run test:mutation:grounded' }, diff: 'diff --git a/a b/a\n' }]));
  const before = spawnSync('git', ['worktree', 'list'], { encoding: 'utf8' }).stdout;
  const r = spawnSync(process.execPath, [SCRIPT, '--cases', cases, '--out', path.join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  assert.equal(spawnSync('git', ['worktree', 'list'], { encoding: 'utf8' }).stdout, before);
  assert.doesNotMatch(r.stdout, /diff --git/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--cases', cases, '--out', dir, '--bogus'], { encoding: 'utf8' }).status, 2);
});
