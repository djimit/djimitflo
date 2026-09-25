import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { CommonsProposalReviewService } from '../services/commons-proposal-review-service';
import { SelfImprovementService } from '../services/self-improvement-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';

describe('CommonsProposalReviewService', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  let svc: CommonsProposalReviewService;
  const memCreate = vi.fn((_: unknown) => ({}));
  const prev = process.env.COMMONS_PROPOSAL_REVIEW_ENABLED;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    comms = new AgentCommunicationService(db);
    svc = new CommonsProposalReviewService(db, { memory: { create: memCreate as never } });
    process.env.COMMONS_PROPOSAL_REVIEW_ENABLED = 'true';
    memCreate.mockClear();
  });
  afterEach(() => { db?.close(); if (prev === undefined) delete process.env.COMMONS_PROPOSAL_REVIEW_ENABLED; else process.env.COMMONS_PROPOSAL_REVIEW_ENABLED = prev; });

  function seedParked(title = 'Add retry backoff') {
    const [p] = [new SelfImprovementService(db).createProposal({ type: 'feature', title, description: 'desc', rationale: 'why', source: 'gap_analysis', priority: 0.5 })];
    db.prepare("UPDATE self_improvements SET status = 'needs_more_evidence' WHERE id = ?").run(p.id);
    return p.id;
  }
  function reply(from: string, threadId: string) {
    comms.send({ from, to: 'commons-scout', type: 'result', action: 'social.response', threadId, epistemicRole: 'proposal', evidence: ['x'], ttl: 86_400,
      params: { answer: `${from} says ok`, falsifiable_next_step: 'measure', creative_alternative: 'alt', stop_condition: 'stop' } });
  }

  it('posts one open review at a time, to three reviewers, and dedupes', () => {
    const a = seedParked('A'); seedParked('B');
    expect(svc.tick().posted).toBe(1);
    expect(svc.tick().posted).toBe(0); // one still open
    const n = (db.prepare("SELECT COUNT(*) n FROM agent_messages WHERE json_extract(payload_json,'$.params.topic_ref') = ?").get(`improvement:${a}`) as { n: number }).n;
    expect(n).toBe(3);
  });

  it('completes when all reviewers replied and exposes the summary', () => {
    const id = seedParked();
    svc.tick();
    const thread = (db.prepare('SELECT thread_id FROM commons_proposal_reviews WHERE improvement_id = ?').get(id) as { thread_id: string }).thread_id;
    for (const r of ['commons-muse', 'commons-archivist', 'commons-oracle']) reply(r, thread);
    expect(svc.tick().collected).toBe(1);
    expect(svc.getReviewSummary(id)).toContain('commons-oracle says ok');
  });

  it('times out with partial replies', () => {
    const id = seedParked();
    svc.tick();
    expect(svc.tick(Date.now() + 3 * 3600_000).timedOut).toBe(1);
    expect(svc.getReviewSummary(id)).toBeNull(); // timed out with no replies: nothing to feed the refiner
  });

  it('refinement eligibility waits for the review when enabled, and ignores it when disabled', () => {
    const id = seedParked();
    const imp = new SelfImprovementService(db);
    expect(imp.getRefinementEligible(5)).toHaveLength(0);
    svc.tick(); svc.tick(Date.now() + 3 * 3600_000);
    expect(imp.getRefinementEligible(5).map(p => p.id)).toEqual([id]);
    delete process.env.COMMONS_PROPOSAL_REVIEW_ENABLED;
    expect(seedParked('C')).toBeTruthy();
    expect(imp.getRefinementEligible(5)).toHaveLength(2);
  });

  it('failed goal un-sticks the proposal and writes an episodic memory candidate', () => {
    const id = seedParked();
    db.prepare("UPDATE self_improvements SET status = 'executing' WHERE id = ?").run(id);
    db.prepare("INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at) VALUES ('g1','o','failed','low','[]','{}',?, '{}', datetime('now'), datetime('now'))").run(id);
    svc.recordGoalOutcome('g1', 'failed', 'boom');
    expect((db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(id) as { status: string }).status).toBe('needs_more_evidence');
    expect(memCreate).toHaveBeenCalledTimes(1);
    expect((memCreate.mock.calls[0][0] as { memory_type: string }).memory_type).toBe('operational_memory');
  });

  it('completed reviewed goal writes a procedural candidate; unreviewed writes none', () => {
    const id = seedParked();
    db.prepare("INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at) VALUES ('g1','o','completed','low','[]','{}',?, '{}', datetime('now'), datetime('now'))").run(id);
    svc.recordGoalOutcome('g1', 'completed', 'ok');
    expect(memCreate).not.toHaveBeenCalled();
    db.prepare("INSERT INTO commons_proposal_reviews (improvement_id, thread_id, status, summary, posted_at) VALUES (?, 't', 'completed', '- guidance', datetime('now'))").run(id);
    svc.recordGoalOutcome('g1', 'completed', 'ok');
    expect((memCreate.mock.calls[0][0] as { store: string }).store).toBe('procedural');
  });

  it('infrastructure failures re-schedule the proposal (bounded) and a new goal is created', () => {
    const id = seedParked();
    const goal = (gid: string) => db.prepare("INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, improvement_id, metadata, created_at, updated_at) VALUES (?,'o','failed','low','[]','{}',?, json_object('improvement_id', ?), datetime('now'), datetime('now'))").run(gid, id, id);
    const status = () => (db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(id) as { status: string }).status;
    db.prepare("UPDATE self_improvements SET status = 'executing' WHERE id = ?").run(id);
    goal('g1');
    svc.recordGoalOutcome('g1', 'failed', "WORKTREE_CREATE_FAILED: fatal: cannot lock ref 'refs/heads/agent/loop/x'");
    expect(status()).toBe('scheduled');
    expect(new AutonomousGoalGenerator(db).generateImprovement(id)).toBe(1); // the failed goal does not block the retry
    expect(status()).toBe('executing');
    db.prepare("DELETE FROM goals WHERE improvement_id = ? AND status = 'created'").run(id); // stand-in for the retry goal failing
    goal('g2'); svc.recordGoalOutcome('g2', 'failed', 'approval expired');
    expect(status()).toBe('scheduled');
    db.prepare("UPDATE self_improvements SET status = 'executing' WHERE id = ?").run(id);
    goal('g3'); svc.recordGoalOutcome('g3', 'failed', 'approval expired');
    expect(status()).toBe('needs_more_evidence'); // retry budget spent
  });
});
