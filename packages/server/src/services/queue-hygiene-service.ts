import type { Database } from 'better-sqlite3';

/**
 * Gives queues an exit. Production (2026-09-20): 858 agent-board work items sat `blocked`
 * for up to 11 days with no consumer, plus 300 curiosity diagnostic claims and 100 draft
 * capabilities nobody validated. Nothing is deleted: work items become `discarded` with
 * metadata.disposition='expired', claims get valid_until (readers already honour it), and
 * stale drafts become `deprecated`.
 */

export const WORK_ITEM_TTL_DAYS: Record<string, number> = {
  'agent-board-review-loop': 14,
  'okf-synchronization-loop': 14,
  'openmythos-evolution-loop': 30,
};
const CLAIM_TTL_DAYS = 14;
const DRAFT_CAPABILITY_TTL_DAYS = 30;

export interface HygieneResult { workItemsExpired: number; claimsExpired: number; draftsDeprecated: number; goalsReaped: number; runsReaped: number }

// Zombie thresholds (prod 2026-09-22: 12 goals `running` for 9-14 days, 20 `blocked` without a wait reason, 204 `interrupted` runs).
const RUNNING_GOAL_STALE_HOURS = 24;
const BLOCKED_GOAL_STALE_DAYS = 7;
const INTERRUPTED_RUN_STALE_HOURS = 48;
const PLANNING_RUN_STALE_HOURS = 24;
const ORPHAN_RUNNING_RUN_HOURS = 6;

export function queueHygieneEnabled(): boolean {
  return process.env.QUEUE_HYGIENE_ENABLED === 'true';
}

