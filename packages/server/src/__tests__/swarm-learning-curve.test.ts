import { expect, it, beforeEach, afterEach, describe } from 'vitest';
import Database from 'better-sqlite3';
import {
  LEARNING_CURVE_MIN_N,
  TERMINAL_RUN_STATUSES,
  runClass,
  summarizeUsage,
  learningCurveView,
  registeredReadouts,
  type RunClass,
} from '../services/swarm-learning-curve';
import type { UsageEvent } from '../services/cost-ledger';

const NOW = Date.parse('2026-10-25T00:00:00Z');
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const ev = (over: Partial<UsageEvent> & { id: string }): UsageEvent => ({
  source: 'worker_leases', row_id: over.id, field: 'runtime_usage', at: iso(DAY),
  consumer: 'maker', role: 'maker', owner: { kind: 'lease', id: over.id }, shared: null,
  locality: 'cloud', model: 'glm-5.2', tokens_provider_reported: null, tokens_estimated: null,
  tokens_reconciled: null, reconciled_basis: 'UNKNOWN', usd_inferred: null,
  run_id: null, proposal_id: null, run_verified: null, proposal_verified: null,
  pr_merged: null, pr_survived: null, valid_verdict: null,
  ...over,
});

it('LEARNING_CURVE_MIN_N is 10 and TERMINAL_RUN_STATUSES lists the six final outcomes', () => {
  expect(LEARNING_CURVE_MIN_N).toBe(10);
  expect([...TERMINAL_RUN_STATUSES]).toEqual(['completed', 'failed', 'escalated', 'cancelled', 'interrupted', 'blocked']);
});

describe('runClass', () => {
  it('classifies evolution-gym and a metadata.gym object as gym', () => {
    expect(runClass('evolution-gym')).toBe<RunClass>('gym');
    expect(runClass('anything', { gym: { kind: 'x' } })).toBe<RunClass>('gym');
  });
  it('classifies repo-maintenance-loop as maintenance', () => {
    expect(runClass('repo-maintenance-loop')).toBe<RunClass>('maintenance');
  });
  it('defaults to production for every other loop name', () => {
    expect(runClass('oracle-goal-loop')).toBe<RunClass>('production');
    expect(runClass('')).toBe<RunClass>('production');
  });
});

describe('summarizeUsage', () => {
  it('reports UNKNOWN tokens and no-usage usd reason for an empty set', () => {
    const s = summarizeUsage([]);
    expect(s.tokens).toMatchObject({ value: null, events: 0, known: 0, coverage: null, status: 'UNKNOWN' });
    expect(s.usd).toEqual({ value: null, reason: 'no usage record' });
  });
  it('sums tokens and usd when every event is reconciled and priced (measured)', () => {
    const s = summarizeUsage([ev({ id: 'a', tokens_reconciled: 1000, usd_inferred: 0.5 }), ev({ id: 'b', tokens_reconciled: 500, usd_inferred: 0.25 })]);
    expect(s.tokens).toMatchObject({ value: 1500, events: 2, known: 2, coverage: 1, status: 'measured' });
    expect(s.usd).toEqual({ value: 0.75, reason: null });
  });
  it('reports partial coverage and a null usd when some events lack reported tokens', () => {
    const s = summarizeUsage([ev({ id: 'a', tokens_reconciled: 1000, usd_inferred: 0.5 }), ev({ id: 'b', tokens_reconciled: null, usd_inferred: null })]);
    expect(s.tokens).toMatchObject({ value: 1000, events: 2, known: 1, coverage: 0.5, status: 'partial' });
    expect(s.usd.value).toBeNull();
    expect(s.usd.reason).toBe('usage not reported for every record');
  });
  it('reports null usd with the dated-price reason when tokens are known but usd is missing', () => {
    const s = summarizeUsage([ev({ id: 'a', tokens_reconciled: 1000, usd_inferred: null })]);
    expect(s.tokens.status).toBe('measured');
    expect(s.usd.value).toBeNull();
    expect(s.usd.reason).toMatch(/dated price entry/);
  });
  it('deduplicates events by id, keeping the last occurrence', () => {
    const s = summarizeUsage([ev({ id: 'a', tokens_reconciled: 1000, usd_inferred: 0.5 }), ev({ id: 'a', tokens_reconciled: 300, usd_inferred: 0.1 })]);
    expect(s.tokens).toMatchObject({ value: 300, events: 1, known: 1, status: 'measured' });
    expect(s.usd).toEqual({ value: 0.1, reason: null });
  });
});

