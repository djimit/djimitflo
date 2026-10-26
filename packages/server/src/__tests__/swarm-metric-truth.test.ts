/**
 * SW-01 / SW-02 (swarm-evolution audit 2026-10-25): the swarm pages' read models report what was observed — real
 * denominators per exact cohort, unknown usage/cost as null, the full capability registry next to the loaded slice, and
 * a mission's advisory planning status next to its linked execution. Read-only: no row is written by any GET.
 */
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

let db: Database.Database;
const app = () => express().use('/swarms', createSwarmRoutes(db, { requirePermission: () => (_req: any, _res: any, next: any) => next() } as any)).use(errorHandler);
const run = (id: string, loop: string, status: string, at: string, extra: { goal?: string; metadata?: Record<string, unknown> } = {}) =>
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, ?, ?, 'closed', ?, ?, ?, ?)")
    .run(id, extra.goal ?? null, loop, status, JSON.stringify(extra.metadata ?? {}), at, at);
const lease = (id: string, runId: string, metadata: Record<string, unknown>, at: string, role = 'maker', runtime = 'codex', status = 'completed') =>
  db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, runId, role, runtime, status, JSON.stringify(metadata), at, at);
const writes = () => db.prepare("SELECT (SELECT COUNT(*) FROM swarm_missions WHERE status != 'observed') + (SELECT COUNT(*) FROM worker_leases WHERE status = 'running') AS n").get() as { n: number };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('SW-01 /swarms/learning-curve', () => {
  it('the audit 3-run fixture (completed, failed, completed; no usage) is 2/3 with n = 3, not 100 % -> 100 % and not $0', async () => {
    for (const [id, status, at] of [['a', 'completed', '2026-10-20T01:00:00Z'], ['b', 'failed', '2026-10-20T02:00:00Z'], ['c', 'completed', '2026-10-20T03:00:00Z']]) run(id, 'repo-maintenance-loop', status, at);
    const res = await request(app()).get('/swarms/learning-curve');
    expect(res.status).toBe(200);
    // the per-run binary status stays, as its own field
    expect(res.body.runs).toHaveLength(3);
    expect(res.body.runs.map((r: { success: boolean }) => r.success)).toEqual([true, false, true]);
    expect(res.body.first_vs_last).toMatchObject({ first_run_success: true, last_run_success: true, first_success_rate: null, last_success_rate: null, first_cost: null, last_cost: null });
    // the rate is a cohort over an equal window with its real denominator
    const cohort = res.body.cohorts.find((c: { loop_name: string }) => c.loop_name === 'repo-maintenance-loop');
    expect(cohort.run_class).toBe('maintenance');
    expect(cohort.windows.recent).toMatchObject({ n: 3, completed: 2, rate: 0.667, censored: 0 });
    expect(cohort.windows.prior).toMatchObject({ n: 0, completed: 0, rate: null });
    expect(cohort.comparison).toMatchObject({ status: 'insufficient', delta: null });
    // no usage record: tokens and cost are unknown, never 0
    expect(cohort.windows.recent.tokens).toMatchObject({ value: null, events: 0, coverage: null, status: 'UNKNOWN' });
    expect(cohort.windows.recent.usd).toMatchObject({ value: null });
    for (const r of res.body.runs) { expect(r.dollars).toBeNull(); expect(r.tokens).toBeNull(); expect(r.cost_status).toBe('UNKNOWN'); }
    expect(writes().n).toBe(0);
  });

  it('reported tokens stay known, but no runtime-level fallback tariff becomes a dollar figure', async () => {
    run('r1', 'doc-drift-and-small-fix-loop', 'completed', '2026-10-20T01:00:00Z');
    lease('l1', 'r1', { runtime: 'codex', runtime_usage: { total_tokens: 1_000_000 } }, '2026-10-20T01:01:00Z');
    lease('l2', 'r1', { runtime: 'codex' }, '2026-10-20T01:02:00Z', 'checker');
    const res = await request(app()).get('/swarms/learning-curve');
    const r1 = res.body.runs.find((r: { run_id: string }) => r.run_id === 'r1');
    expect(r1).toMatchObject({ tokens: 1_000_000, usage_events: 2, usage_events_known: 1, dollars: null, cost_status: 'UNKNOWN' });
    const cohort = res.body.cohorts.find((c: { loop_name: string }) => c.loop_name === 'doc-drift-and-small-fix-loop');
    expect(cohort.run_class).toBe('production');
    expect(cohort.windows.recent.tokens).toMatchObject({ value: 1_000_000, events: 2, known: 1, coverage: 0.5, status: 'partial' });
    expect(cohort.windows.recent.usd.value).toBeNull();
  });

  it('gym, maintenance and production are never pooled: one cohort per loop, no pooled rate', async () => {
    run('g1', 'evolution-gym', 'completed', '2026-10-19T01:00:00Z', { metadata: { gym: { species: 'atomic@x' } } });
    run('g2', 'evolution-gym', 'failed', '2026-10-19T02:00:00Z', { metadata: { gym: { species: 'atomic@x' } } });
    run('m1', 'repo-maintenance-loop', 'completed', '2026-10-19T03:00:00Z');
    run('p1', 'doc-drift-and-small-fix-loop', 'failed', '2026-10-19T04:00:00Z');
    run('p2', 'doc-drift-and-small-fix-loop', 'running', '2026-10-19T05:00:00Z');
    const res = await request(app()).get('/swarms/learning-curve');
    expect(res.body.pooled).toBe(false);
    const byLoop = Object.fromEntries(res.body.cohorts.map((c: any) => [c.loop_name, c]));
    expect(Object.keys(byLoop).sort()).toEqual(['doc-drift-and-small-fix-loop', 'evolution-gym', 'repo-maintenance-loop']);
    expect(byLoop['evolution-gym']).toMatchObject({ run_class: 'gym', windows: { recent: { n: 2, completed: 1, rate: 0.5 } } });
    expect(byLoop['repo-maintenance-loop']).toMatchObject({ run_class: 'maintenance', windows: { recent: { n: 1, completed: 1, rate: 1 } } });
    // a running run is censored, not a failure
    expect(byLoop['doc-drift-and-small-fix-loop']).toMatchObject({ run_class: 'production', windows: { recent: { n: 1, completed: 0, rate: 0, censored: 1 } } });
    expect(res.body).not.toHaveProperty('success_rate');
  });

  it('compares equal windows only when both have the registered minimum n', async () => {
    const hours = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00:00Z`;
    for (let i = 0; i < 10; i++) run(`p${i}`, 'research-loop', i < 5 ? 'completed' : 'failed', hours('2026-10-10', i)); // prior: 5/10
    for (let i = 0; i < 10; i++) run(`r${i}`, 'research-loop', i < 8 ? 'completed' : 'failed', hours('2026-10-17', i)); // recent: 8/10
    const res = await request(app()).get('/swarms/learning-curve');
    const c = res.body.cohorts.find((x: { loop_name: string }) => x.loop_name === 'research-loop');
    expect(c.windows.prior).toMatchObject({ n: 10, completed: 5, rate: 0.5 });
    expect(c.windows.recent).toMatchObject({ n: 10, completed: 8, rate: 0.8 });
    expect(c.comparison).toMatchObject({ status: 'compared', delta: 0.3 });
    expect(res.body.window).toMatchObject({ days: 7, recent: { since: '2026-10-14T00:00:00.000Z', until: '2026-10-21T00:00:00.000Z' }, prior: { since: '2026-10-07T00:00:00.000Z' } });
  });

  it('names the memory-holdout readout without computing its effect', async () => {
    const res = await request(app()).get('/swarms/learning-curve');
    const readout = res.body.registered_readouts.find((r: { id: string }) => r.id === 'memory-holdout');
    expect(readout).toMatchObject({ stop_by: '2026-10-27T00:00:00.000Z', analysis: 'registered single analysis', causal_conclusion: null });
    expect(readout).not.toHaveProperty('p');
    expect(readout).not.toHaveProperty('effects');
    expect(readout).not.toHaveProperty('n_per_arm');
  });
});

describe('SW-01 /swarms/usage-window', () => {
  it('sums recorded usage for the stated window with coverage, and is unknown (null) without records', async () => {
    let res = await request(app()).get('/swarms/usage-window');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ window_days: 7, events: 0, total_tokens: null, cloud_tokens: null, local_tokens: null, coverage: null, status: 'UNKNOWN' });
    run('r1', 'doc-drift-and-small-fix-loop', 'completed', '2026-10-20T01:00:00Z');
    lease('l1', 'r1', { runtime_usage: { total_tokens: 400 } }, '2026-10-20T01:01:00Z');
    lease('l2', 'r1', { runtime_usage: { total_tokens: 100 } }, '2026-10-20T01:02:00Z', 'checker', 'remote');
    lease('l3', 'r1', {}, '2026-10-20T01:03:00Z', 'checker');
    lease('old', 'r1', { runtime_usage: { total_tokens: 9_999 } }, '2026-10-01T00:00:00Z');
    res = await request(app()).get('/swarms/usage-window?days=7');
    expect(res.body).toMatchObject({ window_days: 7, since: '2026-10-14T00:00:00.000Z', until: '2026-10-21T00:00:00.000Z',
      events: 3, known_events: 2, total_tokens: 500, cloud_tokens: 400, local_tokens: 100, coverage: 0.667, status: 'partial' });
    expect((await request(app()).get('/swarms/usage-window?days=0')).status).toBe(400);
  });
});

describe('SW-02 capability registry and mission execution', () => {
  it('reports the registry total next to the latest-100 slice Mission Control loads (512 vs 100)', async () => {
    const insert = db.prepare(`INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, removal_strategy, updated_at)
      VALUES (?, 'skill', 'fixture', '1', ?, 'low', 'in', 'out', 'remove', ?)`);
    db.transaction(() => { for (let i = 0; i < 512; i++) insert.run(`cap-${String(i).padStart(3, '0')}`, i < 35 ? 'candidate' : 'deprecated', new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()); })();
    const mc = await request(app()).get('/swarms/intelligence/mission-control');
    expect(mc.status).toBe(200);
    expect(mc.body.capability_health).toMatchObject({ total: 100, loaded: 100, load_limit: 100, registry_total: 512, registry_by_status: { candidate: 35, deprecated: 477 } });
    const list = await request(app()).get('/swarms/intelligence/capabilities?limit=50');
    expect(list.body.capabilities).toHaveLength(50);
    expect(list.body).toMatchObject({ registry_total: 512, loaded: 50, limit: 50 });
  });

  it('shows an observed mission next to its completed goal and unique loop runs, without transitioning it', async () => {
    db.prepare("INSERT INTO goals (id, objective, risk_class, status) VALUES ('g-done', 'fixture', 'low', 'completed')").run();
    db.prepare("INSERT INTO swarm_missions (id, goal_id, title, risk_class, status, created_at) VALUES ('m-linked', 'g-done', 'Linked', 'low', 'observed', '2026-10-20T00:00:00Z')").run();
    db.prepare("INSERT INTO swarm_missions (id, goal_id, title, risk_class, status, created_at) VALUES ('m-orphan', NULL, 'Orphan', 'low', 'observed', '2026-10-19T00:00:00Z')").run();
    run('run-1', 'doc-drift-and-small-fix-loop', 'failed', '2026-10-20T01:00:00Z', { goal: 'g-done' });
    run('run-2', 'doc-drift-and-small-fix-loop', 'completed', '2026-10-20T02:00:00Z', { goal: 'g-done' });
    for (const [id, r] of [['a', 'run-1'], ['b', 'run-1'], ['c', 'run-2'], ['d', 'run-2'], ['e', 'run-2']]) lease(id, r, {}, '2026-10-20T03:00:00Z');
    db.prepare("INSERT INTO loop_learning_closures (loop_run_id, eval_run_id, reflection_id, memory_candidate_id) VALUES ('run-2', 'e', 'r', 'm')").run();
    const res = await request(app()).get('/swarms/intelligence/missions/execution');
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ registered: 2, by_planning_status: { observed: 2 }, by_goal_status: { completed: 1, unknown: 1 } });
    const linked = res.body.missions.find((m: { mission_id: string }) => m.mission_id === 'm-linked');
    expect(linked).toMatchObject({ planning_status: 'observed', lineage: 'linked', goal_status: 'completed',
      execution: { loop_runs: 2, by_status: { failed: 1, completed: 1 }, latest_run: { id: 'run-2', status: 'completed' }, closed_runs: 1 } });
    const orphan = res.body.missions.find((m: { mission_id: string }) => m.mission_id === 'm-orphan');
    expect(orphan).toMatchObject({ lineage: 'no_goal', goal_status: null, execution: null });
    expect((db.prepare("SELECT status FROM swarm_missions WHERE id = 'm-linked'").get() as { status: string }).status).toBe('observed');
  });

  it('links the swarm identity to its current executions (prepared/running leases with their run)', async () => {
    run('live', 'doc-drift-and-small-fix-loop', 'running', '2026-10-20T01:00:00Z');
    lease('lp', 'live', {}, '2026-10-20T01:00:00Z', 'maker', 'codex', 'prepared');
    lease('ld', 'live', {}, '2026-10-20T01:00:00Z', 'checker', 'codex', 'completed');
    const mc = await request(app()).get('/swarms/intelligence/mission-control');
    expect(mc.body.swarm_truth.current_executions).toEqual([expect.objectContaining({ lease_id: 'lp', loop_run_id: 'live', loop_name: 'doc-drift-and-small-fix-loop', runtime: 'codex', role: 'maker', status: 'prepared' })]);
  });
});
