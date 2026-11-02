#!/usr/bin/env node
// M2 mutation-gap lane check: does the working-tree test kill more mutants of MUTATE_FILE than the committed one?
// Runs Stryker twice (committed test, working-tree test) and passes when the score gains >= MUTATE_MIN_GAIN points
// (default 10) or reaches 90. Without MUTATE_FILE it is a no-op, so hosts can list it in LOOP_DAEMON_CHECK_SCRIPTS.
// OPS-001: fails closed. A baseline that cannot be measured (Stryker error, no report, no valid mutants) or a HEAD that
// cannot be read is never a 0; only a test file absent at HEAD starts at 0. Every outcome prints one JSON line with a
// `status`; an unknown score is null.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { MUTATE_FILE: file, MUTATE_TEST: test } = process.env;
if (!file || !test) { console.log('mutation-gain: skipped (no MUTATE_FILE/MUTATE_TEST)'); process.exit(0); }
const minGain = Number(process.env.MUTATE_MIN_GAIN ?? 10);

export function score(report) {
  const counts = {};
  for (const f of Object.values(report.files)) for (const m of f.mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
  const valid = detected + (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
  return valid ? Math.round((1000 * detected) / valid) / 10 : null; // no valid mutant = not measured, not 0
}

function run(testPath) {
  const out = path.join(os.tmpdir(), `djimitflo-mutation-${process.pid}-${Date.now()}.json`);
  const r = spawnSync('npx', ['stryker', 'run', 'stryker.service.config.mjs'], {
    env: { ...process.env, MUTATE_TEST: testPath, MUTATE_REPORT: out }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0 || !fs.existsSync(out)) { console.error(r.stdout?.slice(-2000), r.stderr?.slice(-2000)); return null; }
  const s = score(JSON.parse(fs.readFileSync(out, 'utf8'))); fs.rmSync(out, { force: true });
  return s;
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const report = (status, before, after, rule = null) => {
  const pass = status === 'ok' && rule !== null;
  console.log(JSON.stringify({ mutation_gain: { status, file, test, before, after,
    gain: before !== null && after !== null ? Math.round((after - before) * 10) / 10 : null, min_gain: minGain, rule, pass } }));
  process.exit(pass ? 0 : 1);
};

// ls-tree: empty output = absent at HEAD (new test file); any git error = history unreadable, not "new"
let committed = null;
try { if (git(['ls-tree', 'HEAD', '--', test]).trim()) committed = git(['show', `HEAD:${test}`]); }
catch (e) { console.error(String(e.stderr ?? e.message).slice(-2000)); report('baseline_history_unreadable', null, null); }
let before = 0;
if (committed !== null) {
  const baseline = test.replace(/\.test\.ts$/, '.mutation-baseline.test.ts');
  fs.writeFileSync(baseline, committed);
  try { before = run(baseline); } finally { fs.rmSync(baseline, { force: true }); }
  if (before === null) { console.error('mutation-gain: the baseline (committed test) run failed'); report('baseline_unavailable', null, null); }
}
const after = run(test);
if (after === null) { console.error('mutation-gain: the working-tree test run failed'); report('candidate_unavailable', before, null); }
report('ok', before, after, after >= before + minGain ? 'gain' : after >= 90 ? 'absolute_90' : null);
