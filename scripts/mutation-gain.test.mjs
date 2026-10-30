// OPS-001: mutation-gain.mjs fails closed when the baseline cannot be measured. Real Stryker never runs: a fake `npx` on
// PATH writes the report (or fails) per run, and each case gets its own throwaway git repo.
// Run: node scripts/mutation-gain.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mutation-gain.mjs');
const TEST = 'pkg/widget.test.ts';

/** Fake `npx stryker run`: FAKE_BASELINE / FAKE_CANDIDATE = a score 0..100, 'fail' (exit 1) or 'none' (no valid mutants). */
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('node:fs');
const which = process.env.MUTATE_TEST.includes('.mutation-baseline.') ? 'baseline' : 'candidate';
fs.appendFileSync(process.env.FAKE_NPX_LOG, which + '\\n');
const spec = process.env[which === 'baseline' ? 'FAKE_BASELINE' : 'FAKE_CANDIDATE'];
if (spec === 'fail') { console.error('stryker: compile error'); process.exit(1); }
const mutants = spec === 'none' ? [{ status: 'CompileError' }]
  : Array.from({ length: 100 }, (_, i) => ({ status: i < Number(spec) ? 'Killed' : 'Survived' }));
fs.writeFileSync(process.env.MUTATE_REPORT, JSON.stringify({ files: { 'pkg/widget.ts': { mutants } } }));
`;

function repo({ committed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-gain-'));
  const bin = path.join(dir, '.bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), FAKE_NPX, { mode: 0o755 });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'pkg')); fs.writeFileSync(path.join(dir, 'pkg/widget.ts'), 'export const x = 1;\n');
  if (committed) fs.writeFileSync(path.join(dir, TEST), 'committed test\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, TEST), 'working-tree test\n');
  return { dir, bin, git };
}

function gain(r, scores) {
  const log = path.join(r.dir, 'npx.log'); fs.writeFileSync(log, '');
  const p = spawnSync(process.execPath, [SCRIPT], {
    cwd: r.dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${r.bin}${path.delimiter}${process.env.PATH}`, MUTATE_FILE: 'pkg/widget.ts', MUTATE_TEST: TEST,
      FAKE_NPX_LOG: log, FAKE_BASELINE: String(scores.baseline), FAKE_CANDIDATE: String(scores.candidate) },
  });
  const line = p.stdout.split('\n').find((l) => l.startsWith('{"mutation_gain"'));
  return { code: p.status, out: line ? JSON.parse(line).mutation_gain : null, runs: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('a failed baseline run is not a 0: candidate 50 does not pass and no gain is reported', () => {
  const { code, out } = gain(repo(), { baseline: 'fail', candidate: 50 });
  assert.notEqual(code, 0);
  assert.equal(out.status, 'baseline_unavailable');
  assert.equal(out.before, null);
  assert.equal(out.gain, null);
  assert.equal(out.pass, false);
});

test('a baseline with no valid mutants is not a 0 either', () => {
  const { code, out } = gain(repo(), { baseline: 'none', candidate: 50 });
  assert.notEqual(code, 0);
  assert.equal(out.status, 'baseline_unavailable');
  assert.equal(out.pass, false);
});

test('valid baseline 40 + candidate 50 passes via the gain rule', () => {
  const { code, out, runs } = gain(repo(), { baseline: 40, candidate: 50 });
  assert.equal(code, 0);
  assert.deepEqual(runs, ['baseline', 'candidate']);
  assert.deepEqual({ status: out.status, before: out.before, after: out.after, gain: out.gain, rule: out.rule, pass: out.pass },
    { status: 'ok', before: 40, after: 50, gain: 10, rule: 'gain', pass: true });
});

test('valid baseline 95 + candidate 90 passes via the labelled absolute rule, not as a positive gain', () => {
  const { code, out } = gain(repo(), { baseline: 95, candidate: 90 });
  assert.equal(code, 0);
  assert.deepEqual({ status: out.status, gain: out.gain, rule: out.rule, pass: out.pass }, { status: 'ok', gain: -5, rule: 'absolute_90', pass: true });
});

test('below both rules fails with rule null', () => {
  const { code, out } = gain(repo(), { baseline: 40, candidate: 45 });
  assert.notEqual(code, 0);
  assert.deepEqual({ status: out.status, rule: out.rule, pass: out.pass }, { status: 'ok', rule: null, pass: false });
});

test('a test file absent at HEAD is new: before 0 is legitimate and no baseline runs', () => {
  const { code, out, runs } = gain(repo({ committed: false }), { baseline: 'fail', candidate: 50 });
  assert.equal(code, 0);
  assert.deepEqual(runs, ['candidate']);
  assert.deepEqual({ status: out.status, before: out.before, gain: out.gain, rule: out.rule }, { status: 'ok', before: 0, gain: 50, rule: 'gain' });
});

test('unreadable history (missing blob) is not a new file: fail closed, no Stryker run', () => {
  const r = repo();
  const blob = r.git('rev-parse', `HEAD:${TEST}`).trim();
  fs.rmSync(path.join(r.dir, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  const { code, out, runs } = gain(r, { baseline: 40, candidate: 50 });
  assert.notEqual(code, 0);
  assert.equal(out.status, 'baseline_history_unreadable');
  assert.deepEqual({ before: out.before, after: out.after, gain: out.gain, pass: out.pass }, { before: null, after: null, gain: null, pass: false });
  assert.deepEqual(runs, []);
});

test('unreadable history (no HEAD commit) fails closed too', () => {
  const r = repo();
  fs.rmSync(path.join(r.dir, '.git'), { recursive: true }); r.git('init', '-q');
  const { code, out } = gain(r, { baseline: 40, candidate: 50 });
  assert.notEqual(code, 0);
  assert.equal(out.status, 'baseline_history_unreadable');
});

test('a failed candidate run reports after null, never 0', () => {
  const { code, out } = gain(repo(), { baseline: 40, candidate: 'fail' });
  assert.notEqual(code, 0);
  assert.deepEqual({ status: out.status, before: out.before, after: out.after, gain: out.gain, pass: out.pass },
    { status: 'candidate_unavailable', before: 40, after: null, gain: null, pass: false });
});