describe('learningCurveView', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec('CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT, created_at TEXT, metadata TEXT); CREATE TABLE worker_leases (loop_run_id TEXT, role TEXT, runtime TEXT)'); });
  afterEach(() => db.close());

  const insertRun = (id: string, loopName: string, status: string, msAgo: number, metadata: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO loop_runs (id, loop_name, status, created_at, metadata) VALUES (?, ?, ?, ?, ?)').run(id, loopName, status, iso(msAgo), JSON.stringify(metadata));

  it('returns an empty, null-safe view when there are no runs (no rates, pooled false)', () => {
    const v = learningCurveView(db, NOW);
    expect(v.runs).toEqual([]);
    expect(v.cohorts).toEqual([]);
    expect(v.pooled).toBe(false);
    expect(v.min_n_per_window).toBe(LEARNING_CURVE_MIN_N);
    expect(v.first_vs_last).toMatchObject({ first_success_rate: null, last_success_rate: null, first_run_success: null, last_run_success: null });
  });

  it('maps each run to a binary success, terminal flag and run_class; cost is UNKNOWN without a dated price', () => {
    insertRun('r1', 'test-gap', 'completed', 3 * DAY, { retry_count: 1 });
    insertRun('r2', 'evolution-gym', 'failed', 2 * DAY);
    insertRun('r3', 'repo-maintenance-loop', 'running', DAY);
    const v = learningCurveView(db, NOW, 30, 100);
    const byId = new Map(v.runs.map((r) => [r.run_id, r]));
    expect(byId.get('r1')).toMatchObject({ success: true, terminal: true, retries: 1, run_class: 'production', cost_status: 'UNKNOWN', dollars: null });
    expect(byId.get('r2')).toMatchObject({ success: false, terminal: true, run_class: 'gym' });
    expect(byId.get('r3')).toMatchObject({ success: false, terminal: false, run_class: 'maintenance' });
    expect(v.first_vs_last.first_run_success).toBe(true);
    expect(v.first_vs_last.last_run_success).toBe(false);
  });

  it('marks a cohort comparison insufficient when either window has fewer than LEARNING_CURVE_MIN_N terminal runs', () => {
    for (let i = 0; i < 3; i++) insertRun(`p${i}`, 'test-gap', 'completed', 10 * DAY - i * 1000);
    for (let i = 0; i < 2; i++) insertRun(`q${i}`, 'test-gap', 'failed', 2 * DAY - i * 1000);
    const v = learningCurveView(db, NOW, 7, 100);
    expect(v.cohorts).toHaveLength(1);
    expect(v.cohorts[0].comparison).toMatchObject({ status: 'insufficient', delta: null });
    expect(v.cohorts[0].comparison.reason).toContain(String(LEARNING_CURVE_MIN_N));
  });

  it('compares cohorts and reports a delta when both windows reach LEARNING_CURVE_MIN_N terminal runs', () => {
    for (let i = 0; i < 10; i++) insertRun(`a${i}`, 'test-gap', 'completed', 10 * DAY + i * 1000);
    for (let i = 0; i < 10; i++) insertRun(`b${i}`, 'test-gap', i % 2 === 0 ? 'completed' : 'failed', 2 * DAY + i * 1000);
    const v = learningCurveView(db, NOW, 7, 100);
    const c = v.cohorts[0];
    expect(c.windows.prior.n).toBe(10);
    expect(c.windows.recent.n).toBe(10);
    expect(c.comparison).toMatchObject({ status: 'compared', reason: null });
    expect(c.comparison.delta).toBe(+(0.5 - 1).toFixed(3));
    expect(c.windows.prior.ci).not.toBeNull();
  });
});

describe('registeredReadouts', () => {
  it('returns only the memory-holdout readout definition with no causal conclusion', () => {
    const r = registeredReadouts();
    expect(r.map((x) => x.id)).toEqual(['memory-holdout']);
    const m = r[0];
    expect(m.protocol).toMatch(/EXPERIMENT_PROTOCOL/);
    expect(m.stop_by).not.toBeNull();
    expect(m.stop_source).toMatch(/EXPERIMENT_PROTOCOL/);
    expect(m.causal_conclusion).toBeNull();
    expect(m.analysis).toBe('registered single analysis');
    expect(m.note).toContain('readout due');
  });
});