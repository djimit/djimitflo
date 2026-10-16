import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { GoalService } from '../services/goal-service';
import { DEPENDENCY_GATE_LOOP, blockOnUnmetDependencies, settleDependencyBlockedGoals } from '../services/goal-dependency-gate';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => { db.close(); });

const svc = () => new GoalService(db);

function makeGoal(meta: Record<string, unknown> = {}, status = 'created') {
  const g = svc().createGoal({ objective: 'o', acceptance_criteria: ['a'], metadata: meta });
  if (status !== 'created') db.prepare('UPDATE goals SET status=? WHERE id=?').run(status, g.id);
  return g;
}

/** Create a dependency pair: dep has goal_batch.id=batchKey; dependent depends on batchKey. */
function depPair(batchKey: string, depStatus = 'running', depMeta: Record<string, unknown> = {}) {
  const dep = makeGoal({ goal_batch: { id: batchKey }, ...depMeta }, depStatus);
  const dependent = makeGoal({ depends_on_goal_keys: [batchKey] });
  return { dep, dependent };
}

describe('DEPENDENCY_GATE_LOOP', () => {
  it('is the fixed anchor loop name', () => {
    expect(DEPENDENCY_GATE_LOOP).toBe('goal-dependency-gate');
  });
});

describe('blockOnUnmetDependencies', () => {
  it('returns false when the goal has no dependencies', () => {
    const g = makeGoal();
    expect(blockOnUnmetDependencies(db, g.id)).toBe(false);
    expect(svc().getGoalById(g.id).status).toBe('created');
  });

  it('returns false when all dependencies are satisfied (completed + evidence)', () => {
    const { dependent } = depPair('b1', 'completed', { acceptance_evidence: ['ok'] });
    expect(blockOnUnmetDependencies(db, dependent.id)).toBe(false);
  });

  it('blocks on a missing dependency key and writes one event', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] });
    expect(blockOnUnmetDependencies(db, g.id)).toBe(true);
    const row = svc().getGoalById(g.id);
    expect(row.status).toBe('blocked');
    expect(row.metadata.dependency_block.reason).toBe('missing');
    const events = db.prepare('SELECT * FROM loop_events WHERE loop_run_id=?').all(`${DEPENDENCY_GATE_LOOP}:${g.id}`) as any[];
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('goal_dependency_blocked');
  });

  it('blocks on a failed dependency', () => {
    const { dependent } = depPair('b2', 'failed');
    expect(blockOnUnmetDependencies(db, dependent.id)).toBe(true);
    expect(svc().getGoalById(dependent.id).metadata.dependency_block.reason).toBe('failed');
  });

  it('blocks on an unresolved (incomplete) dependency', () => {
    const { dependent } = depPair('b3', 'running');
    expect(blockOnUnmetDependencies(db, dependent.id)).toBe(true);
    expect(svc().getGoalById(dependent.id).metadata.dependency_block.reason).toBe('unresolved');
  });

  it('is idempotent: second call does not add another event', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] });
    blockOnUnmetDependencies(db, g.id);
    blockOnUnmetDependencies(db, g.id);
    const events = db.prepare('SELECT * FROM loop_events WHERE loop_run_id=?').all(`${DEPENDENCY_GATE_LOOP}:${g.id}`) as any[];
    expect(events.length).toBe(1);
  });

  it('returns true for an already-blocked goal without re-writing', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] }, 'blocked');
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.dependency_block',json(?)) WHERE id=?")
      .run(JSON.stringify({ reason: 'missing', dependency_key: 'nope', since: '2025-01-01T00:00:00Z', previous_status: 'created' }), g.id);
    expect(blockOnUnmetDependencies(db, g.id)).toBe(true);
  });
});

describe('settleDependencyBlockedGoals', () => {
  it('unblocks a goal whose dependency became satisfied and restores status', () => {
    const { dep, dependent } = depPair('b4', 'running');
    blockOnUnmetDependencies(db, dependent.id);
    db.prepare("UPDATE goals SET status='completed', metadata=json_set(metadata,'$.acceptance_evidence',json(?)) WHERE id=?")
      .run(JSON.stringify(['done']), dep.id);
    settleDependencyBlockedGoals(db);
    const row = svc().getGoalById(dependent.id);
    expect(row.status).toBe('created');
    expect(row.metadata.dependency_block).toBeUndefined();
    const events = db.prepare("SELECT event_type FROM loop_events WHERE loop_run_id=?").all(`${DEPENDENCY_GATE_LOOP}:${dependent.id}`) as Array<{ event_type: string }>;
    expect(events.length).toBe(2);
    expect(new Set(events.map((e) => e.event_type))).toEqual(new Set(['goal_dependency_blocked', 'goal_dependency_unblocked']));
  });

  it('does nothing when the block is unchanged', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] });
    blockOnUnmetDependencies(db, g.id);
    const before = (db.prepare('SELECT COUNT(*) c FROM loop_events').get() as any).c;
    settleDependencyBlockedGoals(db);
    const after = (db.prepare('SELECT COUNT(*) c FROM loop_events').get() as any).c;
    expect(after).toBe(before);
  });

  it('skips operator-paused goals', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] });
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.operator_paused',json(true)) WHERE id=?").run(g.id);
    blockOnUnmetDependencies(db, g.id);
    const before = (db.prepare('SELECT COUNT(*) c FROM loop_events').get() as any).c;
    settleDependencyBlockedGoals(db);
    const after = (db.prepare('SELECT COUNT(*) c FROM loop_events').get() as any).c;
    expect(after).toBe(before);
    expect(svc().getGoalById(g.id).status).toBe('blocked');
  });

  it('updates the block when the dependency reason changes', () => {
    const { dep, dependent } = depPair('b5', 'running');
    blockOnUnmetDependencies(db, dependent.id);
    db.prepare("UPDATE goals SET status='failed' WHERE id=?").run(dep.id);
    settleDependencyBlockedGoals(db);
    const row = svc().getGoalById(dependent.id);
    expect(row.status).toBe('blocked');
    expect(row.metadata.dependency_block.reason).toBe('failed');
  });
});
