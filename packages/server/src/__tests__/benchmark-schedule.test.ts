import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  BENCHMARKS, aucCi, benchmarkDef, benchmarkEvidence, benchmarkState, benchmarkTokenCap, detectBenchmarkStalls, latestSlot,
  nextSlotAfter, realLeasesRunning, recordBenchmarkRun, regressionCheck, regressionMargin, reviewerRun, type BenchmarkRun,
} from '../services/benchmark-schedule';
import { benchmarkTick, gymHoldoutReadout, passRate, startBenchmarkSchedule } from '../services/benchmark-runner';
import { detectStallsWithHealth } from '../services/stall-watch';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { resetSchedulers } from '../services/scheduler-registry';
import { benchmarkCli } from '../scripts/benchmark-cli';

// Periodic fixed benchmarks (operator 2026-11-07): SEC-F1 / F1 monthly via the operator runner, the gym holdout readout weekly
// in-process; regression and overdue alarms; everything behind BENCHMARK_SCHEDULE_MODE (default off = nothing runs).
const ON = { BENCHMARK_SCHEDULE_MODE: 'on' } as NodeJS.ProcessEnv;
const T = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const def = (id: string) => benchmarkDef(id)!;
let seq = 0;
const run = (over: Partial<BenchmarkRun> & { benchmark_id: string; started_at: string }): BenchmarkRun => ({
  id: `r${seq++}`, slot: null, manifest_sha256: 'm1', prompt_sha256: 'p1', models: ['ollama/glm-5.2:cloud'], runtime: 'opencode', finished_at: over.started_at, tokens: 1000,
  metric: 'auc', value: 0.95, ci_low: 0.9, ci_high: 1, n: 46, positives: 20, negatives: 26, catches: 19, false_rejects: 0, status: 'ok', reason: null, source: 'test', detail: {}, ...over });
