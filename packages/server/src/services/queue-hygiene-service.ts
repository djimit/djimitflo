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

export interface HygieneResult { workItemsExpired: number; claimsExpired: number; draftsDeprecated: number }

export function queueHygieneEnabled(): boolean {
  return process.env.QUEUE_HYGIENE_ENABLED === 'true';
}

export class QueueHygieneService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: Database) {}

  start(intervalMs = Number(process.env.QUEUE_HYGIENE_INTERVAL_MS) || 6 * 3600_000): void {
    if (this.timer || !queueHygieneEnabled()) return;
    this.timer = setInterval(() => {
      try {
        const r = this.sweep();
        if (r.workItemsExpired || r.claimsExpired || r.draftsDeprecated) console.log(`🧹 queue hygiene: work_items=${r.workItemsExpired} claims=${r.claimsExpired} drafts=${r.draftsDeprecated}`);
      } catch (err) { console.warn('Queue hygiene sweep failed:', err instanceof Error ? err.message : String(err)); }
    }, intervalMs);
    this.timer.unref?.();
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
    return { workItemsExpired, claimsExpired: claims, draftsDeprecated: drafts };
  }
}
