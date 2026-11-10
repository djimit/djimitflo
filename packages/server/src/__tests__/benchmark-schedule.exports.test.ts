import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { benchmarkRuns, lastTwoOk, runnerCommand, type BenchmarkRun } from '../services/benchmark-schedule';

const now = '2026-11-10T10:00:00Z';

const baseRun = (id: string, overrides: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
  id,
  benchmark_id: 'sec-f1',
  slot: now,
  manifest_sha256: 'sha-1',
  prompt_sha256: 'p-1',
  models: ['opencode-default'],
  runtime: 'opencode',
  started_at: now,
  finished_at: now,
  tokens: 1000,
  metric: 'auc',
  value: 0.9,
  ci_low: 0.85,
  ci_high: 0.95,
  n: 40,
  positives: 20,
  negatives: 20,
  catches: 18,
  false_rejects: 2,
  status: 'ok',
  reason: null,
  source: 'operator_runner',
  detail: {},
  ...overrides,
});

const insertRun = (db: Database.Database, run: BenchmarkRun) => {
  db.prepare(`INSERT INTO benchmark_runs (id, benchmark_id, slot, manifest_sha256, prompt_sha256, models_json, runtime, started_at, finished_at, tokens,
    metric, value, ci_low, ci_high, n, positives, negatives, catches, false_rejects, status, reason, source, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    run.id, run.benchmark_id, run.slot, run.manifest_sha256, run.prompt_sha256, JSON.stringify(run.models), run.runtime,
    run.started_at, run.finished_at, run.tokens, run.metric, run.value, run.ci_low, run.ci_high, run.n, run.positives,
    run.negatives, run.catches, run.false_rejects, run.status, run.reason, run.source, JSON.stringify(run.detail), now);
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('runnerCommand', () => {
  it('emits the one-command operator runner for a benchmark id', () => {
    expect(runnerCommand('sec-f1')).toBe('bash scripts/benchmark-run.sh sec-f1 --apply');
    expect(runnerCommand('f1')).toBe('bash scripts/benchmark-run.sh f1 --apply');
    expect(runnerCommand('gym-holdout')).toBe('bash scripts/benchmark-run.sh gym-holdout --apply');
  });
});

describe('benchmarkRuns', () => {
  it('returns an empty array when no runs exist', () => {
    expect(benchmarkRuns(db, 'sec-f1')).toEqual([]);
  });

  it('returns runs for the benchmark newest first, parsing models and detail json', () => {
    insertRun(db, baseRun('r-old', { started_at: '2026-11-01T02:00:00Z', value: 0.8 }));
    insertRun(db, baseRun('r-new', { started_at: '2026-11-08T02:00:00Z', value: 0.92, models: ['m-a'], detail: { role: 'security_checker' } }));
    const runs = benchmarkRuns(db, 'sec-f1');
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('r-new');
    expect(runs[1].id).toBe('r-old');
    expect(runs[0].value).toBe(0.92);
    expect(runs[0].models).toEqual(['m-a']);
    expect(runs[0].detail).toEqual({ role: 'security_checker' });
  });

  it('is scoped to the requested benchmark id and honours the limit', () => {
    insertRun(db, baseRun('r-sec-1', { benchmark_id: 'sec-f1' }));
    insertRun(db, baseRun('r-f1-1', { benchmark_id: 'f1' }));
    insertRun(db, baseRun('r-sec-2', { benchmark_id: 'sec-f1', started_at: '2026-11-09T02:00:00Z' }));
    expect(benchmarkRuns(db, 'f1').map((r) => r.id)).toEqual(['r-f1-1']);
    expect(benchmarkRuns(db, 'sec-f1').map((r) => r.id)).toEqual(['r-sec-1', 'r-sec-2']);
    expect(benchmarkRuns(db, 'sec-f1', 1)).toHaveLength(1);
  });

  it('falls back to defaults when models_json or detail_json is unparseable', () => {
    db.prepare(`INSERT INTO benchmark_runs (id, benchmark_id, slot, manifest_sha256, prompt_sha256, models_json, runtime, started_at, finished_at, tokens,
      metric, value, ci_low, ci_high, n, positives, negatives, catches, false_rejects, status, reason, source, detail_json, created_at)
      VALUES (?, 'sec-f1', NULL, NULL, NULL, 'not-json', NULL, ?, NULL, NULL, 'auc', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'failed', 'x', 'operator_runner', 'also-bad', ?)`).run(
      'r-bad', now, now);
    const [r] = benchmarkRuns(db, 'sec-f1');
    expect(r.models).toEqual([]);
    expect(r.detail).toEqual({});
  });
});

describe('lastTwoOk', () => {
  it('returns an empty array when no ok runs exist', () => {
    insertRun(db, baseRun('r-fail', { status: 'failed' }));
    insertRun(db, baseRun('r-insuf', { status: 'insufficient' }));
    expect(lastTwoOk(db, 'sec-f1')).toEqual([]);
  });

  it('returns only ok runs, newest first, capped at two', () => {
    insertRun(db, baseRun('r-ok-1', { started_at: '2026-11-01T02:00:00Z', value: 0.8 }));
    insertRun(db, baseRun('r-fail', { started_at: '2026-11-03T02:00:00Z', status: 'failed' }));
    insertRun(db, baseRun('r-ok-2', { started_at: '2026-11-08T02:00:00Z', value: 0.9 }));
    insertRun(db, baseRun('r-ok-3', { started_at: '2026-11-09T02:00:00Z', value: 0.88 }));
    const ok = lastTwoOk(db, 'sec-f1');
    expect(ok.map((r) => r.id)).toEqual(['r-ok-3', 'r-ok-2']);
  });

  it('is scoped to the requested benchmark id', () => {
    insertRun(db, baseRun('r-sec', { benchmark_id: 'sec-f1', status: 'ok' }));
    insertRun(db, baseRun('r-f1', { benchmark_id: 'f1', status: 'ok' }));
    expect(lastTwoOk(db, 'sec-f1').map((r) => r.id)).toEqual(['r-sec']);
    expect(lastTwoOk(db, 'f1').map((r) => r.id)).toEqual(['r-f1']);
  });
});
