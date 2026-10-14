import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

/**
 * Inventory 2026-10: a goal whose `depends_on` was unmet went through executeGoal → decompose/startLoop →
 * assertDependenciesSatisfied threw → the catch marked it 'failed' and, with no run yet, recorded no loop event.
 * An unmet dependency is now an explicit, durable 'blocked' state with one loop event per transition.
 */
describe('goal dependencies: unmet → explicit blocked state with a loop event', () => {
  let db: Database.Database;
  let goals: GoalService;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON'); // the event anchor must satisfy loop_events → loop_runs
    db.exec(schema);
    runMigrations(db);
    for (const key of ['SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE']) { prev[key] = process.env[key]; delete process.env[key]; }
    goals = new GoalService(db);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close(); vi.restoreAllMocks();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const goal = (key: string, dependsOn?: string[], status = 'decomposed') => {
    const g = goals.createGoal({ objective: `goal ${key}`, acceptance_criteria: ['pass'], metadata: { goal_batch: { id: key }, ...(dependsOn ? { depends_on_goal_keys: dependsOn } : {}) } });
    db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, g.id);
    return g.id;
  };
  const complete = (id: string) => db.prepare("UPDATE goals SET status = 'completed', metadata = json_set(metadata, '$.acceptance_evidence', json('[{\"ref\":\"r\"}]')) WHERE id = ?").run(id);
  const row = (id: string) => {
    const r = db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(id) as { status: string; metadata: string };
    return { status: r.status, block: JSON.parse(r.metadata).dependency_block };
  };
  const events = (id: string, type?: string) => (db.prepare(`SELECT event_type, metadata FROM loop_events WHERE json_extract(metadata, '$.goal_id') = ? ${type ? 'AND event_type = ?' : ''} ORDER BY created_at, rowid`)
    .all(...(type ? [id, type] : [id])) as Array<{ event_type: string; metadata: string }>).map((e) => ({ type: e.event_type, ...JSON.parse(e.metadata) }));
  const loopsMock = (start = vi.fn((input: { goal_id: string }) => ({ id: `run-${input.goal_id}`, findings: [] }))) => ({ start, loops: { pruneOrphanedWorktrees: vi.fn(), startDocDriftAndSmallFixLoop: start } });
  const tick = async (loops: Record<string, unknown>) => {
    const d = new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await d.tick(); d.stop();
    await new Promise((r) => setImmediate(r));
  };
  const dispatched = (start: ReturnType<typeof vi.fn>, id: string) => start.mock.calls.filter(([input]) => (input as { goal_id: string }).goal_id === id).length;

  it('leaves goals without depends_on unchanged: dispatched, no dependency state or event', async () => {
    const plain = goal('P');
    const { start, loops } = loopsMock();
    await tick(loops);
    expect(dispatched(start, plain)).toBe(1);
    expect(row(plain)).toEqual({ status: 'completed', block: undefined });
    expect(db.prepare("SELECT COUNT(*) n FROM loop_events WHERE event_type LIKE 'goal_dependency_%'").get()).toEqual({ n: 0 });
  });

  it('unmet dependency → blocked (unresolved) with identity, reason, timestamp and exactly one event over repeated ticks', async () => {
    const a = goal('A', undefined, 'running');
    const b = goal('B', ['A']);
    const { start, loops } = loopsMock();
    await tick(loops);
    await tick(loops);
    expect(dispatched(start, b)).toBe(0);
    const { status, block } = row(b);
    expect(status).toBe('blocked');
    expect(block).toMatchObject({ reason: 'unresolved', dependency_key: 'A', dependency_goal_id: a, dependency_status: 'running', previous_status: 'decomposed' });
    expect(Number.isNaN(Date.parse(block.since))).toBe(false);
    expect(events(b)).toEqual([expect.objectContaining({ type: 'goal_dependency_blocked', reason: 'unresolved', dependency_key: 'A', dependency_goal_id: a })]);
    expect(events(b, 'goal_failed')).toHaveLength(0);
  });

  it('dependency completes → unblocked (one event) → dispatched exactly once', async () => {
    const a = goal('A', undefined, 'running');
    const b = goal('B', ['A']);
    const { start, loops } = loopsMock();
    await tick(loops);
    complete(a);
    await tick(loops);
    await tick(loops);
    expect(dispatched(start, b)).toBe(1);
    expect(row(b)).toEqual({ status: 'completed', block: undefined });
    expect(events(b).map((e) => e.type)).toEqual(['goal_dependency_blocked', 'goal_dependency_unblocked']);
  });

  it('dependency fails → blocked (failed), terminal until the dependency changes', async () => {
    const a = goal('A', undefined, 'running');
    const b = goal('B', ['A']);
    const { start, loops } = loopsMock();
    await tick(loops);
    db.prepare("UPDATE goals SET status = 'failed' WHERE id = ?").run(a);
    await tick(loops);
    await tick(loops);
    expect(dispatched(start, b)).toBe(0);
    expect(row(b)).toMatchObject({ status: 'blocked', block: { reason: 'failed', dependency_key: 'A', dependency_status: 'failed' } });
    expect(events(b).map((e) => `${e.type}:${e.reason}`)).toEqual(['goal_dependency_blocked:unresolved', 'goal_dependency_blocked:failed']);
    expect(events(b)[1]).toMatchObject({ previous_reason: 'unresolved' });
  });

  it('missing dependency → blocked (missing), one event; a goal created later with that key unblocks it', async () => {
    const b = goal('B', ['GHOST']);
    const { start, loops } = loopsMock();
    await tick(loops);
    await tick(loops);
    expect(row(b)).toMatchObject({ status: 'blocked', block: { reason: 'missing', dependency_key: 'GHOST', dependency_goal_id: null } });
    expect(events(b)).toHaveLength(1);
    complete(goal('GHOST', undefined, 'running'));
    await tick(loops);
    expect(dispatched(start, b)).toBe(1);
  });

  it('cyclic dependencies → both blocked (cyclic) once, never dispatched', async () => {
    const a = goal('A', ['B']);
    const b = goal('B', ['A']);
    const { start, loops } = loopsMock();
    await tick(loops);
    await tick(loops);
    await tick(loops);
    expect(start).not.toHaveBeenCalled();
    for (const id of [a, b]) {
      expect(row(id)).toMatchObject({ status: 'blocked', block: { reason: 'cyclic' } });
      expect(events(id)).toHaveLength(1);
    }
    expect(row(a).block.cycle).toEqual(['A', 'B', 'A']);
  });

  it('a restart re-reads the blocked state from the DB: no new event, and still unblocks later', async () => {
    const a = goal('A', undefined, 'running');
    const b = goal('B', ['A']);
    await tick(loopsMock().loops);
    const restarted = loopsMock(); // a fresh daemon instance = process restart (no in-memory state survives)
    await tick(restarted.loops);
    expect(row(b).status).toBe('blocked');
    expect(events(b)).toHaveLength(1);
    complete(a);
    await tick(restarted.loops);
    expect(dispatched(restarted.start, b)).toBe(1);
  });

  it('never fails silently: a dependency error raised during execution blocks the goal with an event instead of failing it', async () => {
    const a = goal('A', undefined, 'running');
    complete(a);
    const b = goal('B', ['A']);
    // the dependency regresses between the gate and startLoop (race); startLoop's own assert throws
    const start = vi.fn(() => { db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(a); goals.assertDependenciesSatisfied(b); return { id: 'never', findings: [] }; });
    await tick(loopsMock(start).loops);
    expect(row(b)).toMatchObject({ status: 'blocked', block: { reason: 'unresolved', dependency_key: 'A' } });
    expect(events(b).map((e) => e.type)).toEqual(['goal_dependency_blocked']);
  });

  it('GoalService keeps its API error codes (missing → NOT_FOUND, others → UNSATISFIED)', () => {
    const b = goal('B', ['GHOST']);
    expect(() => goals.assertDependenciesSatisfied(b)).toThrow('GOAL_DEPENDENCY_NOT_FOUND:GHOST');
    const c = goal('C', ['D']);
    goal('D', ['C']);
    expect(() => goals.assertDependenciesSatisfied(c)).toThrow('GOAL_DEPENDENCY_UNSATISFIED:D');
  });
});
