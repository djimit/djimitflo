#!/usr/bin/env node
// M2 mutation-gap lane check: does the working-tree test kill more mutants of MUTATE_FILE than the committed one?
// Runs Stryker twice (committed test, working-tree test) and passes when the score gains >= MUTATE_MIN_GAIN points
// (default 10) or reaches 90. Without MUTATE_FILE it is a no-op, so hosts can list it in LOOP_DAEMON_CHECK_SCRIPTS.
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
  return valid ? Math.round((1000 * detected) / valid) / 10 : 0;
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

let before = 0;
let committed = '';
try { committed = execFileSync('git', ['show', `HEAD:${test}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* new test file */ }
if (committed) {
  const baseline = test.replace(/\.test\.ts$/, '.mutation-baseline.test.ts');
  fs.writeFileSync(baseline, committed);
  try { before = run(baseline) ?? 0; } finally { fs.rmSync(baseline, { force: true }); }
}
const after = run(test);
if (after === null) { console.error('mutation-gain: the working-tree test run failed'); process.exit(1); }
const pass = after >= before + minGain || after >= 90;
console.log(JSON.stringify({ mutation_gain: { file, test, before, after, gain: Math.round((after - before) * 10) / 10, min_gain: minGain, pass } }));
process.exit(pass ? 0 : 1);
