import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';

it('C1: proof:* fixture gaps are not Commons topics — a real knowledge gap is picked instead', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const svc = new AgentCommunicationService(db);
  const gap = (id: string, subject: string, claim: string, at: string) => db.prepare(`INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
    VALUES (?, ?, 'capability', ?, 'gap', 'proposed', 0.5, '[]', 'curiosity-service', ?, ?)`).run(id, claim, subject, at, at);
  gap('real', 'retrieval', 'Knowledge gap: how should KB retrieval rank passages?', '2026-10-01T00:00:00Z');
  gap('fixture', 'proof:proof-123', 'Knowledge gap: proof fixture lacks evidence', '2026-10-04T00:00:00Z'); // newer, used to win
  expect((svc as unknown as { pickTopic(): { topicRef: string } }).pickTopic().topicRef).toBe('claim:real');
  db.close();
});
