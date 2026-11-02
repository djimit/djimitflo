import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EVOLUTION_FLAGS, buildEvolutionEvidence, fisherExact } from '../services/evolution-evidence';
import { FBPA_CHECK, failBeforePassAfterEvidence, failBeforePassAfterMode, recordFailBeforePassAfter, withoutHiddenChecks, type TestRunner } from '../services/fail-before-pass-after';

const TARGET = 'packages/server/src/services/widget.ts';
const TEST = 'packages/server/src/__tests__/widget.test.ts';
const EXISTING = 'packages/server/src/__tests__/widget-existing.test.ts';
const HELPER = 'packages/server/src/__tests__/helpers/fixture.ts';
// three operator lines, so the graded-fitness seeded-mutant helper finds three distinct mutants
const SOURCE = 'export const a = (x: number): boolean => x > 1;\nexport const b = (x: number): boolean => x === 2;\nexport const c = (p: boolean, q: boolean): boolean => p && q;\n';
const STRONG = "import { a, b, c } from '../services/widget.ts';\nconst ok = a(2) === true && a(1) === false && b(2) === true && b(3) === false && c(true, false) === false && c(true, true) === true;\nif (!ok) throw new Error('widget');\n";
const VACUOUS = "import { a } from '../services/widget.ts';\nif (typeof a !== 'function') throw new Error('widget');\n";

let db: Database.Database; let wt: string;
const now = new Date().toISOString();
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), text); };
const readWt = (f: string) => fs.readFileSync(path.join(wt, f), 'utf8');
const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);
/** A real runner: each test file is a node script (type-stripped TS) that throws on a wrong result. */
const calls: string[][] = [];
const nodeRunner: TestRunner = (cwd, tests) => {
  calls.push(tests);
  return tests.every((t) => spawnSync(process.execPath, ['--experimental-strip-types', t], { cwd, stdio: 'ignore' }).status === 0) ? 'pass' : 'fail';
};
const SHADOW = { FAIL_BEFORE_PASS_AFTER_MODE: 'shadow' };

function seed(evidence: string[], changed: string[], leaseMeta: Record<string, unknown> = {}, status = 'completed', id = 'm-1', run = 'run-1') {
  if (!db.prepare("SELECT 1 FROM self_improvements WHERE id = 'p-1'").get()) {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
      VALUES ('p-1', 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, ?, ?, ?)`).run(JSON.stringify(evidence), JSON.stringify({ artifactPath: TEST, target: TARGET }), now, now);
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g-1', 'o', 'low', 'running', '{}', 'p-1', ?, ?)`).run(now, now);
  }
  if (!db.prepare('SELECT 1 FROM loop_runs WHERE id = ?').get(run)) db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, goal_id, created_at, updated_at) VALUES (?, 'test-gap', 'closed', 'running', '[]', 'g-1', ?, ?)`).run(run, now, now);
  const checks = [{ name: 'test', status: 'pass', exit_status: 0 }, { name: 'lint', status: 'pass', exit_status: 0 }];
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', ?, ?, ?, ?, ?)`)
    .run(id, run, status, wt, JSON.stringify({ changed_files: changed, deterministic_checks: checks, ...leaseMeta }), now, now);
}

beforeEach(() => {
  calls.length = 0;
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fbpa-'));
  write('packages/server/package.json', '{ "type": "module" }\n');
  write(TARGET, SOURCE);
  write(HELPER, 'export const two = 2;\n');
  write(EXISTING, "import { b } from '../services/widget.ts';\nimport { two } from './helpers/fixture.ts';\nif (b(two) !== true) throw new Error('existing');\n");
  const git = (...a: string[]) => execFileSync('git', ['-C', wt, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'parent');
});
afterEach(() => { db.close(); fs.rmSync(wt, { recursive: true, force: true }); });

it('flag: FAIL_BEFORE_PASS_AFTER_MODE off|shadow, default off; listed as a non-acting evolution flag', () => {
  expect([failBeforePassAfterMode({}), failBeforePassAfterMode(SHADOW), failBeforePassAfterMode({ FAIL_BEFORE_PASS_AFTER_MODE: 'enforce' })]).toEqual(['off', 'shadow', 'off']);
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'FAIL_BEFORE_PASS_AFTER_MODE', acting: false });
});

it('mode off: nothing recorded, nothing run', () => {
  write(TEST, STRONG); seed(['test-gap:widget'], [TEST]);
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: {}, run: nodeRunner })).toBeNull();
  expect(meta('m-1').deterministic_checks.map((c: { name: string }) => c.name)).toEqual(['test', 'lint']);
  expect(calls).toEqual([]);
});

