import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Append-only authority ledger (`authority_events`): who authorised what, and what was decided. Until now no migration
 * created the table, so the Authority page returned 503 and the (optional) authority gate could never see an ALLOW.
 * Recording is best-effort and never blocks the action it describes.
 */

export interface AuthorityEventInput {
  /** Groups the lifecycle of one thing (task id, goal id). Events are sequenced per correlation. */
  correlationId: string;
  artifactId: string;
  actorSubject: string;
  actorType: 'human' | 'agent' | 'service' | 'ci';
  requestedState: string;
  decision: 'ALLOW' | 'DENY' | 'HOLD';
  previousState?: string | null;
  payload?: Record<string, unknown>;
  evidenceRefs?: string[];
  sourceSystem?: string;
}

export function recordAuthorityEvent(db: Database, input: AuthorityEventInput): string | null {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_events'").get()) return null;
    const payload = JSON.stringify(input.payload ?? {});
    const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    const insert = () => {
      const seq = ((db.prepare('SELECT MAX(sequence) AS s FROM authority_events WHERE correlation_id = ?').get(input.correlationId) as { s: number | null }).s ?? 0) + 1;
      const id = randomUUID();
      db.prepare(`INSERT INTO authority_events
        (id, event_id, correlation_id, sequence, occurred_at, actor_subject, actor_type, actor_issuer, artifact_id,
         previous_state, requested_state, policy_decision, payload_digest, payload_json, evidence_refs_json, source_system)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'djimitflo', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, id, input.correlationId, seq, new Date().toISOString(), input.actorSubject.slice(0, 200), input.actorType, input.artifactId,
          input.previousState ?? null, input.requestedState, input.decision, digest, payload, JSON.stringify(input.evidenceRefs ?? []), input.sourceSystem ?? 'djimitflo');
      return id;
    };
    try { return insert(); } catch { return insert(); } // one retry on a concurrent-sequence collision
  } catch { return null; }
}
