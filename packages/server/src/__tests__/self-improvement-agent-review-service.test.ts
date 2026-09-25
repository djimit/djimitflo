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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // an unreadable answer is retried like a failed call; only after 3 attempts is it recorded
    expect((await reviewer.reviewMissingSpecialists(panel.id, 'run-1')).reviews ?? []).toHaveLength(0);
    await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-3');
    expect(updated.consensus.needs_evidence_count).toBe(2);
    for (const review of updated.reviews || []) {
      expect(review.evidence_refs).toContain('agent-review:model-response-unparseable-or-missing-evidence');
    }
  });

  it('a garbled answer followed by a readable one yields the real review (prod 2026-09-25)', async () => {
    const { db, panel } = setup();
    let n = 0;
    const reviewer = new SelfImprovementAgentReviewService(db, async () => (n++ < 2 ? 'garbled {'
      : JSON.stringify({ stance: 'support', confidence: 0.9, findings: ['ok'], evidence_refs: ['context:rationale'] })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect((await reviewer.reviewMissingSpecialists(panel.id, 'run-2')).consensus.support_count).toBe(2);
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

  it('ignores a <think> block with braces before the JSON answer', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () =>
      `<think>maybe {"stance": "oppose"} ... no</think>\n${JSON.stringify({ stance: 'support', confidence: 0.9, findings: ['ok'], evidence_refs: ['context:rationale'] })}`);
    const updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(updated.consensus.support_count).toBe(2);
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
    const reviewer = new SelfImprovementAgentReviewService(db, async () => { calls++; throw new Error('Ollama request failed: 404'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(first.reviews ?? []).toHaveLength(0);
    expect(first.status).not.toBe('consensus_ready');
    await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
    const third = await reviewer.reviewMissingSpecialists(panel.id, 'run-3');
    expect((third.reviews ?? []).length).toBe(2); // bounded: now the recorded failure is used
    expect(third.reviews?.[0].findings.join()).toContain('Review generation failed: Ollama request failed: 404');
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

  it('an unreachable model host never spends attempts: no review is recorded however long the outage lasts', async () => {
    const { db, panel } = setup();
    const reviewer = new SelfImprovementAgentReviewService(db, async () => { throw new Error('fetch failed'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let updated = await reviewer.reviewMissingSpecialists(panel.id, 'run-0');
    for (let i = 1; i <= 6; i++) updated = await reviewer.reviewMissingSpecialists(panel.id, `run-${i}`);
    expect(updated.reviews ?? []).toHaveLength(0);
    expect(updated.status).not.toBe('consensus_ready');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTargetExcerpt } from '../services/self-improvement-agent-review-service';

describe('grounded proposals carry an excerpt of their target', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  fs.mkdirSync(path.join(repo, 'packages/x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages/x/a.ts'), 'export const a = 1; // token: hunter2secret\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');

  it('reads a repo-relative target, scrubs secrets, and refuses traversal, absolute and sensitive paths', () => {
    const excerpt = readTargetExcerpt('packages/x/a.ts', repo) as string;
    expect(excerpt).toContain('export const a = 1'); expect(excerpt).not.toContain('hunter2secret');
    for (const bad of ['../etc/passwd', '/etc/passwd', '.env', 'packages/../.env', 'packages/x/missing.ts', 'a b', 42, null]) expect(readTargetExcerpt(bad, repo)).toBeNull();
    expect(readTargetExcerpt('packages/x/a.ts', undefined)).toBeNull();
  });

  it('puts the excerpt into the reviewer prompt so the panel stops asking for the source', async () => {
    process.env.REVIEW_EVIDENCE_REPO_PATH = repo;
    try {
      const { db, panels } = setup();
      const panel = panels.createPanel({ topic: 't', question: 'q', risk_class: 'low', specialist_ids: ['systems_architect', 'security_reviewer'], metadata: {},
        context: { description: 'Add tests', rationale: 'r', grounding: { target: 'packages/x/a.ts' } } });
      const prompts: string[] = [];
      const reviewer = new SelfImprovementAgentReviewService(db, async (prompt) => { prompts.push(prompt); return JSON.stringify({ stance: 'support', confidence: 0.8, findings: ['ok'], evidence_refs: ['a.ts'] }); });
      await reviewer.reviewMissingSpecialists(panel.id, 'run-x');
      expect(prompts[0]).toContain('Target file packages/x/a.ts'); expect(prompts[0]).toContain('do not ask for the source code again');
    } finally { delete process.env.REVIEW_EVIDENCE_REPO_PATH; }
  });
});