it('a proper test-gap test: fails on a seeded mutant, passes after, existing tests still pass → pass; never a gate', () => {
  write(TEST, STRONG); seed(['test-gap:widget'], [TEST]);
  const r = recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner });
  expect(r).toMatchObject({ name: FBPA_CHECK, mode: 'shadow', status: 'skipped', shadow_status: 'pass', exit_status: null,
    fail_before: true, pass_after: true, pass_to_pass: true, before: 'seeded_mutant', p2p_tests: 1 });
  expect(calls).toContainEqual(['src/__tests__/widget-existing.test.ts']); // PASS_TO_PASS ran the existing test of the target
  const m = meta('m-1');
  expect(m.deterministic_checks.map((c: { name: string }) => c.name)).toEqual(['test', 'lint', FBPA_CHECK]);
  // the check never changes a gate: lease still completed, the other checks untouched, every check pass|skipped
  expect((db.prepare("SELECT status FROM worker_leases WHERE id = 'm-1'").get() as { status: string }).status).toBe('completed');
  expect(m.deterministic_checks.every((c: { status: string }) => c.status === 'pass' || c.status === 'skipped')).toBe(true);
  expect(withoutHiddenChecks(m.deterministic_checks).map((c: { name: string }) => c.name)).toEqual(['test', 'lint']);
  expect(readWt(TARGET)).toBe(SOURCE); expect(readWt(TEST)).toBe(STRONG);
  // idempotent
  const n = calls.length;
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner })).toBeNull();
  expect(calls.length).toBe(n);
});

it('a test that passes both before and after → fail-before violated (seeded mutants and parent source)', () => {
  write(TEST, VACUOUS); seed(['test-gap:widget'], [TEST]);
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner })).toMatchObject({ shadow_status: 'fail', fail_before: false, pass_after: true, pass_to_pass: true });
  expect(readWt(TARGET)).toBe(SOURCE);
});

it('reuses the graded-fitness mutant kills instead of re-running the mutants', () => {
  write(TEST, VACUOUS); seed(['test-gap:widget'], [TEST], { graded: { kind: 'mutant_kill', killed: 2, total: 3, score: 0.667, ms: 1 } });
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner })).toMatchObject({ shadow_status: 'pass', fail_before: true });
  expect(calls.filter((c) => c.includes('src/__tests__/widget.test.ts')).length).toBe(1); // only PASS-AFTER
});

describe('finding-fix (source changes): before = the parent source', () => {
  const FIXED = SOURCE.replace('x > 1', 'x >= 1');
  const TEST_FIX = "import { a } from '../services/widget.ts';\nif (a(1) !== true) throw new Error('fix');\n";
  it('a test that fails on the parent source and passes with the fix → pass', () => {
    write(TARGET, FIXED); write(TEST, TEST_FIX); seed(['finding-fix:f-1'], [TARGET, TEST]);
    expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner })).toMatchObject({ shadow_status: 'pass', before: 'parent_source', fail_before: true, pass_after: true, pass_to_pass: true });
    expect(readWt(TARGET)).toBe(FIXED);
  });
  it('a test that also passes on the parent source → fail-before violated', () => {
    write(TARGET, FIXED); write(TEST, VACUOUS); seed(['finding-fix:f-1'], [TARGET, TEST]);
    expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner })).toMatchObject({ shadow_status: 'fail', before: 'parent_source', fail_before: false });
    expect(readWt(TARGET)).toBe(FIXED);
  });
});

it('a change that breaks an existing test → PASS_TO_PASS violated; the worktree is left as the maker made it', () => {
  write(TEST, STRONG); write(HELPER, 'export const two = 3;\n'); seed(['test-gap:widget'], [HELPER, TEST]);
  const r = recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner });
  expect(r).toMatchObject({ shadow_status: 'fail', fail_before: true, pass_after: true, pass_to_pass: false });
  expect(r!.reasons.join(' ')).toMatch(/pass-to-pass violated/);
  expect(readWt(HELPER)).toBe('export const two = 3;\n'); expect(readWt(TEST)).toBe(STRONG);
});

it('an existing test already red at the parent is unknown (pre-existing), never a violation → skipped', () => {
  write(EXISTING, "import { b } from '../services/widget.ts';\nif (b(2)) throw new Error('red at parent');\n");
  execFileSync('git', ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'red'], { stdio: 'ignore' });
  write(TEST, STRONG); seed(['test-gap:widget'], [TEST]);
  const r = recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner });
  expect(r).toMatchObject({ shadow_status: 'skipped', fail_before: true, pass_after: true, pass_to_pass: null, p2p_tests: 1 });
  expect(r!.reasons).toContain('pass-to-pass: existing tests already red at parent');
});

