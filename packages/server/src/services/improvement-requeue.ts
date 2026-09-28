import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * D2 (operator 2026-09-28): requeue = a NEW attempt linked to the original, never a mutation of it.
 * - only for a proposal that ended without a verdict worth keeping (regressed / infra_failed / no_change)
 * - idempotent per original: a second requeue returns the first copy
 * - counts against the lane budget: a test-gap copy carries its `test-gap:` ref, so the lane's daily cap sees it;
 *   refused when that cap is already reached
 * - refused while a run of the original is `escalated`, unless the operator explicitly approves the escalation
 * - records who requeued and why: evidence refs on the copy and a `requeue` judgment on the original
 */
export interface RequeueInput { actor: string; reason: string; approveEscalation?: boolean }
export type RequeueResult = { id: string; created: boolean };

const REQUEUEABLE = ['regressed', 'infra_failed', 'no_change'];

export function requeueImprovement(db: Database, originalId: string, input: RequeueInput, env: NodeJS.ProcessEnv = process.env): RequeueResult {
  const actor = input.actor.trim(); const reason = input.reason.trim();
  if (!actor) throw new Error('REQUEUE_ACTOR_REQUIRED');
  if (reason.length < 5) throw new Error('REQUEUE_REASON_REQUIRED');
  const original = db.prepare('SELECT * FROM self_improvements WHERE id = ?').get(originalId) as Record<string, unknown> | undefined;
  if (!original) throw new Error('REQUEUE_NOT_FOUND');
  const link = `requeue-of:${originalId}`;
  const existing = db.prepare('SELECT id FROM self_improvements WHERE evidence_refs_json LIKE ? LIMIT 1').get(`%"${link}"%`) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  if (!REQUEUEABLE.includes(String(original.status))) throw new Error('REQUEUE_STATUS_NOT_ALLOWED');
  const escalated = db.prepare(`SELECT 1 FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = ? AND r.status = 'escalated' LIMIT 1`).get(originalId);
  if (escalated && !input.approveEscalation) throw new Error('REQUEUE_ESCALATED_NEEDS_APPROVAL');
  const refs = JSON.parse(String(original.evidence_refs_json || '[]')) as string[];
  if (refs.some((r) => r.startsWith('test-gap:'))) {
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const createdToday = (db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%test-gap:%' AND created_at >= ?").get(day) as { n: number }).n;
    if (createdToday >= (Number(env.TEST_GAP_MAX_PER_DAY) || 2)) throw new Error('REQUEUE_BUDGET_EXHAUSTED');
  }
  const id = randomUUID(); const now = new Date().toISOString();
  const copy: Record<string, unknown> = {
    ...original, id, status: 'scheduled', approved_by: actor, fingerprint: null, created_at: now, updated_at: now,
    evidence_refs_json: JSON.stringify([...refs, link, `requeue-by:${actor}`, `requeue-reason:${reason.slice(0, 200)}`]),
  };
  const cols = Object.keys(copy);
  db.transaction(() => {
    db.prepare(`INSERT INTO self_improvements (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => copy[c] as never));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
      VALUES (?, 'requeue', 'self_improvement', ?, ?, 'enforce', 'yes', ?, ?)`)
      .run(randomUUID(), originalId, id.slice(0, 16), `requeued as ${id} by ${actor}${escalated ? ' (escalation approved)' : ''}: ${reason.slice(0, 300)}`, now);
  })();
  return { id, created: true };
}
