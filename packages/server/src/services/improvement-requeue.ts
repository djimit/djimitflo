import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { addDimColumn, checkProposalDuplicate, proposalDedupeEnabled } from './proposal-dedupe';

/**
 * D2 (operator 2026-09-28): requeue = a NEW attempt linked to the original, never a mutation of it.
 * - only for a proposal that ended without a verdict worth keeping (regressed / infra_failed / no_change), or one the
 *   pre-screen parked before the panel (D5: needs_more_evidence with a `prescreen_park` judgment) — the operator overrides it
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
  const prescreenParked = original.status === 'needs_more_evidence'
    && !!db.prepare("SELECT 1 FROM judgments WHERE judgment = 'prescreen_park' AND subject_id = ? LIMIT 1").get(originalId);
  if (!REQUEUEABLE.includes(String(original.status)) && !prescreenParked) throw new Error('REQUEUE_STATUS_NOT_ALLOWED');
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
  // ACE-001 delivery (prod 11-10: all 13 requeued oracle proposals had no vector → every treated arm fell back to control):
  // the copy has the original's text, so it inherits the original's vector; no network on this path
  if (!copyEmbedding(db, originalId, id, now) && proposalDedupeEnabled(env)) {
    void checkProposalDuplicate(db, { id, title: String(original.title ?? ''), description: String(original.description ?? '') }).catch(() => null);
  }
  return { id, created: true };
}

/** Copies the original proposal's stored embedding to its requeued copy; false when the original has none. */
export function copyEmbedding(db: Database, fromId: string, toId: string, now = new Date().toISOString()): boolean {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
    addDimColumn(db, 'proposal_embeddings');
    return db.prepare(`INSERT OR IGNORE INTO proposal_embeddings (proposal_id, model, vector, created_at, embedding_dim)
      SELECT ?, model, vector, ?, embedding_dim FROM proposal_embeddings WHERE proposal_id = ?`).run(toId, now, fromId).changes > 0;
  } catch { return false; }
}