it('not an oracle lane, no test change or a failed maker: nothing recorded', () => {
  write(TEST, STRONG);
  seed(['reflection:x'], [TEST]);
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-1', { env: SHADOW, run: nodeRunner })).toBeNull();
  db.prepare("UPDATE self_improvements SET evidence_refs_json = ? WHERE id = 'p-1'").run(JSON.stringify(['test-gap:widget']));
  seed(['test-gap:widget'], [TARGET], {}, 'completed', 'm-2');
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-2', { env: SHADOW, run: nodeRunner })).toBeNull();
  seed(['test-gap:widget'], [TEST], {}, 'failed', 'm-3');
  expect(recordFailBeforePassAfter(db, 'run-1', 'm-3', { env: SHADOW, run: nodeRunner })).toBeNull();
  expect(calls).toEqual([]);
});

describe('evidence fail_before_pass_after', () => {
  const DAY = 86_400_000; const NOW = Date.parse('2026-12-01T00:00:00Z');
  function settledRun(i: number, verdict: 'pass' | 'fail' | 'skipped', survived: boolean | null, superseded = false) {
    const created = new Date(NOW - 40 * DAY).toISOString();
    const merged = new Date(NOW - 30 * DAY).toISOString();
    const outcome = survived === null ? { state: 'merged', merged_at: new Date(NOW - 2 * DAY).toISOString(), checked_at: new Date(NOW - 3_600_000).toISOString() }
      : { state: 'merged', merged_at: merged, settled_at: new Date(NOW - 10 * DAY + i * 1000).toISOString(), survived, checked_at: new Date(NOW - 10 * DAY).toISOString() };
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES (?, 'test-gap', 'closed', 'completed', '[]', ?, ?, ?)`)
      .run(`r-${i}`, JSON.stringify({ pr_url: `https://github.com/djimit/djimitflo/pull/${1000 + i}`, pr_outcome: outcome }), created, created);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', ?, ?, ?)`)
      .run(`l-${i}`, `r-${i}`, JSON.stringify({ deterministic_checks: [{ name: FBPA_CHECK, mode: 'shadow', status: 'skipped', shadow_status: verdict, fail_before: verdict !== 'fail', pass_after: true, pass_to_pass: true }],
        ...(superseded ? { superseded_by_maker_lease_id: 'other' } : {}) }), created, created);
  }

  it('is a key of the evolution evidence; empty → INSUFFICIENT, no rates', () => {
    const e = buildEvolutionEvidence(db, {}, NOW);
    expect(e.fail_before_pass_after).toMatchObject({ experiment: 'R2', mode: 'off', runs: 0, settled_runs: 0, primary: null, verdict: 'INSUFFICIENT' });
  });

  it('below 40 settled runs: descriptive counts only (no difference, no p); superseded makers excluded', () => {
    for (let i = 0; i < 20; i++) settledRun(i, 'pass', true);
    for (let i = 20; i < 30; i++) settledRun(i, 'fail', false);
    settledRun(30, 'skipped', true); settledRun(31, 'pass', null); settledRun(32, 'fail', true, true);
    const e = failBeforePassAfterEvidence(db, {}, fisherExact, NOW);
    expect(e.counts).toMatchObject({ pass: 21, fail: 10, skipped: 1, fail_before_violated: 10 });
    expect(e.arms.pass).toMatchObject({ runs: 21, with_pr: 21, settled: 20, pending: 1 });
    expect(e.arms.fail).toMatchObject({ runs: 10, settled: 10 });
    expect(e).toMatchObject({ settled_runs: 30, primary: null, verdict: 'INSUFFICIENT' });
  });

  it('at n = 40: SUPPORTED when pass survives >= 10 pt more with Fisher p < 0.05; FALSIFIED otherwise', () => {
    for (let i = 0; i < 20; i++) settledRun(i, 'pass', i < 18); // 18/20 = 0.9
    for (let i = 20; i < 40; i++) settledRun(i, 'fail', i < 26); // 6/20 = 0.3
    settledRun(40, 'fail', true); // settled later: outside the frozen first-40 analysis set
    const e = failBeforePassAfterEvidence(db, {}, fisherExact, NOW);
    expect(e.primary).toMatchObject({ n: 40, pass: { survived: 18, regressed: 2, rate: 0.9 }, fail: { survived: 6, regressed: 14, rate: 0.3 }, difference_pt: 60 });
    expect(e.primary!.fisher_p!).toBeLessThan(0.05);
    expect(e.verdict).toBe('SUPPORTED');
  });

  it('at n = 40 with no survival difference → FALSIFIED', () => {
    for (let i = 0; i < 40; i++) settledRun(i, i % 2 ? 'pass' : 'fail', i % 4 < 2);
    const e = failBeforePassAfterEvidence(db, {}, fisherExact, NOW);
    expect(e.primary!.difference_pt).toBe(0);
    expect(e.verdict).toBe('FALSIFIED');
  });
});
