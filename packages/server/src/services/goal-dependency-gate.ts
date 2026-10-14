import type { Database } from 'better-sqlite3';
import { GoalService, type GoalDependencyBlock } from './goal-service';
import { LoopEventService } from './loop-event-service';
import { swarmEventBus } from './swarm-event-bus';

/**
 * An unmet `depends_on` is a wait, not a failure. Before this, executeGoal() hit assertDependenciesSatisfied() before any
 * loop_run existed, the catch marked the goal 'failed', and — with no run id — no loop event was written at all.
 *
 * State: goals.status = 'blocked' + metadata.dependency_block (the same shape as the approval wait and the operator pause:
 * a blocked status plus what it waits for and the status to return to). Every transition is one compare-and-set on the
 * goal row and, in the same transaction, one loop event — so the same transition applied twice writes one event.
 * The daemon re-evaluates blocked goals each tick; a failed/missing/cyclic dependency stays blocked (no retry, no event)
 * until the dependency graph changes.
 */
export interface StoredDependencyBlock extends GoalDependencyBlock {
  since: string;
  previous_status: 'created' | 'decomposed';
}

/** loop_events needs a loop_run (FK). A goal blocked before dispatch has none, so its events hang off one fixed anchor. */
export const DEPENDENCY_GATE_LOOP = 'goal-dependency-gate';
const anchorRunId = (goalId: string) => `${DEPENDENCY_GATE_LOOP}:${goalId}`;

function ensureAnchor(db: Database, goalId: string, now: string): string {
  const id = anchorRunId(goalId);
  // goal_id stays NULL so goal→run lookups (resume, pause, latest run) never mistake the anchor for an execution run
  db.prepare(`INSERT OR IGNORE INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at, completed_at)
    VALUES (?, ?, 'closed', 'completed', ?, ?, ?, ?)`).run(id, DEPENDENCY_GATE_LOOP, JSON.stringify({ goal_id: goalId, event_anchor: true }), now, now, now);
  return id;
}

function record(db: Database, goalId: string, type: 'goal_dependency_blocked' | 'goal_dependency_unblocked', message: string, meta: Record<string, unknown>, now: string): void {
  new LoopEventService(db).recordEvent(ensureAnchor(db, goalId, now), type, type === 'goal_dependency_blocked' ? 'warning' : 'info', message, { goal_id: goalId, ...meta });
}

const sameBlock = (a: GoalDependencyBlock, b: GoalDependencyBlock) => a.reason === b.reason && a.dependency_key === b.dependency_key;
const describe = (b: GoalDependencyBlock) => `${b.reason} dependency ${b.dependency_key}${b.dependency_status ? ` (${b.dependency_status})` : ''}`;

/**
 * Called for a queued goal before dispatch. Returns true when the goal is (now) blocked on its dependencies and must
 * not be dispatched. Goals without depends_on return false without a write.
 */
export function blockOnUnmetDependencies(db: Database, goalId: string): boolean {
  const goals = new GoalService(db);
  const goal = goals.getGoalById(goalId);
  if (goal.status !== 'created' && goal.status !== 'decomposed') return goal.status === 'blocked' && Boolean(goal.metadata.dependency_block);
  const block = goals.dependencyBlock(goal.metadata);
  if (!block) return false;
  const now = new Date().toISOString();
  const stored: StoredDependencyBlock = { ...block, since: now, previous_status: goal.status };
  const applied = db.transaction(() => {
    const changed = db.prepare(`UPDATE goals SET status = 'blocked', metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.dependency_block', json(?)), updated_at = ?
      WHERE id = ? AND status = ?`).run(JSON.stringify(stored), now, goalId, goal.status).changes === 1;
    if (changed) record(db, goalId, 'goal_dependency_blocked', `Goal blocked: ${describe(block)}`, { ...block, previous_status: goal.status }, now);
    return changed;
  })();
  if (applied) swarmEventBus.emit('convergence', { daemon: 'goal_dependency_blocked', goal_id: goalId, reason: block.reason, dependency_key: block.dependency_key });
  return true;
}

/**
 * Called once per daemon tick: re-evaluate every dependency-blocked goal. Satisfied → back to the status it had (one
 * 'unblocked' event; the same tick's queue then dispatches it once). A different reason/dependency → one new 'blocked'
 * event. Unchanged → nothing. Bounded by the number of dependency-blocked goals; nothing executes here.
 */
export function settleDependencyBlockedGoals(db: Database): void {
  const goals = new GoalService(db);
  const rows = db.prepare("SELECT id, metadata FROM goals WHERE status = 'blocked' AND json_extract(metadata, '$.dependency_block') IS NOT NULL").all() as Array<{ id: string; metadata: string }>;
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
    const current = metadata.dependency_block as StoredDependencyBlock;
    if (metadata.operator_paused === true) continue; // the operator's pause owns the goal until it is resumed
    const block = goals.dependencyBlock(metadata);
    if (block && sameBlock(block, current)) continue;
    const now = new Date().toISOString();
    db.transaction(() => {
      if (!block) {
        const changed = db.prepare(`UPDATE goals SET status = ?, metadata = json_remove(metadata, '$.dependency_block'), updated_at = ?
          WHERE id = ? AND status = 'blocked' AND json_extract(metadata, '$.dependency_block.since') = ?`).run(current.previous_status, now, row.id, current.since).changes === 1;
        if (changed) record(db, row.id, 'goal_dependency_unblocked', `Goal unblocked: dependency ${current.dependency_key} satisfied`, { dependency_key: current.dependency_key, previous_reason: current.reason, blocked_since: current.since, restored_status: current.previous_status }, now);
        return;
      }
      const stored: StoredDependencyBlock = { ...block, since: now, previous_status: current.previous_status };
      const changed = db.prepare(`UPDATE goals SET metadata = json_set(metadata, '$.dependency_block', json(?)), updated_at = ?
        WHERE id = ? AND status = 'blocked' AND json_extract(metadata, '$.dependency_block.since') = ?`).run(JSON.stringify(stored), now, row.id, current.since).changes === 1;
      if (changed) record(db, row.id, 'goal_dependency_blocked', `Goal blocked: ${describe(block)}`, { ...block, previous_reason: current.reason, previous_dependency_key: current.dependency_key }, now);
    })();
  }
}