const lease = (id: string, status: string, metadata: Record<string, unknown> = {}, loop = 'doc-drift-and-small-fix-loop') => {
  db.prepare(`INSERT OR IGNORE INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'closed', 'running', '[]', '{}', '[]', '[]', ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(`run-${id}`, loop, JSON.stringify(metadata));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at)
    VALUES (?, ?, 'maker', 'opencode', ?, '{}', '{}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run(id, `run-${id}`, status);
};

describe('schedule slots and due logic', () => {
  it('monthly slots are the 1st 02:00Z, weekly Monday 03:00Z', () => {
    expect(iso(latestSlot('monthly', T('2026-11-07T12:00:00Z')))).toBe('2026-11-01T02:00:00.000Z');
    expect(iso(latestSlot('monthly', T('2026-11-01T01:59:59Z')))).toBe('2026-10-01T02:00:00.000Z');
    expect(iso(latestSlot('monthly', T('2026-11-01T02:00:00Z')))).toBe('2026-11-01T02:00:00.000Z');
    expect(iso(latestSlot('monthly', T('2027-01-01T01:00:00Z')))).toBe('2026-12-01T02:00:00.000Z');
    expect(iso(nextSlotAfter('monthly', T('2026-12-15T00:00:00Z')))).toBe('2027-01-01T02:00:00.000Z');
    expect(iso(latestSlot('weekly', T('2026-11-07T12:00:00Z')))).toBe('2026-11-02T03:00:00.000Z'); // Saturday → Monday
    expect(iso(latestSlot('weekly', T('2026-11-09T02:59:00Z')))).toBe('2026-11-02T03:00:00.000Z'); // Monday before 03:00
    expect(iso(latestSlot('weekly', T('2026-11-09T03:00:00Z')))).toBe('2026-11-09T03:00:00.000Z');
    expect(iso(nextSlotAfter('weekly', T('2026-11-02T03:00:00Z')))).toBe('2026-11-09T03:00:00.000Z');
  });

  it('due until a closing run (ok or insufficient) since the slot; a failed run leaves it due', () => {
    const now = T('2026-11-03T00:00:00Z');
    expect(benchmarkState(db, def('sec-f1'), now)).toMatchObject({ due: true, slot: '2026-11-01T02:00:00.000Z', overdue: false });
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: '2026-11-02T10:00:00Z', status: 'failed', value: null, reason: 'aborted: lease' }));
    expect(benchmarkState(db, def('sec-f1'), now).due).toBe(true);
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: '2026-11-02T12:00:00Z', status: 'insufficient' }));
    expect(benchmarkState(db, def('sec-f1'), now)).toMatchObject({ due: false, overdue: false, late_days: null });
    expect(benchmarkState(db, def('f1'), now).due).toBe(true); // per benchmark
  });

  it('overdue more than 7 days after the slot owed by the last closing run', () => {
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: '2026-10-21T19:24:00Z' }));
    expect(benchmarkState(db, def('sec-f1'), T('2026-11-08T01:59:00Z'))).toMatchObject({ due: true, overdue: false, owed_at: '2026-11-01T02:00:00.000Z' });
    expect(benchmarkState(db, def('sec-f1'), T('2026-11-08T02:01:00Z'))).toMatchObject({ due: true, overdue: true });
    // weekly: the readout of two weeks ago owes the next Monday; 7 days past it is overdue although a newer slot exists
    recordBenchmarkRun(db, run({ benchmark_id: 'gym-holdout', metric: 'pass_rate', started_at: '2026-10-19T03:05:00Z' }));
    expect(benchmarkState(db, def('gym-holdout'), T('2026-11-02T02:00:00Z'))).toMatchObject({ due: true, overdue: false, owed_at: '2026-10-26T03:00:00.000Z' });
    expect(benchmarkState(db, def('gym-holdout'), T('2026-11-03T04:00:00Z')).overdue).toBe(true);
  });

  it('a real running lease blocks; synthetic PR-review leases, gym replays and finished leases do not', () => {
    lease('done', 'completed');
    lease('synthetic', 'running', { synthetic: true });
    lease('gym', 'running', {}, 'evolution-gym');
    expect(realLeasesRunning(db)).toEqual([]);
    lease('real', 'running');
    expect(realLeasesRunning(db).map((l) => l.id)).toEqual(['real']);
  });
});

describe('flag off: nothing runs', () => {
  it('no scheduler, no tick writes, no alarms, the stall detector is not applicable', () => {
    expect(startBenchmarkSchedule(db, 3_600_000, {})).toBeNull();
    expect(startBenchmarkSchedule(db, 3_600_000, { BENCHMARK_SCHEDULE_MODE: 'shadow' })).toBeNull(); // only 'on' arms it
    expect(benchmarkTick(db, {}, T('2026-11-20T00:00:00Z'))).toEqual({ recorded: [], due: [], waiting: [] });
    expect((db.prepare('SELECT COUNT(*) AS n FROM benchmark_runs').get() as { n: number }).n).toBe(0);
    expect(detectBenchmarkStalls(db, {}, T('2026-12-20T00:00:00Z'))).toEqual([]);
    const report = detectStallsWithHealth(db, T('2026-12-20T00:00:00Z'), {});
    expect(report.detectors.find((d) => d.name === 'benchmarks')?.status).toBe('not_applicable');
    expect(report.stalls.filter((s) => s.subsystem.startsWith('benchmark:'))).toEqual([]);
  });

  it('is registered as a measurement flag (not acting) and documented', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'BENCHMARK_SCHEDULE_MODE', acting: false });
    const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
    for (const n of ['BENCHMARK_SCHEDULE_MODE', 'BENCHMARK_TOKEN_CAP', 'BENCHMARK_REGRESSION_MARGIN', 'scripts/benchmark-run.sh']) expect(runbook).toContain(n);
  });

  it('flag on: the hourly scheduler registers and ticks', () => {
    resetSchedulers();
    const stop = startBenchmarkSchedule(db, 3_600_000, ON, () => T('2026-11-07T12:00:00Z'));
    try {
      expect(stop).toBeTypeOf('function');
      expect((db.prepare("SELECT COUNT(*) AS n FROM benchmark_runs WHERE benchmark_id = 'gym-holdout'").get() as { n: number }).n).toBe(1);
    } finally { stop?.(); resetSchedulers(); }
  });
});

describe('scheduler tick (flag on)', () => {
  it('records one gym readout per weekly slot and only reports due reviewer benchmarks (no row, no run)', () => {
    const now = T('2026-11-07T12:00:00Z');
    const first = benchmarkTick(db, ON, now);
    expect(first.recorded).toEqual(['gym-holdout:2026-11-02T03:00:00.000Z']);
    expect(first.due.sort()).toEqual(['f1', 'sec-f1']);
    expect(benchmarkTick(db, ON, now + 3_600_000).recorded).toEqual([]); // the slot is closed (insufficient closes it)
    expect((db.prepare('SELECT benchmark_id, status FROM benchmark_runs').all())).toEqual([{ benchmark_id: 'gym-holdout', status: 'insufficient' }]);
    lease('real', 'running');
    expect(benchmarkTick(db, ON, now + 7_200_000)).toMatchObject({ due: [], waiting: ['sec-f1', 'f1'] });
  });
});

describe('alarms', () => {
  it('due (idle host only) names the one-command runner and the token cap; overdue replaces it', () => {
    const env = { ...ON, BENCHMARK_TOKEN_CAP: '4000000' };
    recordBenchmarkRun(db, run({ benchmark_id: 'gym-holdout', metric: 'pass_rate', started_at: '2026-11-02T03:05:00Z' }));
    const due = detectBenchmarkStalls(db, env, T('2026-11-03T00:00:00Z'));
    expect(due.map((s) => s.subsystem).sort()).toEqual(['benchmark:due:f1', 'benchmark:due:sec-f1']);
    expect(due.find((s) => s.subsystem === 'benchmark:due:sec-f1')!.detail).toContain('bash scripts/benchmark-run.sh sec-f1 --apply');
    expect(due[0].detail).toContain('token cap 4000000');
    lease('real', 'running');
    expect(detectBenchmarkStalls(db, env, T('2026-11-03T00:00:00Z'))).toEqual([]); // waits while a real lease runs
    // never run: owed at the latest slot (11-01 02:00Z); more than 7 days later it is overdue even while a lease runs
    expect(detectBenchmarkStalls(db, env, T('2026-11-08T01:00:00Z'))).toEqual([]);
    const late = detectBenchmarkStalls(db, env, T('2026-11-08T03:00:00Z'));
    expect(late.map((s) => s.subsystem).sort()).toEqual(['benchmark:overdue:f1', 'benchmark:overdue:sec-f1']);
    expect(late[0].detail).toMatch(/is 7(\.\d)? d late \(last closing run never\)/);
  });

  it('the stall watch raises the benchmark stalls through its own detector', () => {
    const report = detectStallsWithHealth(db, T('2026-11-03T00:00:00Z'), ON);
    expect(report.detectors.find((d) => d.name === 'benchmarks')?.status).toBe('ok');
    expect(report.stalls.map((s) => s.subsystem)).toEqual(expect.arrayContaining(['benchmark:due:sec-f1', 'benchmark:due:f1']));
  });

  it('regression: the latest ok value below the previous one by more than max(previous CI, margin); names what changed', () => {
    const at = (d: string) => `2026-${d}T03:00:00Z`;
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: at('10-21'), value: 0.975, ci_low: 0.926 }));
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: at('11-01'), value: 0.94, prompt_sha256: 'p2' })); // drop 0.035 < 0.05
    const quiet = (now: string) => detectBenchmarkStalls(db, ON, T(now)).filter((s) => s.subsystem.startsWith('benchmark:regression'));
    expect(quiet('2026-11-02T00:00:00Z')).toEqual([]);
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: at('11-02'), value: 0.85, ci_low: 0.75, prompt_sha256: 'p3', models: ['ollama/kimi-k3:cloud'] })); // vs 0.94 (ci_low 0.9): drop 0.09 > 0.05
    const [r] = quiet('2026-11-03T00:00:00Z');
    expect(r.subsystem).toBe('benchmark:regression:sec-f1');
    expect(r.detail).toContain('0.94');
    expect(r.detail).toContain('0.85');
    expect(r.detail).toContain('prompt p2→p3');
    expect(r.detail).toContain('model ollama/glm-5.2:cloud→ollama/kimi-k3:cloud');
    // a failed or insufficient run is never compared; a recovered ok run clears it
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: at('11-03'), status: 'failed', value: null }));
    expect(quiet('2026-11-04T00:00:00Z')).toHaveLength(1);
    recordBenchmarkRun(db, run({ benchmark_id: 'sec-f1', started_at: at('11-04'), value: 0.97 }));
    expect(quiet('2026-11-05T00:00:00Z')).toEqual([]);
  });

  it('regressionCheck: CI basis when the previous CI is wider than the margin; a changed item set is never compared', () => {
    const prev = run({ benchmark_id: 'gym-holdout', started_at: '2026-11-02T03:00:00Z', value: 0.6, ci_low: 0.45 });
    expect(regressionCheck(prev, run({ benchmark_id: 'gym-holdout', started_at: '2026-11-09T03:00:00Z', value: 0.5 }))).toEqual({ regressed: false, drop: 0.1, threshold: 0.15, basis: 'ci' });
    expect(regressionCheck(prev, run({ benchmark_id: 'gym-holdout', started_at: '2026-11-09T03:00:00Z', value: 0.4 })).regressed).toBe(true);
    expect(regressionCheck({ ...prev, ci_low: null }, run({ benchmark_id: 'gym-holdout', started_at: '2026-11-09T03:00:00Z', value: 0.54 }))).toMatchObject({ regressed: true, basis: 'margin', threshold: 0.05 });
    expect(regressionCheck(prev, run({ benchmark_id: 'gym-holdout', started_at: '2026-11-09T03:00:00Z', value: 0.1, manifest_sha256: 'other' })).regressed).toBe(false);
    expect(regressionCheck(null, prev).drop).toBeNull();
    expect(regressionMargin({ BENCHMARK_REGRESSION_MARGIN: '0.1' })).toBe(0.1);
    expect(regressionMargin({ BENCHMARK_REGRESSION_MARGIN: '2' })).toBe(0.05);
  });
});

describe('readout and run math', () => {
  const holdoutTask = (key: string) => db.prepare('INSERT INTO gym_holdout (commit_sha, created_at, epoch) VALUES (?, ?, 0)').run(key, '2026-10-14T10:00:00Z');
  const gymRun = (commit: string, status: 'success' | 'failure', at: string, extra: Record<string, unknown> = {}) => db.prepare(`INSERT INTO loop_runs
    (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES (?, 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`).run(`g${seq++}`, JSON.stringify({
    gym: { commit, species: 'atomic@llama-router', genome: 'baseline', prod_gates: 1, ...extra },
    gym_result: { status, reason: status === 'success' ? 'tests green' : 'tests still red', ...(status === 'success' ? { prod_gates: { lint: 'pass' } } : {}) } }), at, at);

  it('gym readout: newest eligible gated result per frozen task, pass rate with a Wilson CI, no new attempts', () => {
    for (let i = 0; i < 12; i++) holdoutTask(`c${i}`);
    holdoutTask('c-unseen'); // no eligible result: unknown, not a failure
    for (let i = 0; i < 12; i++) gymRun(`c${i}`, i < 9 ? 'success' : 'failure', '2026-11-01T00:00:00Z');
    gymRun('c0', 'failure', '2026-11-02T00:00:00Z'); // the newest eligible attempt per task counts: c0 now fails
    gymRun('c1', 'success', '2026-10-01T00:00:00Z'); // before the freeze: ineligible
    const before = (db.prepare('SELECT COUNT(*) AS n FROM loop_runs').get() as { n: number }).n;
    const r = gymHoldoutReadout(db, {}, T('2026-11-07T12:00:00Z'));
    expect((db.prepare('SELECT COUNT(*) AS n FROM loop_runs').get() as { n: number }).n).toBe(before);
    expect(r).toMatchObject({ benchmark_id: 'gym-holdout', metric: 'pass_rate', value: 0.6667, n: 12, status: 'ok', tokens: 0, slot: '2026-11-02T03:00:00.000Z', models: ['atomic@llama-router'] });
    expect([r.ci_low, r.ci_high]).toEqual(passRate(8, 12).ci);
    expect(r.detail.sets).toMatchObject({ mined: { tasks: 13, eligible: 12, passed: 8 }, mutant: { tasks: 0, eligible: 0, rate: null } });
    expect(r.detail.newest_result).toBe('2026-11-02T00:00:00Z');
  });

  it('gym readout: fewer than 10 eligible is insufficient; none is a null value, never 0', () => {
    for (let i = 0; i < 4; i++) { holdoutTask(`c${i}`); gymRun(`c${i}`, 'success', '2026-11-01T00:00:00Z'); }
    expect(gymHoldoutReadout(db, {}, T('2026-11-07T00:00:00Z'))).toMatchObject({ status: 'insufficient', value: 1, n: 4 });
    db.exec('DELETE FROM loop_runs');
    expect(gymHoldoutReadout(db, {}, T('2026-11-07T00:00:00Z'))).toMatchObject({ status: 'insufficient', value: null, ci_low: null, n: 0 });
    expect(passRate(0, 0)).toEqual({ rate: null, ci: null });
  });

  it('AUC CI (Hanley-McNeil) on the SEC-F1 21-10 numbers; null for an empty side', () => {
    expect(aucCi(0.975, 20, 26)).toEqual([0.9251, 1]);
    expect(aucCi(0.875, 20, 20)).toEqual([0.7628, 0.9872]);
    expect(aucCi(null, 20, 26)).toBeNull();
    expect(aucCi(0.9, 0, 26)).toBeNull();
  });

  it('a reviewer run maps from the committed SEC-F1 21-10 output (score + results): ok, AUC 0.975, 19 caught, 0 false rejects, 2.0 M tokens', () => {
    const dir = path.resolve(__dirname, '../../../../docs/research/eco/sec-f1/result');
    const results = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const score = JSON.parse(fs.readFileSync(path.join(dir, 'score.json'), 'utf8'));
    const r = reviewerRun(def('sec-f1'), { score, results, manifestSha256: '29e591e4a75371aa4b81081c0889e57b373e6be2cc72b0db6755c6ef2a897a6f' });
    expect(r).toMatchObject({ benchmark_id: 'sec-f1', status: 'ok', value: 0.975, ci_low: 0.9251, ci_high: 1, n: 46, positives: 20, negatives: 26, catches: 19, false_rejects: 0,
      models: ['ollama/glm-5.2:cloud'], prompt_sha256: 'dd10149499c04656458c50fda4324d0181b5bcfe10da5a816273f50489aab4ac', runtime: 'opencode', slot: '2026-10-01T02:00:00.000Z' });
    expect(r.tokens).toBeGreaterThan(1_990_000);
    expect(r.tokens).toBeLessThan(2_010_000);
    expect(r.started_at.startsWith('2026-10-21')).toBe(true);
    expect(reviewerRun(def('sec-f1'), { score, results, manifestSha256: '29e591e4a75371aa4b81081c0889e57b373e6be2cc72b0db6755c6ef2a897a6f' }).id).toBe(r.id); // idempotent id
  });

  it('a reviewer run: aborted → failed with the reason; unscored at the token cap → insufficient; nothing scored → failed', () => {
    const score = { all: { items: { scored_positives: 10, scored_negatives: 12, unscored: 24 }, auc: 0.9, llm: { caught: { k: 9 }, false_reject: { k: 1 } } } };
    const results = Array.from({ length: 22 }, (_, i) => ({ id: `i${i}`, verdict: 'accepted', tokens_total: 300_000, started_at: '2026-11-01T03:00:00Z', finished_at: '2026-11-01T04:00:00Z' }));
    expect(reviewerRun(def('f1'), { score, results, abort: { reason: 'real lease abc started (maker opencode)', at: '2026-11-01T04:01:00Z' } }))
      .toMatchObject({ status: 'failed', reason: 'aborted: real lease abc started (maker opencode)', finished_at: '2026-11-01T04:01:00Z' });
    expect(reviewerRun(def('f1'), { score, results, meta: { cap: 6_000_000 } })).toMatchObject({ status: 'insufficient', reason: '24 item(s) unscored (token cap 6000000 reached)', tokens: 6_600_000 });
    expect(reviewerRun(def('f1'), { score, results: results.slice(0, 2), meta: { cap: 6_000_000 } }).reason).toBe('24 item(s) unscored (no verdict)');
    expect(reviewerRun(def('f1'), { score: null, results: [] })).toMatchObject({ status: 'failed', value: null, n: 0 });
  });

  it('the token cap is 6 M by default and configurable', () => {
    expect(benchmarkTokenCap({})).toBe(6_000_000);
    expect(benchmarkTokenCap({ BENCHMARK_TOKEN_CAP: '3000000' })).toBe(3_000_000);
    expect(benchmarkTokenCap({ BENCHMARK_TOKEN_CAP: '-1' })).toBe(6_000_000);
    expect(BENCHMARKS.map((b) => [b.id, b.cadence, b.execution])).toEqual([['sec-f1', 'monthly', 'operator_runner'], ['f1', 'monthly', 'operator_runner'], ['gym-holdout', 'weekly', 'in_process']]);
  });

  it('the evidence section carries the series per benchmark, oldest first, and the regression verdict', () => {
    recordBenchmarkRun(db, run({ benchmark_id: 'f1', started_at: '2026-11-01T03:00:00Z', value: 0.95, ci_low: 0.88 }));
    recordBenchmarkRun(db, run({ benchmark_id: 'f1', started_at: '2026-12-01T03:00:00Z', value: 0.8 }));
    const e = benchmarkEvidence(db, ON, T('2026-12-02T00:00:00Z'));
    const f1 = e.benchmarks.find((b) => b.id === 'f1')!;
    expect(e.mode).toBe('on');
    expect(f1.series.map((s) => s.value)).toEqual([0.95, 0.8]);
    expect(f1.regression).toMatchObject({ regressed: true, drop: 0.15 });
    expect(f1.due).toBe(false);
  });
});

describe('operator CLI (benchmark-cli.js): the runner\'s only door into the prod DB', () => {
  let dir: string; let file: string; let out: string[];
  const io = () => ({ open: (p: string, readonly: boolean) => new Database(p, readonly ? { readonly: true, fileMustExist: true } : { fileMustExist: true }), print: (s: string) => { out.push(s); }, env: {}, now: () => T('2026-11-03T00:00:00Z') });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cli-')); file = path.join(dir, 'db.sqlite'); out = [];
    const d = new Database(file); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); d.close();
    fs.writeFileSync(path.join(dir, 'results.jsonl'), `${JSON.stringify({ id: 'a', verdict: 'rejected', tokens_total: 10, effective_model: 'ollama/glm-5.2:cloud', checker_instructions_sha256: 'h', started_at: '2026-11-02T03:00:00Z', finished_at: '2026-11-02T03:01:00Z' })}\n`);
    fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify({ all: { items: { scored_positives: 1, scored_negatives: 1, unscored: 0 }, auc: 1, llm: { caught: { k: 1 }, false_reject: { k: 0 } } } }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const count = () => { const d = new Database(file, { readonly: true }); try { return (d.prepare('SELECT COUNT(*) AS n FROM benchmark_runs').get() as { n: number }).n; } finally { d.close(); } };
  const ingest = (...extra: string[]) => benchmarkCli(['ingest', '--db', file, '--benchmark', 'f1', '--results', path.join(dir, 'results.jsonl'), '--score', path.join(dir, 'score.json'), '--manifest-sha', 'm', ...extra], io());

  it('idle / plan are read-only: exit 0 idle, 5 while a real lease runs', () => {
    expect(benchmarkCli(['idle', '--db', file], io())).toBe(0);
    expect(benchmarkCli(['plan', 'sec-f1', '--db', file], io())).toBe(0);
    expect(JSON.parse(out[1])).toMatchObject({ id: 'sec-f1', role: 'security_checker', due: true, token_cap: 6_000_000, idle: true });
    const d = new Database(file);
    d.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('run-x', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', 'now', 'now')`).run();
    d.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, budget_json, metadata, created_at, updated_at) VALUES ('x', 'run-x', 'maker', 'opencode', 'running', '{}', '{}', 'now', 'now')`).run();
    d.close();
    expect(benchmarkCli(['idle', '--db', file], io())).toBe(5);
    expect(JSON.parse(out[2]).running[0].id).toBe('x');
    expect(count()).toBe(0);
  });

  it('ingest is a dry run by default; --apply writes exactly one row, idempotently', () => {
    expect(ingest()).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ dry_run: true, would_write: { benchmark_id: 'f1', status: 'ok', value: 1, manifest_sha256: 'm' } });
    expect(count()).toBe(0);
    expect(ingest('--apply')).toBe(0);
    expect(ingest('--apply')).toBe(0);
    expect(JSON.parse(out[2]).written).toBe(false);
    expect(count()).toBe(1);
  });

  it('refuses unknown options, an unknown benchmark, the in-process benchmark and a DB without the table', () => {
    expect(benchmarkCli(['ingest', '--db', file, '--nope', 'x'], io())).toBe(64);
    expect(benchmarkCli(['ingest', '--db', file, '--benchmark', 'gym-holdout', '--results', 'x'], io())).toBe(64);
    expect(benchmarkCli(['plan', 'nope', '--db', file], io())).toBe(64);
    expect(benchmarkCli(['frobnicate'], io())).toBe(64);
    const bare = path.join(dir, 'bare.sqlite'); new Database(bare).close();
    expect(benchmarkCli(['ingest', '--db', bare, '--benchmark', 'f1', '--results', path.join(dir, 'results.jsonl'), '--apply'], io())).toBe(2);
  });
});
