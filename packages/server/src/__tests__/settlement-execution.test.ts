import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EVOLUTION_FLAGS, buildEvolutionEvidence } from '../services/evolution-evidence';
import { targetMutants } from '../services/gym-failure-tasks';
import {
  MAX_ATTEMPTS, MAX_PER_TICK, SETTLEMENT_JUDGMENT, runVitestFiles, settlementCandidates, settlementExecutionEvidence, settlementExecutionTick,
  type SettlementExecutionDeps, type TestRun,
} from '../services/settlement-execution';

const DAY = 86_400_000;
const ENV = { SETTLEMENT_EXECUTION_MODE: 'shadow', LOOP_DAEMON_REPOSITORY_PATH: '/repo' } as NodeJS.ProcessEnv;
const TEST = 'packages/server/src/__tests__/foo.test.ts';
const TARGET = 'packages/server/src/services/foo.ts';
const SOURCE = [
  'export function foo(a: number, b: number): boolean { if (a > b && a >= 0) return true; return a === b || b < 0; }',
  'export const bar = (x: number): boolean => x + 1 > 2 && x <= 10;',
  'export const baz = (x: number): boolean => x !== 3 || x < -1;',
].join('\n');
let db: Database.Database;
let wt: string;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();

function seedPr(id: string, n: number, opts: { mergedDaysAgo?: number; changed?: string[]; graded?: Record<string, unknown>; survived?: boolean; status?: string } = {}) {
  const merged = iso(now - (opts.mergedDaysAgo ?? 20) * DAY);
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, grounding_json) VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, ?)")
    .run(`si-${id}`, `t-${id}`, opts.status ?? 'verified', JSON.stringify({ target: TARGET }));
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES (?, 'o', 'low', 'completed', ?)").run(`g-${id}`, `si-${id}`);
  const outcome: Record<string, unknown> = { state: 'merged', merged_at: merged, checked_at: iso(now) };
  if (opts.survived !== undefined) { outcome.survived = opts.survived; outcome.retained = opts.survived ? 1 : 0; outcome.settled_at = iso(now - DAY); }
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at) VALUES (?, ?, 'test-gap', 'closed', 'completed', '[]', ?, ?)")
    .run(id, `g-${id}`, JSON.stringify({ pr_url: `https://github.com/djimit/djimitflo/pull/${n}`, pr_outcome: outcome }), iso(now - 40 * DAY));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'opencode', 'completed', '/gone', ?, ?, ?)`)
    .run(`m-${id}`, id, JSON.stringify({ changed_files: opts.changed ?? [TEST], ...(opts.graded ? { graded: opts.graded } : {}) }), iso(now - 30 * DAY), iso(now - 30 * DAY));
}

function fakeDeps(state: { verdicts: Record<string, TestRun | 'throw'>; missing?: string[]; worktreeError?: string }) {
  const written: string[] = []; const ran: string[][] = []; let opened = 0; let disposed = 0;
  const deps: SettlementExecutionDeps = {
    mainSha: () => 'abcdef0123456789abcdef',
    exists: (_r, _s, f) => !(state.missing ?? []).includes(f),
    mergeSha: (_r, n) => (n === 101 ? 'merge101' : null),
    openWorktree: () => { opened++; return state.worktreeError ? { error: state.worktreeError } : { path: wt, dispose: () => { disposed++; } }; },
    runTests: async (_wt, files) => {
      ran.push(files);
      const v = state.verdicts[files.join(',')] ?? state.verdicts['*'] ?? { verdict: 'pass', reason: '1 test(s) passed' };
      if (v === 'throw') throw new Error('spawn ENOENT');
      return v;
    },
    // a test that is green on the real target and red on every mutant written over it
    kill: (cwd) => { const c = fs.readFileSync(path.join(cwd, 'src/services/foo.ts'), 'utf8'); if (c !== SOURCE) written.push(c); return c === SOURCE ? 'pass' : 'fail'; },
  };
  return { deps, written, ran, counts: () => ({ opened, disposed }) };
}
const rows = () => db.prepare('SELECT subject_id, mode, decision, reason, answers_json FROM judgments WHERE judgment = ? ORDER BY created_at, rowid').all(SETTLEMENT_JUDGMENT) as Array<{ subject_id: string; mode: string; decision: string; reason: string; answers_json: string }>;
const answers = (id: string) => JSON.parse(rows().filter((r) => r.subject_id === id).pop()!.answers_json);

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  wt = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-exec-'));
  fs.mkdirSync(path.join(wt, 'packages/server/src/services'), { recursive: true });
  fs.writeFileSync(path.join(wt, TARGET), SOURCE);
});
afterEach(() => { db.close(); fs.rmSync(wt, { recursive: true, force: true }); });

describe('execution-based settlement (SETTLEMENT_EXECUTION_MODE, shadow)', () => {
  it('off by default: nothing runs and nothing is recorded; the flag is in EVOLUTION_FLAGS (non-acting)', async () => {
    seedPr('r1', 101);
    const { deps, ran } = fakeDeps({ verdicts: {} });
    expect((await settlementExecutionTick(db, deps, now, {})).skipped).toBe('off');
    expect(ran).toEqual([]); expect(rows()).toEqual([]);
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'SETTLEMENT_EXECUTION_MODE', acting: false });
  });

  it('re-runs a settled PR\'s tests at main and re-scores the kill share on FRESH mutants; one shadow judgment per PR', async () => {
    seedPr('r1', 101, { graded: { score: 0.333, kind: 'mutant_kill', lane: 'test-gap', killed: 1, total: 3 }, survived: true });
    const { deps, written, ran, counts } = fakeDeps({ verdicts: {} });
    const r = await settlementExecutionTick(db, deps, now, ENV);
    expect(r).toMatchObject({ executed: 1, recorded: 1, by_verdict: { pass: 1 } });
    expect(ran).toEqual([[TEST]]);
    expect(counts()).toEqual({ opened: 1, disposed: 1 });
    const [row] = rows();
    expect(row).toMatchObject({ subject_id: 'r1', mode: 'shadow', decision: 'pass' });
    const a = answers('r1');
    expect(a).toMatchObject({ pr_url: 'https://github.com/djimit/djimitflo/pull/101', merge_sha: 'merge101', main_sha: 'abcdef0123456789abcdef', settlement_state: 'SETTLED_SURVIVED',
      test_files: [TEST], verdict: 'pass', kill_share_maker: 0.333, kill_share_now: 1, kill_share_drift: 0.667 });
    // fresh: a settlement seed, none of the maker-time (run id) mutants, the target restored afterwards
    expect(a.kill_now.mutants).toHaveLength(3);
    expect(a.kill_now.mutants.every((k: string) => k.startsWith('mut:Sabcdef'))).toBe(true);
    const makerTime = new Set(targetMutants(SOURCE, 'r1', TARGET).map((m) => m.content));
    expect(written).toHaveLength(3);
    expect(written.some((c) => makerTime.has(c))).toBe(false);
    expect(fs.readFileSync(path.join(wt, TARGET), 'utf8')).toBe(SOURCE);
    // decisive: never judged again
    expect(settlementCandidates(db, now, ENV)).toEqual([]);
    expect((await settlementExecutionTick(db, deps, now, ENV)).skipped).toBe('no candidates');
  });

  it('removed ≠ failing; a PR inside its 14 d window and a PR without test files are handled apart; infra is unknown and retried', async () => {
    seedPr('r-fail', 102, { mergedDaysAgo: 15 });
    seedPr('r-gone', 103, { changed: ['packages/server/src/__tests__/gone.test.ts'] });
    seedPr('r-young', 104, { mergedDaysAgo: 5 });
    seedPr('r-docs', 105, { changed: ['docs/a.md'] });
    seedPr('r-infra', 106, { changed: ['packages/server/src/__tests__/infra.test.ts'] });
    const { deps, ran } = fakeDeps({ missing: ['packages/server/src/__tests__/gone.test.ts'],
      verdicts: { [TEST]: { verdict: 'fail', reason: '1 of 4 test(s) failed' }, 'packages/server/src/__tests__/infra.test.ts': 'throw' } });
    await settlementExecutionTick(db, deps, now, ENV);
    const by = Object.fromEntries(rows().map((r) => [r.subject_id, r.decision]));
    expect(by).toEqual({ 'r-fail': 'fail', 'r-gone': 'removed', 'r-docs': 'no_test_files', 'r-infra': 'unknown' });
    expect(ran.flat()).not.toContain('packages/server/src/__tests__/gone.test.ts');
    expect(answers('r-fail')).toMatchObject({ kill_share_now: null, merge_sha: null, merge_sha_reason: 'no main commit names this PR', kill_share_maker: null });
    expect(answers('r-infra').reason).toMatch(/^infra: spawn ENOENT/);
    // unknown is retried until MAX_ATTEMPTS rows, then left alone
    for (let i = 1; i < MAX_ATTEMPTS + 2; i++) await settlementExecutionTick(db, deps, now, ENV);
    expect(rows().filter((r) => r.subject_id === 'r-infra')).toHaveLength(MAX_ATTEMPTS);
    expect(rows().filter((r) => r.subject_id === 'r-fail')).toHaveLength(1);
  });

  it(`executes at most ${MAX_PER_TICK} PRs per tick, in one worktree; a worktree failure is unknown, never a verdict`, async () => {
    for (let i = 0; i < 6; i++) seedPr(`r${i}`, 200 + i, { mergedDaysAgo: 20 + i });
    const { deps, ran, counts } = fakeDeps({ verdicts: {} });
    expect(await settlementExecutionTick(db, deps, now, ENV)).toMatchObject({ candidates: 6, executed: MAX_PER_TICK, recorded: MAX_PER_TICK });
    expect(ran).toHaveLength(MAX_PER_TICK); expect(counts()).toEqual({ opened: 1, disposed: 1 });
    // oldest merges first: r5..r2 done, r1 and r0 left
    expect(settlementCandidates(db, now, ENV).map((c) => c.run_id)).toEqual(['r1', 'r0']);
    const broken = fakeDeps({ verdicts: {}, worktreeError: 'dependency preparation failed (install 1, shared null)' });
    expect(await settlementExecutionTick(db, broken.deps, now, ENV)).toMatchObject({ executed: 1, recorded: 1, by_verdict: { unknown: 1 } });
    expect(broken.ran).toEqual([]);
  });

  it('evidence: counts per latest row, INSUFFICIENT below n 10, kill-share drift only from 10 pairs; graded vs labels report only', async () => {
    seedPr('r1', 101, { graded: { score: 0.333, kind: 'mutant_kill' }, survived: true });
    seedPr('r2', 102, { graded: { score: 0, kind: 'mutant_kill' }, survived: false, status: 'regressed' });
    seedPr('r3', 103, { changed: ['packages/server/src/__tests__/gone.test.ts'] });
    const { deps } = fakeDeps({ verdicts: {}, missing: ['packages/server/src/__tests__/gone.test.ts'] });
    await settlementExecutionTick(db, deps, now, ENV);
    const e = settlementExecutionEvidence(db, ENV, now);
    expect(e).toMatchObject({ mode: 'shadow', status: 'insufficient', min_n: 10, n: 3, counts: { pass: 2, fail: 0, removed: 1, unknown: 0, no_test_files: 0 }, pending: 0, pass_rate: null,
      kill_share: { n_now: 2, mean_now: null, n_paired: 2, mean_maker: null, mean_drift: null } });
    expect(e.graded_vs_labels.n).toBe(2);
    expect(e.graded_vs_labels.by_kind).toEqual([{ kind: 'mutant_kill', verified: { n: 1, mean: 0.333, zero_share: 0 }, not_verified: { n: 1, mean: 0, zero_share: 1 },
      survived: { n: 1, mean: 0.333, zero_share: 0 }, regressed: { n: 1, mean: 0, zero_share: 1 }, unsettled: { n: 0, mean: null, zero_share: null } }]);
    expect(buildEvolutionEvidence(db, ENV, now).settlement_execution).toMatchObject({ n: 3, status: 'insufficient' });

    // from n 10 the rates and drift are reported
    for (let i = 0; i < 8; i++) seedPr(`p${i}`, 300 + i, { graded: { score: 0.333, kind: 'mutant_kill' } });
    await settlementExecutionTick(db, deps, now, ENV); await settlementExecutionTick(db, deps, now, ENV);
    const ok = settlementExecutionEvidence(db, ENV, now);
    expect(ok).toMatchObject({ status: 'ok', n: 11, pass_rate: 1, kill_share: { n_now: 10, mean_now: 1, n_paired: 10, mean_maker: 0.3 } });
    expect(ok.kill_share.mean_drift).toBeCloseTo(0.7, 3);
  });

  it('runVitestFiles: per package, any failing test → fail, a suite that did not run → unknown, never a negative', async () => {
    const files = ['packages/server/src/__tests__/a.test.ts', 'packages/dashboard/src/pages/B.test.tsx'];
    const reports: Record<string, unknown> = { server: { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0 }, dashboard: { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1 } };
    const seen: Array<{ cwd: string; args: string[] }> = [];
    const fake = (async (_cmd: string, args: string[], cwd: string) => {
      seen.push({ cwd, args }); const pkg = path.basename(cwd);
      const out = args.find((a) => a.startsWith('--outputFile='))!.slice(13);
      if (reports[pkg]) fs.writeFileSync(out, JSON.stringify(reports[pkg]));
      return { code: (reports[pkg] as { numFailedTests: number } | undefined)?.numFailedTests ? 1 : 0, timedOut: false };
    });
    expect(await runVitestFiles(wt, files, fake)).toMatchObject({ verdict: 'fail' });
    expect(seen.map((s) => s.args.slice(0, 4))).toEqual([['--no-install', 'vitest', 'run', 'src/__tests__/a.test.ts'], ['--no-install', 'vitest', 'run', 'src/pages/B.test.tsx']]);
    delete reports.dashboard;
    expect((await runVitestFiles(wt, files, fake)).verdict).toBe('unknown');
    reports.dashboard = { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 };
    expect((await runVitestFiles(wt, files, fake)).verdict).toBe('pass');
    expect((await runVitestFiles(wt, files, async () => ({ code: null, timedOut: true }))).verdict).toBe('unknown');
  });
});
