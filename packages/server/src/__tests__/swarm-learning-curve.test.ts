import { expect, it, beforeEach, afterEach, describe } from 'vitest';
import Database from 'better-sqlite3';
import {
  LEARNING_CURVE_MIN_N,
  TERMINAL_RUN_STATUSES,
  runClass,
  summarizeUsage,
  learningCurveView,
  usageWindow,
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
  it('treats a non-object metadata.gym (null, string, number) as not gym', () => {
    expect(runClass('anything', { gym: null })).toBe<RunClass>('production');
    expect(runClass('anything', { gym: 'str' })).toBe<RunClass>('production');
    expect(runClass('anything', { gym: 5 })).toBe<RunClass>('production');
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
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT, created_at TEXT, metadata TEXT);
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT, status TEXT, created_at TEXT, metadata TEXT);
      CREATE TABLE self_improvements (id TEXT PRIMARY KEY, status TEXT, panel_id TEXT);
      CREATE TABLE goals (id TEXT PRIMARY KEY, improvement_id TEXT);
      CREATE TABLE skill_outcomes (task_id TEXT, skill_id TEXT, success INTEGER);
      CREATE TABLE judgments (id TEXT, judgment TEXT, subject_type TEXT, subject_id TEXT, state_hash TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT);
      CREATE TABLE llm_model_calls (id INTEGER PRIMARY KEY, consumer TEXT, model TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER, run_id TEXT, purpose TEXT, attempts INTEGER, created_at TEXT);`);
  });
  afterEach(() => db.close());

  const insertRun = (id: string, loopName: string, status: string, msAgo: number, metadata: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO loop_runs (id, loop_name, status, created_at, metadata) VALUES (?, ?, ?, ?, ?)').run(id, loopName, status, iso(msAgo), JSON.stringify(metadata));

  const insertLease = (id: string, runId: string, role: string, runtime: string, status: string, msAgo: number, usage: { total: number | null; pin?: number | null; pout?: number | null } = { total: null }) =>
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, runId, role, runtime, status, iso(msAgo), JSON.stringify({ model: 'glm-5.2', runtime_usage: usage.total === null ? null : { total_tokens: usage.total, prompt_tokens: usage.pin ?? null, completion_tokens: usage.pout ?? null } }));

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
    expect(v.first_vs_last.first_run_status).toBe('completed');
    expect(v.first_vs_last.last_run_status).toBe('running');
  });

  it('attributes cost-ledger usage events to a run (tokens reported, usd UNKNOWN without a dated price)', () => {
    insertRun('u1', 'test-gap', 'completed', 3 * DAY);
    insertLease('wl1', 'u1', 'maker', 'opencode', 'completed', 2 * DAY, { total: 1000, pin: 600, pout: 400 });
    const v = learningCurveView(db, NOW, 7, 100);
    const run = v.runs.find((r) => r.run_id === 'u1')!;
    expect(run.tokens).toBe(1000);
    expect(run.usage_events).toBe(1);
    expect(run.usage_events_known).toBe(1);
    expect(run.cost_status).toBe('UNKNOWN');
    expect(run.dollars).toBeNull();
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
    expect(c.loop_name).toBe('test-gap');
    expect(c.run_class).toBe('production');
    expect(c.windows.prior.tokens).toMatchObject({ value: null, events: 0, known: 0, coverage: null, status: 'UNKNOWN' });
    expect(c.windows.prior.usd).toEqual({ value: null, reason: 'no usage record' });
  });

  it('marks a cohort insufficient when prior reaches MIN_N but recent does not (and vice versa)', () => {
    for (let i = 0; i < 10; i++) insertRun(`hp${i}`, 'half', 'completed', 12 * DAY + i * 1000);
    for (let i = 0; i < 5; i++) insertRun(`hr${i}`, 'half', 'completed', 3 * DAY + i * 1000);
    const v = learningCurveView(db, NOW, 7, 100);
    const half = v.cohorts.find((c) => c.loop_name === 'half')!;
    expect(half.windows.prior.n).toBe(10);
    expect(half.windows.recent.n).toBe(5);
    expect(half.comparison.status).toBe('insufficient');
    expect(half.comparison.delta).toBeNull();
  });

  it('marks a cohort insufficient when recent reaches MIN_N but prior does not', () => {
    for (let i = 0; i < 5; i++) insertRun(`lp${i}`, 'low', 'completed', 12 * DAY + i * 1000);
    for (let i = 0; i < 10; i++) insertRun(`lr${i}`, 'low', 'completed', 3 * DAY + i * 1000);
    const v = learningCurveView(db, NOW, 7, 100);
    const low = v.cohorts.find((c) => c.loop_name === 'low')!;
    expect(low.windows.prior.n).toBe(5);
    expect(low.windows.recent.n).toBe(10);
    expect(low.comparison.status).toBe('insufficient');
    expect(low.comparison.delta).toBeNull();
  });

  it('counts censored (non-terminal) runs separately and excludes them from n', () => {
    for (let i = 0; i < 2; i++) insertRun(`cp${i}`, 'cens', 'completed', 12 * DAY + i * 1000);
    insertRun('cp-run', 'cens', 'running', 12 * DAY + 5000);
    const v = learningCurveView(db, NOW, 7, 100);
    const c = v.cohorts.find((x) => x.loop_name === 'cens')!;
    expect(c.windows.prior.n).toBe(2);
    expect(c.windows.prior.censored).toBe(1);
  });

  it('computes mean_retries over terminal runs, treating a missing retry_count as 0', () => {
    insertRun('rt0', 'retries', 'completed', 12 * DAY, { retry_count: 2 });
    insertRun('rt1', 'retries', 'completed', 12 * DAY + 1000, { retry_count: 1 });
    insertRun('rt2', 'retries', 'completed', 12 * DAY + 2000, { retry_count: 0 });
    insertRun('rt3', 'retries', 'completed', 12 * DAY + 3000);
    const v = learningCurveView(db, NOW, 7, 100);
    const c = v.cohorts.find((x) => x.loop_name === 'retries')!;
    expect(c.windows.prior.mean_retries).toBeCloseTo(0.75);
  });

  it('lists cohorts in alphabetical loop_name order', () => {
    insertRun('z1', 'zeta', 'completed', 3 * DAY);
    insertRun('a1', 'alpha', 'completed', 3 * DAY);
    insertRun('m1', 'mu', 'completed', 3 * DAY);
    const v = learningCurveView(db, NOW, 7, 100);
    expect(v.cohorts.map((c) => c.loop_name)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('upgrades a cohort to gym when any windowed run carries metadata.gym', () => {
    insertRun('g0', 'custom-loop', 'completed', 12 * DAY, {});
    insertRun('g1', 'custom-loop', 'completed', 11 * DAY, { gym: { kind: 'x' } });
    const v = learningCurveView(db, NOW, 7, 100);
    const c = v.cohorts.find((x) => x.loop_name === 'custom-loop')!;
    expect(c.run_class).toBe('gym');
  });

  it('assigns a run whose created_at equals recentSince to the recent window', () => {
    insertRun('edge', 'edge-loop', 'completed', 7 * DAY);
    const v = learningCurveView(db, NOW, 7, 100);
    const c = v.cohorts.find((x) => x.loop_name === 'edge-loop')!;
    expect(c.windows.recent.n).toBe(1);
    expect(c.windows.prior.n).toBe(0);
  });
});

describe('usageWindow', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_name TEXT, status TEXT, created_at TEXT, metadata TEXT);
      CREATE TABLE worker_leases (id TEXT PRIMARY KEY, loop_run_id TEXT, role TEXT, runtime TEXT, status TEXT, created_at TEXT, metadata TEXT);
      CREATE TABLE self_improvements (id TEXT PRIMARY KEY, status TEXT, panel_id TEXT);
      CREATE TABLE goals (id TEXT PRIMARY KEY, improvement_id TEXT);
      CREATE TABLE skill_outcomes (task_id TEXT, skill_id TEXT, success INTEGER);
      CREATE TABLE judgments (id TEXT, judgment TEXT, subject_type TEXT, subject_id TEXT, state_hash TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT);
      CREATE TABLE llm_model_calls (id INTEGER PRIMARY KEY, consumer TEXT, model TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER, run_id TEXT, purpose TEXT, attempts INTEGER, created_at TEXT);`);
  });
  afterEach(() => db.close());

  const insertLease = (id: string, role: string, runtime: string, status: string, msAgo: number, total: number | null, pin: number | null = null, pout: number | null = null) =>
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'run1', role, runtime, status, iso(msAgo), JSON.stringify({ model: 'glm-5.2', runtime_usage: total === null ? null : { total_tokens: total, prompt_tokens: pin, completion_tokens: pout } }));

  const insertModelCall = (id: number, consumer: string, msAgo: number, tin: number, tout: number) =>
    db.prepare('INSERT INTO llm_model_calls (id, consumer, model, provider, tokens_in, tokens_out, run_id, purpose, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, consumer, 'glm-5.2', null, tin, tout, null, null, 1, iso(msAgo));

  it('sums tokens by locality and source with coverage, excludes mirrors, and reports the metric', () => {
    insertLease('l1', 'maker', 'opencode', 'completed', 2 * DAY, 1000, 600, 400); // cloud
    insertLease('l2', 'maker', 'remote', 'completed', 3 * DAY, 500, 300, 200); // local
    insertLease('l3', 'maker', 'opencode', 'completed', 4 * DAY, null); // unknown tokens
    insertModelCall(1, 'maker', 2 * DAY, 100, 50); // mirrored (maker), excluded from events
    const w = usageWindow(db, NOW, 7);
    expect(w.window_days).toBe(7);
    expect(w.events).toBe(3);
    expect(w.known_events).toBe(2);
    expect(w.coverage).toBe(+(2 / 3).toFixed(3));
    expect(w.status).toBe('partial');
    expect(w.total_tokens).toBe(1500);
    expect(w.cloud_tokens).toBe(1000);
    expect(w.local_tokens).toBe(500);
    expect(w.by_source).toEqual({ worker_leases: { events: 3, known: 2 } });
    expect(w.mirrors_excluded).toEqual({ rows: 1, tokens: 150 });
    expect(w.metric.id).toBe('cost.usage_event');
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
    expect(m.note).toMatch(/readout due \d{4}-\d{2}-\d{2} \(/);
  });
});