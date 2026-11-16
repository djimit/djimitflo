// Run: node scripts/time-travel-tests.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { dateBombs, outcomes, parseArgs, summarize } from './time-travel-tests.mjs';

const report = (tests, extra = []) => ({
  testResults: [
    { name: '/ws/src/a.test.ts', status: 'failed', assertionResults: tests.map(([title, status, msg]) => ({ ancestorTitles: ['A'], title, fullName: `A ${title}`, status, failureMessages: msg ? [msg] : [] })) },
    ...extra,
  ],
});

test('outcomes keys each test by workspace-relative file and full name; a crashed file is one <file> entry', () => {
  const o = outcomes(report([['x', 'passed']], [{ name: '/ws/src/b.test.ts', status: 'failed', message: '\nboom\nstack', assertionResults: [] }]), '/ws');
  assert.deepEqual(o.get('src/a.test.ts > A x'), { file: 'src/a.test.ts', test: 'A x', status: 'passed', error: null });
  assert.deepEqual(o.get('src/b.test.ts > <file>'), { file: 'src/b.test.ts', test: '<file>', status: 'failed', error: 'boom' });
});

test('a date bomb passes at 0 and fails or vanishes at N; failing at 0 too, or skipped at N, is not one', () => {
  const base = outcomes(report([['ok', 'passed'], ['bomb', 'passed'], ['gone', 'passed'], ['broken', 'failed'], ['skip', 'passed']]), '/ws');
  const shifted = outcomes(report([['ok', 'passed'], ['bomb', 'failed', 'expected 3 to be 2\n  at x'], ['broken', 'failed'], ['skip', 'skipped']]), '/ws');
  assert.deepEqual(dateBombs(base, shifted), [
    { file: 'src/a.test.ts', test: 'A bomb', status: 'failed', error: 'expected 3 to be 2' },
    { file: 'src/a.test.ts', test: 'A gone', status: 'missing', error: null },
  ]);
  assert.deepEqual(dateBombs(base, base), []);
});

test('parseArgs: defaults, horizons, workspace and file list; bad input is refused', () => {
  const d = parseArgs([]);
  assert.deepEqual([d.days, d.workspace, d.confirm, d.files], [[7, 30], 'server', true, []]);
  const o = parseArgs(['--days', '7, 30,90', '--workspace', 'dashboard', '--no-confirm', '--out', 'r.json', 'src/x.test.ts']);
  assert.deepEqual([o.days, o.workspace, o.confirm, o.out, o.files], [[7, 30, 90], 'dashboard', false, 'r.json', ['src/x.test.ts']]);
  assert.throws(() => parseArgs(['--days', '0']), /non-zero/);
  assert.throws(() => parseArgs(['--days', 'x']), /non-zero/);
  assert.throws(() => parseArgs(['--workspace', '../etc']), /workspace/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});

test('summarize lists each horizon with its bombs', () => {
  const s = summarize({ workspace: 'server', baseline: { passed: 9, failed: 1 }, horizons: [
    { days: 7, dateBombs: [], flaky: [] },
    { days: 30, dateBombs: [{ file: 'src/a.test.ts', test: 'A bomb', status: 'failed', error: 'e' }], flaky: [{ file: 'src/c.test.ts', test: 'C f' }] },
  ] });
  assert.match(s, /\+7d: 0 date bomb\(s\)\n\+30d: 1 date bomb\(s\), 1 unconfirmed \(flaky\)\n {2}BOMB src\/a\.test\.ts > A bomb \[failed\] — e\n {2}flaky src\/c\.test\.ts > C f/);
});
