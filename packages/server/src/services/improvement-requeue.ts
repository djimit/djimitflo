import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { addDimColumn, checkProposalDuplicate, proposalDedupeEnabled } from './proposal-dedupe';
import { assertionStrengthVerdict } from './test-assertion-strength';

/**
 * D2 (operator 2026-09-28): requeue = a NEW attempt linked to the original, never a mutation of it.
 * - only for a proposal that ended without a verdict worth keeping (regressed / infra_failed / no_change), or one the
 *   pre-screen parked before the panel (D5: needs_more_evidence with a `prescreen_park` judgment) — the operator overrides it
 * - or a `verified` test-gap / mutation-gap proposal whose latest maker run carries no runtime `test:assertion-strength` verdict (its maker ran
 *   before #730): eligibility `assertion_verdict_missing`. An offline `assertion_strength_retroactive` judgment is not a
 *   runtime verdict and is ignored here; a verified proposal with a runtime verdict (any value) stays refused
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
  // only the lanes the check runs on (assertionStrengthCheck: test-gap / mutation-gap refs) — elsewhere no verdict is ever recorded
  const verdictMissing = original.status === 'verified' && /"(?:test|mutation)-gap:/.test(String(original.evidence_refs_json ?? ''))
    && latestMakerHasNoAssertionVerdict(db, originalId);
  if (!REQUEUEABLE.includes(String(original.status)) && !prescreenParked && !verdictMissing) throw new Error('REQUEUE_STATUS_NOT_ALLOWED');
  const eligibility = verdictMissing ? 'assertion_verdict_missing' : null;
  const escalated = db.prepare(`SELECT 1 FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = ? AND r.status = 'escalated' LIMIT 1`).get(originalId);
  if (escalated && !input.approveEscalation) throw new Error('REQUEUE_ESCALATED_NEEDS_APPROVAL');
  const refs = JSON.parse(String(original.evidence_refs_json || '[]')) as string[];
  if (!requeueBudgetAllows(db, refs, env)) throw new Error('REQUEUE_BUDGET_EXHAUSTED');
  const id = randomUUID(); const now = new Date().toISOString();
  const copy: Record<string, unknown> = {
    ...original, id, status: 'scheduled', approved_by: actor, fingerprint: null, created_at: now, updated_at: now,
    evidence_refs_json: JSON.stringify([...refs, link, `requeue-by:${actor}`, `requeue-reason:${reason.slice(0, 200)}`,
      ...(eligibility ? [`requeue-eligibility:${eligibility}`] : [])]),
  };
  const cols = Object.keys(copy);
  db.transaction(() => {
    db.prepare(`INSERT INTO self_improvements (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => copy[c] as never));
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
      VALUES (?, 'requeue', 'self_improvement', ?, ?, 'enforce', 'yes', ?, ?)`)
      .run(randomUUID(), originalId, id.slice(0, 16), `requeued as ${id} by ${actor}${escalated ? ' (escalation approved)' : ''}${eligibility ? ` [${eligibility}]` : ''}: ${reason.slice(0, 300)}`, now);
  })();
  // ACE-001 delivery (prod 11-10: all 13 requeued oracle proposals had no vector → every treated arm fell back to control):
  // the copy has the original's text, so it inherits the original's vector; no network on this path
  if (!copyEmbedding(db, originalId, id, now) && proposalDedupeEnabled(env)) {
    void checkProposalDuplicate(db, { id, title: String(original.title ?? ''), description: String(original.description ?? '') }).catch(() => null);
  }
  return { id, created: true };
}

/** The lane budget a requeue counts against: a test-gap copy carries its `test-gap:` ref, so the lane's daily cap sees it. */
export function requeueBudgetAllows(db: Database, refs: string[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  if (!refs.some((r) => r.startsWith('test-gap:'))) return true;
  const day = new Date(now - 86_400_000).toISOString();
  const createdToday = (db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%test-gap:%' AND created_at >= ?").get(day) as { n: number }).n;
  return createdToday < (Number(env.TEST_GAP_MAX_PER_DAY) || 2);
}

/** True when the original has a completed, non-superseded maker lease and the latest one recorded no assertion-strength check. */
function latestMakerHasNoAssertionVerdict(db: Database, improvementId: string): boolean {
  const maker = db.prepare(`SELECT json_extract(l.metadata, '$.deterministic_checks') AS checks FROM worker_leases l
    JOIN loop_runs r ON r.id = l.loop_run_id JOIN goals g ON g.id = r.goal_id
    WHERE g.improvement_id = ? AND l.role = 'maker' AND l.status = 'completed' AND json_extract(l.metadata, '$.superseded_by_maker_lease_id') IS NULL
    ORDER BY l.updated_at DESC, l.rowid DESC LIMIT 1`).get(improvementId) as { checks: string | null } | undefined;
  if (!maker) return false;
  let checks: unknown = [];
  try { checks = JSON.parse(maker.checks || '[]'); } catch { /* unparseable = no recorded check */ }
  return assertionStrengthVerdict(checks) === null;
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
