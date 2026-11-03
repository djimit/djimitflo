import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { QueueHygieneService } from '../services/queue-hygiene-service';
import { MetaEvolutionService } from '../services/meta-evolution-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('QueueHygieneService', () => {
  const workItem = (id: string, loop: string, status: string, age: number) => db.prepare(
    "INSERT INTO work_items (id, title, description, source, risk_class, status, recommended_loop, metadata, created_at, updated_at) VALUES (?, 't', 'd', 'agent_board', 'low', ?, ?, '{}', ?, ?)"
  ).run(id, status, loop, daysAgo(age), daysAgo(age));
  const status = (id: string) => (db.prepare('SELECT status, metadata FROM work_items WHERE id = ?').get(id) as { status: string; metadata: string });

  it('expires only consumer-less work items past their TTL, keeping a disposition', () => {
    workItem('old-board', 'agent-board-review-loop', 'blocked', 20);
    workItem('fresh-board', 'agent-board-review-loop', 'blocked', 3);
    workItem('old-research', 'research-loop', 'candidate', 60); // no TTL configured for this loop
    workItem('old-done', 'agent-board-review-loop', 'done', 60);
    const result = new QueueHygieneService(db).sweep();
    expect(result.workItemsExpired).toBe(1);
    expect(status('old-board').status).toBe('discarded');
    expect(JSON.parse(status('old-board').metadata).disposition).toBe('expired');
    expect(status('fresh-board').status).toBe('blocked');
    expect(status('old-research').status).toBe('candidate');
    expect(status('old-done').status).toBe('done');
    expect(new QueueHygieneService(db).sweep().workItemsExpired).toBe(0); // idempotent
  });

  it('expires stale curiosity claims via valid_until and deprecates stale meta-evolution drafts only', () => {
    const claim = (id: string, from: string, age: number) => db.prepare(
      "INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, status, confidence, evidence_refs_json, created_from, created_at, updated_at) VALUES (?, 'c', 'capability', 's', 'proposed', 0.5, '[]', ?, ?, ?)"
    ).run(id, from, daysAgo(age), daysAgo(age));
    claim('old-cur', 'curiosity-service', 20); claim('new-cur', 'curiosity-service', 2); claim('old-other', 'g5_handoff', 20);
    const cap = (id: string, owner: string, age: number) => db.prepare(
      "INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES (?, 'deterministic_harness', ?, '0.1.0', 'draft', 'low', 'none', 'none', '[]', '[]', '[]', 0, 0.5, '{}', 'x', '{}', ?, ?)"
    ).run(id, owner, daysAgo(age), daysAgo(age));
    cap('old-draft', 'meta-evolution', 40); cap('new-draft', 'meta-evolution', 5); cap('other-draft', 'someone', 40);
    const r = new QueueHygieneService(db).sweep();
    expect(r).toMatchObject({ claimsExpired: 1, draftsDeprecated: 1 });
    const validUntil = (id: string) => (db.prepare('SELECT valid_until v FROM swarm_claims WHERE id = ?').get(id) as { v: string | null }).v;
    expect([validUntil('old-cur') !== null, validUntil('new-cur'), validUntil('old-other')]).toEqual([true, null, null]);
    const capStatus = (id: string) => (db.prepare('SELECT status FROM swarm_capabilities WHERE id = ?').get(id) as { status: string }).status;
    expect([capStatus('old-draft'), capStatus('new-draft'), capStatus('other-draft')]).toEqual(['deprecated', 'draft', 'draft']);
  });
});

describe('meta-evolution draft synthesis', () => {
  const gapClaim = (id: string, subject: string, from: string) => db.prepare(
    "INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at) VALUES (?, 'gap', 'capability', ?, 'gap', 'proposed', 0.5, '[]', ?, datetime('now'), datetime('now'))"
  ).run(id, subject, from);
  const drafts = () => (db.prepare("SELECT COUNT(*) c FROM swarm_capabilities WHERE owner = 'meta-evolution'").get() as { c: number }).c;

  it("ignores the curiosity scanner's own diagnostic claims and caps open drafts", () => {
    const meta = new MetaEvolutionService(db, new SwarmIntelligenceService(db), { intervalMs: 999999999 });
    for (let i = 0; i < 3; i++) gapClaim(`cur-${i}`, 'noise-domain', 'curiosity-service');
    meta.evaluate();
    expect(drafts()).toBe(0);

    process.env.META_EVOLUTION_MAX_OPEN_DRAFTS = '2';
    try {
      for (const subject of ['a', 'b', 'c', 'd']) for (let i = 0; i < 3; i++) gapClaim(`real-${subject}-${i}`, subject, 'g5_handoff');
      meta.evaluate();
      expect(drafts()).toBe(2);
    } finally { delete process.env.META_EVOLUTION_MAX_OPEN_DRAFTS; }
  });
});

it('N13: proposals parked for grounding or evidence longer than 14 days are archived with the reason; others untouched', () => {
  const si = (id: string, status: string, age: number) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'feature', 't', 'd', 'r', 'reflection', ?, 0.5, '["reflection:x"]', ?, ?)`).run(id, status, daysAgo(age), daysAgo(0));
  si('old-ng', 'needs_grounding', 15); si('old-nme', 'needs_more_evidence', 20); si('fresh-ng', 'needs_grounding', 13); si('old-verified', 'verified', 30);
  expect(new QueueHygieneService(db).sweep().proposalsArchived).toBe(2);
  const row = (id: string) => db.prepare('SELECT status, evidence_refs_json AS refs FROM self_improvements WHERE id = ?').get(id) as { status: string; refs: string };
  expect(row('old-ng')).toEqual({ status: 'archived', refs: '["reflection:x","hygiene:parked_14d"]' });
  expect(row('old-nme').status).toBe('archived');
  expect([row('fresh-ng').status, row('old-verified').status]).toEqual(['needs_grounding', 'verified']);
});
