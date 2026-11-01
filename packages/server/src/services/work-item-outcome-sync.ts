import type { Database } from 'better-sqlite3';
import { enqueueRequiredEvent } from './event-outbox-service';
import { LoopEventService } from './loop-event-service';
import { WorkItemService } from './work-item-service';

/**
 * PRC-3: a goal that came from a work item (goals.metadata.source_work_item_id, set by WorkItemService.convertToGoal)
 * reports its terminal outcome back to that item. WORK_ITEM_OUTCOME_SYNC: off (default) | shadow (loop event
 * `work_item_outcome_shadow`, nothing written) | on: completed → `done`, failed → `blocked`, metadata.loop_outcome =
 * {outcome, run_id, pr_url, at}, and a required `djimitflo.work_item.updated` outbox row in the same transaction.
 * Through WorkItemService.update, so every work-item rule holds (agent_board items, a security finding closed without
 * evidence: refused and recorded as `work_item_outcome_failed`, never thrown). A done/discarded item is never reopened;
 * an item already carrying this run's outcome is left alone (two daemon passes write once).
 */
export type WorkItemOutcomeSyncMode = 'off' | 'shadow' | 'on';
export function workItemOutcomeSyncMode(env: NodeJS.ProcessEnv = process.env): WorkItemOutcomeSyncMode {
  const v = env.WORK_ITEM_OUTCOME_SYNC; return v === 'shadow' || v === 'on' ? v : 'off';
}

function goalMeta(db: Database, goalId: string | null): Record<string, unknown> {
  if (!goalId) return {};
  try { return JSON.parse((db.prepare('SELECT metadata FROM goals WHERE id = ?').get(goalId) as { metadata: string | null } | undefined)?.metadata || '{}') as Record<string, unknown>; } catch { return {}; }
}

export function syncWorkItemOutcome(db: Database, goalId: string, outcome: 'completed' | 'failed', runId: string | null, env: NodeJS.ProcessEnv = process.env): 'updated' | 'shadow' | 'skipped' | 'failed' {
  const mode = workItemOutcomeSyncMode(env);
  if (mode === 'off') return 'skipped';
  const itemId = goalMeta(db, goalId).source_work_item_id;
  if (typeof itemId !== 'string' || !itemId) return 'skipped';
  const note = (type: string, level: 'info' | 'warning', message: string, meta: Record<string, unknown>) => {
    if (runId) { try { new LoopEventService(db).recordEvent(runId, type, level, message, meta); } catch { /* best-effort */ } }
  };
  try {
    const svc = new WorkItemService(db);
    const item = svc.get(itemId);
    if ((item.parent_goal_id && item.parent_goal_id !== goalId) || item.status === 'done' || item.status === 'discarded') return 'skipped';
    const status = outcome === 'completed' ? 'done' : 'blocked';
    const prev = item.metadata.loop_outcome as { run_id?: unknown; outcome?: unknown } | undefined;
    if (item.status === status && prev?.run_id === runId && prev?.outcome === outcome) return 'skipped';
    let prUrl: string | null = null;
    if (runId) { try { prUrl = (db.prepare("SELECT json_extract(metadata, '$.pr_url') AS u FROM loop_runs WHERE id = ? AND json_valid(metadata)").get(runId) as { u: string | null } | undefined)?.u ?? null; } catch { /* unknown: null */ } }
    const record = { outcome, run_id: runId, pr_url: prUrl, at: new Date().toISOString() };
    if (mode === 'shadow') {
      note('work_item_outcome_shadow', 'info', `would set work item ${itemId} to ${status}`, { work_item_id: itemId, status, ...record });
      return 'shadow';
    }
    db.transaction(() => {
      svc.update(itemId, { status, metadata: { ...item.metadata, loop_outcome: record } });
      enqueueRequiredEvent(db, { type: 'djimitflo.work_item.updated', aggregateId: itemId, payload: { work_item_id: itemId, status, goal_id: goalId, ...record } });
    })();
    return 'updated';
  } catch (error) {
    note('work_item_outcome_failed', 'warning', `work item ${itemId} not updated: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), { work_item_id: itemId, outcome });
    return 'failed';
  }
}

/** `\n\nRefs owner/repo#N` for a draft PR whose goal came from a GitHub-issue work item (WORK_ITEM_OUTCOME_SYNC=on); '' otherwise. */
export function issueRefsLine(db: Database, goalId: string | null, env: NodeJS.ProcessEnv = process.env): string {
  if (workItemOutcomeSyncMode(env) !== 'on') return '';
  const meta = goalMeta(db, goalId);
  const ref = meta.source_ref;
  return meta.source === 'github_issue' && typeof ref === 'string' && /^[\w.-]+\/[\w.-]+#\d+$/.test(ref) ? `\n\nRefs ${ref}` : '';
}
