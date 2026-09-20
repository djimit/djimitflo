import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const panels = new SpecialistPanelService(db);
  const panel = panels.createPanel({
    topic: 'Test proposal',
    question: 'Should this be authorized as a goal?',
    risk_class: 'high',
    specialist_ids: ['systems_architect', 'security_reviewer'],
    metadata: { self_improvement_id: 'fixture-improvement' },
    context: { description: 'Add a flag to disable X', rationale: 'Reduces surprise for operators' },
  });
  return { db, panels, panel };
}

describe('SelfImprovementAgentReviewService', () => {
  it('submits a genuine oppose stance through, rather than forcing support', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () =>
      JSON.stringify({ stance: 'oppose', confidence: 0.7, findings: ['No rollback plan'], evidence_refs: ['context:rationale'] }),
    );
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(updated.consensus.oppose_count).toBeGreaterThan(0);
  });

  it('uses a distinct reviewer_actor per specialist role', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () =>
      JSON.stringify({ stance: 'support', confidence: 0.85, findings: ['ok'], evidence_refs: ['context:rationale'] }),
    );
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-42');
    const actors = (updated.reviews || []).map((review) => review.reviewer_actor);
    expect(new Set(actors).size).toBe(actors.length);
    expect(actors.every((actor) => actor?.includes('run-42'))).toBe(true);
  });

  it('falls back to needs_evidence on an unparseable model response, without fabricating evidence', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () => 'not json at all');
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(updated.consensus.needs_evidence_count).toBe(2);
    for (const review of updated.reviews || []) {
      expect(review.evidence_refs).toContain('agent-review:model-response-unparseable-or-missing-evidence');
    }
  });

  it('downgrades a claimed-support response with no evidence_refs to needs_evidence', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () =>
      JSON.stringify({ stance: 'support', confidence: 0.95, findings: ['looks fine'], evidence_refs: [] }),
    );
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(updated.consensus.support_count).toBe(0);
    expect(updated.consensus.needs_evidence_count).toBe(2);
  });

  it('extracts JSON from a markdown-fenced response', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () =>
      '```json\n' + JSON.stringify({ stance: 'support', confidence: 0.9, evidence_refs: ['context:rationale'] }) + '\n```',
    );
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(updated.consensus.support_count).toBe(2);
  });

  it('a permanently throwing model call does not leave the specialist unreviewed forever (bounded retries, then the recorded failure)', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () => { throw new Error('network down'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-3');
    expect(updated.consensus.submitted_reviews).toBe(2);
    expect(updated.consensus.needs_evidence_count).toBe(2);
  });

  it('only reviews specialists that have not already been reviewed', async () => {
    const { db, panels, panel } = setup();
    panels.submitReview(panel.id, {
      specialist_id: 'systems_architect', stance: 'support', confidence: 0.9, evidence_refs: ['human:1'],
    }, 'human-reviewer');
    let calls = 0;
    const reviewer = new SelfImprovementAgentReviewService(db, async () => {
      calls += 1;
      return JSON.stringify({ stance: 'support', confidence: 0.9, evidence_refs: ['context:rationale'] });
    });
    await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(calls).toBe(1);
  });

  it('does not record a failed model call as a review: the seat stays open for a retry, then falls back after 3 attempts', async () => {
    const { db, panel } = setup();
    let calls = 0;
    const reviewer = new SelfImprovementAgentReviewService(db, async () => { calls++; throw new Error('fetch failed'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(first.reviews ?? []).toHaveLength(0);
    expect(first.status).not.toBe('consensus_ready');
    await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
    const third = await reviewer.reviewMissingSpecialists(panel.id, 'run-3');
    expect((third.reviews ?? []).length).toBe(2); // bounded: now the recorded failure is used
    expect(third.reviews?.[0].findings.join()).toContain('Review generation failed: fetch failed');
    expect(calls).toBe(6);
    warn.mockRestore();
  });

  it('a later successful call fills the open seat with a real review', async () => {
    const { db, panel } = setup();
    let ok = false;
    const reviewer = new SelfImprovementAgentReviewService(db, async () => {
      if (!ok) throw new Error('Ollama request failed: 404');
      return JSON.stringify({ stance: 'support', confidence: 0.9, findings: ['sound'], evidence_refs: ['context:rationale'] });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await reviewer.reviewMissingSpecialists(panel.id, 'run-1')).reviews ?? []).toHaveLength(0);
    ok = true;
    const done = await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
    expect(done.consensus.support_count).toBe(2);
  });
});