export class QueueHygieneService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: Database) {}

  start(intervalMs = Number(process.env.QUEUE_HYGIENE_INTERVAL_MS) || 6 * 3600_000): void {
    if (this.timer || !queueHygieneEnabled()) return;
    const run = () => {
      try {
        const r = this.sweep();
        if (r.workItemsExpired || r.claimsExpired || r.draftsDeprecated || r.goalsReaped || r.runsReaped) console.log(`🧹 queue hygiene: work_items=${r.workItemsExpired} claims=${r.claimsExpired} drafts=${r.draftsDeprecated} goals=${r.goalsReaped} runs=${r.runsReaped}`);
      } catch (err) { console.warn('Queue hygiene sweep failed:', err instanceof Error ? err.message : String(err)); }
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
    setTimeout(run, 60_000).unref?.(); // first sweep shortly after boot instead of waiting a full interval
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  sweep(now = new Date()): HygieneResult {
    const iso = now.toISOString();
    const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    let workItemsExpired = 0;
    const expire = this.db.prepare(`
      UPDATE work_items
      SET status = 'discarded', metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.disposition', 'expired', '$.expired_at', ?, '$.expired_reason', ?), updated_at = ?
      WHERE recommended_loop = ? AND status IN ('candidate', 'triaged', 'blocked') AND created_at < ?
    `);
    for (const [loop, days] of Object.entries(WORK_ITEM_TTL_DAYS)) {
      workItemsExpired += expire.run(iso, `no consumer within ${days}d`, iso, loop, cutoff(days)).changes;
    }
    const claims = this.db.prepare(`
      UPDATE swarm_claims SET valid_until = ?, updated_at = ?
      WHERE created_from = 'curiosity-service' AND status IN ('proposed', 'review_required')
        AND created_at < ? AND (valid_until IS NULL OR valid_until > ?)
    `).run(iso, iso, cutoff(CLAIM_TTL_DAYS), iso).changes;
    const drafts = this.db.prepare(`
      UPDATE swarm_capabilities SET status = 'deprecated', updated_at = ?
      WHERE status = 'draft' AND owner = 'meta-evolution' AND created_at < ?
    `).run(iso, cutoff(DRAFT_CAPABILITY_TTL_DAYS)).changes;
    const zombies = this.sweepZombies(now);
    return { workItemsExpired, claimsExpired: claims, draftsDeprecated: drafts, ...zombies };
  }

  /**
   * Goals and runs nobody is working on anymore get an honest terminal status and a reason (metadata.reaped), so the
   * funnel and the daemon stop counting them as in flight. A goal that waits for an approval is never touched.
   */
  sweepZombies(now = new Date()): { goalsReaped: number; runsReaped: number } {
    const iso = now.toISOString();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const H = 3_600_000;
    const tag = (reason: string) => `json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.reaped', '${reason}', '$.reaped_at', ?)`;
    const goalsRunning = this.db.prepare(`
      UPDATE goals SET status = 'failed', metadata = ${tag('stale_running')}, updated_at = ?
      WHERE status = 'running' AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM loop_runs r WHERE r.goal_id = goals.id AND r.status IN ('running', 'planning', 'verifying') AND r.updated_at >= ?)
    `).run(iso, iso, ago(RUNNING_GOAL_STALE_HOURS * H), ago(RUNNING_GOAL_STALE_HOURS * H)).changes;
    const goalsBlocked = this.db.prepare(`
      UPDATE goals SET status = 'cancelled', metadata = ${tag('stale_blocked')}, updated_at = ?
      WHERE status = 'blocked' AND updated_at < ? AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.awaiting_approval') IS NULL
    `).run(iso, iso, ago(BLOCKED_GOAL_STALE_DAYS * 24 * H)).changes;
    // A proposal whose goal was reaped goes back to the parked pool instead of staying `executing` forever.
    this.db.prepare(`
      UPDATE self_improvements SET status = 'needs_more_evidence', updated_at = ?
      WHERE status = 'executing' AND id IN (SELECT improvement_id FROM goals WHERE improvement_id IS NOT NULL AND status IN ('failed', 'cancelled')
        AND json_extract(COALESCE(NULLIF(metadata, ''), '{}'), '$.reaped_at') = ?)
    `).run(iso, iso);
    const runsInterrupted = this.db.prepare(`
      UPDATE loop_runs SET status = 'cancelled', metadata = ${tag('stale_interrupted')}, updated_at = ?
      WHERE status = 'interrupted' AND updated_at < ?
    `).run(iso, iso, ago(INTERRUPTED_RUN_STALE_HOURS * H)).changes;
    const runsPlanning = this.db.prepare(`
      UPDATE loop_runs SET status = 'failed', metadata = ${tag('stale_planning')}, updated_at = ?
      WHERE status = 'planning' AND updated_at < ?
    `).run(iso, iso, ago(PLANNING_RUN_STALE_HOURS * H)).changes;
    // A 'running' run whose workers are all finished (none prepared/running) is orphaned — e.g. its leases were cancelled
    // (prod 2026-09-24: 3978a793 stayed 'running' 10 h after both leases were cancelled). A run waiting for an approval
    // still has a prepared lease, so it is never touched.
    const runsOrphaned = this.db.prepare(`
      UPDATE loop_runs SET status = 'cancelled', metadata = ${tag('orphan_running')}, updated_at = ?
      WHERE status = 'running' AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.loop_run_id = loop_runs.id AND l.status IN ('prepared', 'running'))
    `).run(iso, iso, ago(ORPHAN_RUNNING_RUN_HOURS * H)).changes;
    // A run whose goal already ended (e.g. its approval expired: the daemon fails the goal and re-schedules the proposal)
    // keeps its prepared leases, so the orphan rule above never sees it. Prod 2026-09-25: 84bc044b/4c11f3f5 stayed 'running'.
    const goalEnded = `status = 'running' AND updated_at < ? AND goal_id IN (SELECT id FROM goals WHERE status IN ('failed', 'cancelled', 'completed'))`;
    this.db.prepare(`UPDATE worker_leases SET status = 'cancelled', updated_at = ? WHERE status = 'prepared' AND loop_run_id IN (SELECT id FROM loop_runs WHERE ${goalEnded})`)
      .run(iso, ago(H));
    const runsOfEndedGoals = this.db.prepare(`UPDATE loop_runs SET status = 'cancelled', metadata = ${tag('goal_ended')}, updated_at = ? WHERE ${goalEnded}`)
      .run(iso, iso, ago(H)).changes;
    return { goalsReaped: goalsRunning + goalsBlocked, runsReaped: runsInterrupted + runsPlanning + runsOrphaned + runsOfEndedGoals };
  }
}
