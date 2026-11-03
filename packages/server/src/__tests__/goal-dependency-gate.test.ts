import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { GoalService } from '../services/goal-service';
import { DEPENDENCY_GATE_LOOP, blockOnUnmetDependencies, settleDependencyBlockedGoals } from '../services/goal-dependency-gate';
import { swarmEventBus, type SwarmEvent } from '../services/swarm-event-bus';

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

  it('blocks on a cancelled dependency with reason "failed" and status "cancelled"', () => {
    const { dependent } = depPair('b-cancel', 'cancelled');
    expect(blockOnUnmetDependencies(db, dependent.id)).toBe(true);
    const block = svc().getGoalById(dependent.id).metadata.dependency_block as any;
    expect(block.reason).toBe('failed');
    expect(block.dependency_status).toBe('cancelled');
  });

  it('blocks on an unresolved (incomplete) dependency', () => {
    const { dependent } = depPair('b3', 'running');
    expect(blockOnUnmetDependencies(db, dependent.id)).toBe(true);
    expect(svc().getGoalById(dependent.id).metadata.dependency_block.reason).toBe('unresolved');
  });

  it('marks completed-without-evidence as unresolved with detail', () => {
    const { dependent } = depPair('b-noev', 'completed', {});
    expect(blockOnUnmetDependencies(db, dependent.id)).toBe(true);
    const block = svc().getGoalById(dependent.id).metadata.dependency_block as any;
    expect(block.reason).toBe('unresolved');
    expect(block.detail).toBe('completed_without_acceptance_evidence');
  });

  it('is idempotent: second call does not add another event', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] });
    blockOnUnmetDependencies(db, g.id);
    blockOnUnmetDependencies(db, g.id);
    const events = db.prepare('SELECT * FROM loop_events WHERE loop_run_id=?').all(`${DEPENDENCY_GATE_LOOP}:${g.id}`) as any[];
    expect(events.length).toBe(1);
  });

  it('returns true for an already-blocked goal with dependency_block without re-writing', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] }, 'blocked');
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.dependency_block',json(?)) WHERE id=?")
      .run(JSON.stringify({ reason: 'missing', dependency_key: 'nope', since: '2025-01-01T00:00:00Z', previous_status: 'created' }), g.id);
    expect(blockOnUnmetDependencies(db, g.id)).toBe(true);
  });

  it('returns false for a blocked goal WITHOUT dependency_block', () => {
    const g = makeGoal({}, 'blocked');
    expect(blockOnUnmetDependencies(db, g.id)).toBe(false);
  });

  it('returns false for a running goal (not created/decomposed/blocked)', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] }, 'running');
    expect(blockOnUnmetDependencies(db, g.id)).toBe(false);
    expect(svc().getGoalById(g.id).status).toBe('running');
  });

  it('blocks a decomposed goal with unmet dependencies and stores previous_status', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] }, 'decomposed');
    expect(blockOnUnmetDependencies(db, g.id)).toBe(true);
    const row = svc().getGoalById(g.id);
    expect(row.status).toBe('blocked');
    const block = row.metadata.dependency_block as any;
    expect(block.previous_status).toBe('decomposed');
  });

  it('emits a convergence event on the swarm bus when blocking succeeds', () => {
    const events: SwarmEvent[] = [];
    const unsub = swarmEventBus.subscribe((e) => events.push(e));
    try {
      const g = makeGoal({ depends_on_goal_keys: ['dep-key-1'] });
      blockOnUnmetDependencies(db, g.id);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('convergence');
      expect(events[0].data).toMatchObject({
        daemon: 'goal_dependency_blocked',
        goal_id: g.id,
        reason: 'missing',
        dependency_key: 'dep-key-1',
      });
    } finally {
      unsub();
    }
  });

  it('does NOT emit a second convergence event on idempotent re-call', () => {
    const events: SwarmEvent[] = [];
    const unsub = swarmEventBus.subscribe((e) => events.push(e));
    try {
      const g = makeGoal({ depends_on_goal_keys: ['nope'] });
      blockOnUnmetDependencies(db, g.id);
      blockOnUnmetDependencies(db, g.id);
      const mine = events.filter((e) => e.type === 'convergence' && (e.data as any).goal_id === g.id);
      expect(mine).toHaveLength(1);
    } finally {
      unsub();
    }
  });

  it('writes the anchor loop_run with mode=closed, status=completed, and event_anchor metadata', () => {
    const g = makeGoal({ depends_on_goal_keys: ['nope'] });
    blockOnUnmetDependencies(db, g.id);
    const run = db.prepare('SELECT * FROM loop_runs WHERE id=?').get(`${DEPENDENCY_GATE_LOOP}:${g.id}`) as any;
    expect(run).toBeDefined();
    expect(run.mode).toBe('closed');
    expect(run.status).toBe('completed');
    const meta = JSON.parse(run.metadata);
    expect(meta.event_anchor).toBe(true);
    expect(meta.goal_id).toBe(g.id);
  });

  it('records blocked event with level "warning" and goal_id in metadata', () => {
    const g = makeGoal({ depends_on_goal_keys: ['dep-x'] });
    blockOnUnmetDependencies(db, g.id);
    const ev = db.prepare("SELECT * FROM loop_events WHERE loop_run_id=?").get(`${DEPENDENCY_GATE_LOOP}:${g.id}`) as any;
    expect(ev.level).toBe('warning');
    const meta = JSON.parse(ev.metadata);
    expect(meta.goal_id).toBe(g.id);
    expect(meta.reason).toBe('missing');
    expect(meta.dependency_key).toBe('dep-x');
  });

  it('includes dependency_status parenthetical in the message when present', () => {
    const { dependent } = depPair('b-msg', 'running');
    blockOnUnmetDependencies(db, dependent.id);
    const ev = db.prepare("SELECT message FROM loop_events WHERE loop_run_id=?").get(`${DEPENDENCY_GATE_LOOP}:${dependent.id}`) as any;
    expect(ev.message).toContain('unresolved dependency b-msg (running)');
  });

  it('omits status parenthetical from message when dependency_status is null (missing)', () => {
    const g = makeGoal({ depends_on_goal_keys: ['ghost'] });
    blockOnUnmetDependencies(db, g.id);
    const ev = db.prepare("SELECT message FROM loop_events WHERE loop_run_id=?").get(`${DEPENDENCY_GATE_LOOP}:${g.id}`) as any;
    expect(ev.message).toBe('Goal blocked: missing dependency ghost');
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

  it('restores to "decomposed" when previous_status was decomposed', () => {
    const g2 = makeGoal({ depends_on_goal_keys: ['b-decomp'] }, 'decomposed');
    const dep2 = makeGoal({ goal_batch: { id: 'b-decomp' } }, 'running');
    blockOnUnmetDependencies(db, g2.id);
    let row = svc().getGoalById(g2.id);
    expect((row.metadata.dependency_block as any).previous_status).toBe('decomposed');
    db.prepare("UPDATE goals SET status='completed', metadata=json_set(metadata,'$.acceptance_evidence',json(?)) WHERE id=?")
      .run(JSON.stringify(['ok']), dep2.id);
    settleDependencyBlockedGoals(db);
    row = svc().getGoalById(g2.id);
    expect(row.status).toBe('decomposed');
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

  it('writes an unblock event with level "info" and correct metadata fields', () => {
    const { dep, dependent } = depPair('b6', 'running');
    blockOnUnmetDependencies(db, dependent.id);
    db.prepare("UPDATE goals SET status='completed', metadata=json_set(metadata,'$.acceptance_evidence',json(?)) WHERE id=?")
      .run(JSON.stringify(['ok']), dep.id);
    settleDependencyBlockedGoals(db);
    const evs = db.prepare("SELECT * FROM loop_events WHERE loop_run_id=? AND event_type='goal_dependency_unblocked'").all(`${DEPENDENCY_GATE_LOOP}:${dependent.id}`) as any[];
    expect(evs.length).toBe(1);
    expect(evs[0].level).toBe('info');
    const meta = JSON.parse(evs[0].metadata);
    expect(meta.goal_id).toBe(dependent.id);
    expect(meta.dependency_key).toBe('b6');
    expect(meta.restored_status).toBe('created');
  });

  it('advances to the next unmet key once an earlier one becomes satisfied', () => {
    const g = makeGoal({ depends_on_goal_keys: ['key-a', 'key-b'] });
    // key-a doesn't exist yet → blocks on key-a (missing)
    blockOnUnmetDependencies(db, g.id);
    let row = svc().getGoalById(g.id);
    expect((row.metadata.dependency_block as any).dependency_key).toBe('key-a');
    // Create key-a as completed WITH evidence so dependencyBlock skips past it
    db.prepare("INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, owner_user_id, metadata, created_at, updated_at) VALUES ('ka-goal','o','[]','[\"a\"]','low','{}','completed',NULL,'{\"goal_batch\":{\"id\":\"key-a\"},\"acceptance_evidence\":[\"ok\"]}','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')").run();
    settleDependencyBlockedGoals(db);
    row = svc().getGoalById(g.id);
    expect(row.status).toBe('blocked');
    const newBlock = row.metadata.dependency_block as any;
    expect(newBlock.reason).toBe('missing');
    expect(newBlock.dependency_key).toBe('key-b');
  });

  it('settles multiple blocked goals in a single pass', () => {
    const { dep: d1, dependent: g1 } = depPair('multi-1', 'running');
    const { dep: d2, dependent: g2 } = depPair('multi-2', 'running');
    blockOnUnmetDependencies(db, g1.id);
    blockOnUnmetDependencies(db, g2.id);
    db.prepare("UPDATE goals SET status='completed', metadata=json_set(metadata,'$.acceptance_evidence',json(?)) WHERE id=?")
      .run(JSON.stringify(['ok']), d1.id);
    db.prepare("UPDATE goals SET status='completed', metadata=json_set(metadata,'$.acceptance_evidence',json(?)) WHERE id=?")
      .run(JSON.stringify(['ok']), d2.id);
    settleDependencyBlockedGoals(db);
    expect(svc().getGoalById(g1.id).status).toBe('created');
    expect(svc().getGoalById(g2.id).status).toBe('created');
  });

  it('does not process non-blocked goals or blocked goals without dependency_block', () => {
    makeGoal({ depends_on_goal_keys: ['x'] }, 'running');
    makeGoal({}, 'blocked');
    const before = (db.prepare('SELECT COUNT(*) c FROM loop_events').get() as any).c;
    settleDependencyBlockedGoals(db);
    const after = (db.prepare('SELECT COUNT(*) c FROM loop_events').get() as any).c;
    expect(after).toBe(before);
  });
});
