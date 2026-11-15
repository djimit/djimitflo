#!/usr/bin/env node
// Date-bomb detector: a date bomb is a test that passes today and fails on a later date because it mixes a fixed date with
// code that reads the real clock. Runs a workspace's vitest suite (or the given files) at TIME_TRAVEL_DAYS=0 and at each
// horizon N, and reports the tests that pass at 0 and fail (or vanish) at N. A test that fails at 0 too is an ordinary
// failure, not a date bomb. packages/<workspace>/src/__tests__/helpers/time-travel.ts (a vitest setup file) does the shift.
// Suspects are re-run once at 0 and at N (only their files) and kept only when the result repeats, so a flaky test is
// reported apart. Exit: 0 no date bombs, 1 date bombs found, 2 the harness could not measure (no report, or nothing passed
// at 0).
//
//   node scripts/time-travel-tests.mjs [--days 7,30] [--workspace server] [--out file.json] [--no-confirm] [--verbose] [files...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

export function parseArgs(argv) {
  const opts = { days: [7, 30], workspace: 'server', out: path.join('reports', 'time-travel', 'report.json'), confirm: true, verbose: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') opts.days = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    else if (a === '--workspace') opts.workspace = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-confirm') opts.confirm = false;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  if (!opts.days.length || opts.days.some((d) => !Number.isInteger(d) || d === 0)) throw new Error('--days needs non-zero integers, e.g. 7,30');
  if (!/^[\w-]+$/.test(opts.workspace ?? '')) throw new Error('--workspace needs a package directory name, e.g. server');
  return opts;
}

/** vitest's JSON report → Map("<file> > <full name>" → { file, test, status, error }). A file that failed without any
 *  test result (an import or a beforeAll that threw) is one entry with test "<file>". */
export function outcomes(report, baseDir) {
  const out = new Map();
  for (const f of report?.testResults ?? []) {
    const file = path.relative(baseDir, f.name).split(path.sep).join('/');
    const tests = f.assertionResults ?? [];
    if (!tests.length) {
      out.set(`${file} > <file>`, { file, test: '<file>', status: f.status === 'passed' ? 'passed' : 'failed', error: firstLine(f.message) });
      continue;
    }
    for (const t of tests) {
      const test = t.fullName || [...(t.ancestorTitles ?? []), t.title].join(' ');
      out.set(`${file} > ${test}`, { file, test, status: t.status, error: firstLine(t.failureMessages?.[0]) });
    }
  }
  return out;
}

function firstLine(msg) {
  return msg ? String(msg).split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? null : null;
}

/** Passed at day 0, not passed at day N: failed, or missing (its file crashed). Skipped at N is not a failure. */
export function dateBombs(base, shifted) {
  const out = [];
  for (const [key, b] of base) {
    if (b.status !== 'passed') continue;
    const s = shifted.get(key);
    if (s && (s.status === 'passed' || s.status === 'skipped' || s.status === 'pending' || s.status === 'todo')) continue;
    out.push({ file: b.file, test: b.test, status: s ? s.status : 'missing', error: s?.error ?? null });
  }
  return out;
}

const count = (m, status) => [...m.values()].filter((o) => o.status === status).length;

function runVitest(opts, days, files) {
  const outFile = path.join(os.tmpdir(), `djimitflo-time-travel-${process.pid}-${days}-${Date.now()}.json`);
  const cwd = path.join(ROOT, 'packages', opts.workspace);
  const r = spawnSync(process.execPath, [VITEST, 'run', '--reporter=json', `--outputFile=${outFile}`, ...files], {
    cwd, env: { ...process.env, TIME_TRAVEL_DAYS: String(days) }, stdio: opts.verbose ? 'inherit' : 'ignore',
  });
  if (!fs.existsSync(outFile)) throw new Error(`vitest at +${days}d wrote no report (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`);
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.rmSync(outFile, { force: true });
  return outcomes(report, cwd);
}

export function summarize(result) {
  const lines = [`time-travel (${result.workspace}): baseline +0d ${result.baseline.passed} passed, ${result.baseline.failed} failed`];
  for (const h of result.horizons) {
    lines.push(`+${h.days}d: ${h.dateBombs.length} date bomb(s)${h.flaky.length ? `, ${h.flaky.length} unconfirmed (flaky)` : ''}`);
    for (const b of h.dateBombs) lines.push(`  BOMB ${b.file} > ${b.test} [${b.status}]${b.error ? ` — ${b.error}` : ''}`);
    for (const b of h.flaky) lines.push(`  flaky ${b.file} > ${b.test}`);
  }
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = runVitest(opts, 0, opts.files);
  const result = {
    generatedAt: new Date().toISOString(), workspace: opts.workspace, files: opts.files,
    baseline: { passed: count(base, 'passed'), failed: count(base, 'failed'), total: base.size,
      failures: [...base.values()].filter((o) => o.status === 'failed') }, // ordinary failures: red today, not date bombs
    horizons: [],
  };
  if (!result.baseline.passed) throw new Error('nothing passed at +0d; the suite could not be measured');
  for (const days of opts.days) {
    let bombs = dateBombs(base, runVitest(opts, days, opts.files));
    let flaky = [];
    if (opts.confirm && bombs.length) {
      const files = [...new Set(bombs.map((b) => b.file))];
      const again = dateBombs(runVitest(opts, 0, files), runVitest(opts, days, files));
      const confirmed = new Set(again.map((b) => `${b.file} > ${b.test}`));
      flaky = bombs.filter((b) => !confirmed.has(`${b.file} > ${b.test}`));
      bombs = bombs.filter((b) => confirmed.has(`${b.file} > ${b.test}`));
    }
    result.horizons.push({ days, dateBombs: bombs, flaky });
  }
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(summarize(result));
  console.log(`report: ${opts.out}`);
  return result.horizons.some((h) => h.dateBombs.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`time-travel: ${err.message}`);
    process.exitCode = 2;
  }
}
