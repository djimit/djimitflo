import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAutoReviewScheduler } from '../services/self-improvement-auto-review-scheduler';
import type { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import type { SelfImprovementRefinementService, RefinedProposalDraft } from '../services/self-improvement-refinement-service';

describe('SelfImprovementAutoReviewScheduler', () => {
  let db: Database.Database;
  let improvement: SelfImprovementService;
  let panels: SpecialistPanelService;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    improvement = new SelfImprovementService(db);
    panels = new SpecialistPanelService(db);
    for (const key of [
      'SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED', 'SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES',
      'SELF_IMPROVEMENT_REFINEMENT_ENABLED', 'SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK',
    ]) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    db?.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function fakeReviewer(stance: 'support' | 'oppose' = 'support'): SelfImprovementAgentReviewService {
    return {
      reviewMissingSpecialists: async (panelId: string, runId: string) => {
        const panel = panels.getPanel(panelId);
        const reviewed = new Set((panel.reviews || []).map((r) => r.specialist_id));
        let updated = panel;
        for (const profile of panel.panel) {
          if (reviewed.has(profile.id)) continue;
          updated = panels.submitReview(
            panelId,
            { specialist_id: profile.id, stance, confidence: 0.9, evidence_refs: ['fixture:evidence'] },
            `agent:${profile.id}:${runId}`,
          );
        }
        return updated;
      },
    } as unknown as SelfImprovementAgentReviewService;
  }

  /**
   * Draft varies by the proposal being refined (mirrors reality: a real refiner's
   * output depends on its input) so that refining several different proposals in
   * one tick doesn't collide on fingerprint dedup — each child needs a distinct
   * title/description just like each original proposal does.
   */
  function fakeRefiner(draft: RefinedProposalDraft | null | 'vary' = 'vary'): SelfImprovementRefinementService {
    return {
      refine: async (proposal: { id: string }) => draft === 'vary'
        ? { title: `Refined: ${proposal.id}`, description: `Refined description for ${proposal.id}.`, rationale: 'Refined rationale.' }
        : draft,
    } as unknown as SelfImprovementRefinementService;
  }

  /** Creates a proposal and drives it straight to needs_more_evidence via a unanimous-oppose tick. */
  async function parkedProposal(title: string) {
    improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: [title] });
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'));
    await scheduler.tick();
    const [proposal] = improvement.listImprovements('needs_more_evidence', 1);
    return proposal;
  }

  it('does not arm when disabled (default off)', () => {
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer());
    expect(scheduler.start()).toBe(false);
    scheduler.stop();
  });

  it('arms when enabled', () => {
    process.env.SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED = 'true';
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer());
    expect(scheduler.start()).toBe(true);
    scheduler.stop();
  });

  it('reviews and then agent-approves a ready proposal within a single tick', async () => {
    improvement.generateFromReflection({
      whatFailed: [], lessonsLearned: [],
      proposedImprovements: ['Fix a security vulnerability in the session store'],
    });
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('support'));
    const result = await scheduler.tick();
    expect(result.reviewed.length).toBe(1);
    expect(result.approved.length).toBe(1);
    const [proposal] = improvement.listImprovements();
    expect(proposal.status).toBe('scheduled');
  });

  it('parks a proposal as needs_more_evidence — not left stuck at proposed forever — when reviews land on oppose', async () => {
    improvement.generateFromReflection({
      whatFailed: [], lessonsLearned: [],
      proposedImprovements: ['Fix a security vulnerability in the auth handler'],
    });
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'));
    const result = await scheduler.tick();
    expect(result.reviewed.length).toBe(1);
    expect(result.approved.length).toBe(0);
    expect(result.parked.length).toBe(1);
    const [proposal] = improvement.listImprovements();
    expect(proposal.status).toBe('needs_more_evidence');
  });

  it('isolates a per-proposal failure instead of aborting the whole tick', async () => {
    improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix A'] });
    improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix B'] });
    const throwing = {
      reviewMissingSpecialists: async () => { throw new Error('model unreachable'); },
    } as unknown as SelfImprovementAgentReviewService;
    const scheduler = new SelfImprovementAutoReviewScheduler(db, throwing);
    const result = await scheduler.tick();
    expect(result.failed.length).toBe(2);
    expect(result.reviewed.length).toBe(0);
  });

  it('ignores an overlapping tick while one is already in flight', async () => {
    improvement.generateFromReflection({
      whatFailed: [], lessonsLearned: [],
      proposedImprovements: ['Fix a security vulnerability in the token store'],
    });
    let resolveReview: (() => void) | null = null;
    const slowReviewer = {
      reviewMissingSpecialists: async (panelId: string, runId: string) => {
        await new Promise<void>((resolve) => { resolveReview = resolve; });
        return fakeReviewer('support').reviewMissingSpecialists(panelId, runId);
      },
    } as unknown as SelfImprovementAgentReviewService;
    const scheduler = new SelfImprovementAutoReviewScheduler(db, slowReviewer);

    const firstTick = scheduler.tick();
    const secondTick = await scheduler.tick();
    expect(secondTick).toEqual({ reviewed: [], approved: [], parked: [], refined: [], refinementAttempted: 0, failed: [] });

    resolveReview!();
    const firstResult = await firstTick;
    expect(firstResult.reviewed.length).toBe(1);
  });

  it('falls back to a 15-minute interval for invalid configuration', () => {
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer());
    process.env.SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES = 'not-a-number';
    expect(scheduler.intervalMinutes()).toBe(15);
    process.env.SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES = '-5';
    expect(scheduler.intervalMinutes()).toBe(15);
  });

  describe('refinement pass', () => {
    it('does not attempt refinement when SELF_IMPROVEMENT_REFINEMENT_ENABLED is unset (default off)', async () => {
      const parked = await parkedProposal('Fix a security vulnerability in refinement test off');
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), fakeRefiner());
      const result = await scheduler.tick();
      expect(result.refined).toEqual([]);
      expect(improvement.getImprovement(parked.id).refinedAt).toBeNull();
    });

    it('refines a parked proposal into a new proposed proposal when enabled, linking parent and child', async () => {
      const parked = await parkedProposal('Fix a security vulnerability in refinement test A');
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), fakeRefiner());
      const result = await scheduler.tick();
      expect(result.refined).toEqual([parked.id]);

      const parent = improvement.getImprovement(parked.id);
      expect(parent.refinedAt).not.toBeNull();

      const child = improvement.listImprovements('proposed').find((p) => p.refinedFromId === parked.id);
      expect(child).toBeTruthy();
      expect(child!.source).toBe('refinement');
      expect(child!.title).toBe(`Refined: ${parked.id}`);
      expect(child!.evidenceRefs).toContain(`refinement-of:${parked.id}`);
    });

    it('does not re-refine a proposal that has already spawned a refinement', async () => {
      const parked = await parkedProposal('Fix a security vulnerability in refinement test B');
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), fakeRefiner());
      await scheduler.tick();
      const second = await scheduler.tick();
      expect(second.refined).toEqual([]);
    });

    it('never refines a proposal that is itself already a refinement (no recursive chains)', async () => {
      const parked = await parkedProposal('Fix a security vulnerability in refinement test C');
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), fakeRefiner());
      const first = await scheduler.tick();
      expect(first.refined).toEqual([parked.id]);
      // The child gets reviewed+parked in this same next tick; it must not also be refined.
      const second = await scheduler.tick();
      expect(second.refined).toEqual([]);
      const child = improvement.listImprovements().find((p) => p.refinedFromId === parked.id)!;
      expect(child.status).toBe('needs_more_evidence');
    });

    it('caps refinement attempts at SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK even with far more eligible proposals than the cap', async () => {
      for (let i = 0; i < 5; i += 1) {
        await parkedProposal(`Fix a security vulnerability in refinement-cap-${i}`);
      }
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      process.env.SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK = '2';
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), fakeRefiner());
      const result = await scheduler.tick();
      expect(result.refined).toHaveLength(2);
    });

    it('falls back to the default per-tick cap for invalid configuration, and enforces the hard ceiling', () => {
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer(), fakeRefiner());
      process.env.SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK = 'not-a-number';
      expect(scheduler.refinementMaxPerTick()).toBe(3);
      process.env.SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK = '-5';
      expect(scheduler.refinementMaxPerTick()).toBe(3);
      process.env.SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK = '999';
      expect(scheduler.refinementMaxPerTick()).toBe(10);
    });

    it('isolates a per-proposal refinement failure instead of aborting the tick', async () => {
      await parkedProposal('Fix a security vulnerability in refinement-fail-1');
      await parkedProposal('Fix a security vulnerability in refinement-fail-2');
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      const throwingRefiner = { refine: async () => { throw new Error('model unreachable'); } } as unknown as SelfImprovementRefinementService;
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), throwingRefiner);
      const result = await scheduler.tick();
      expect(result.failed.length).toBe(2);
      expect(result.refined).toEqual([]);
    });

    it('does not attempt refinement when the parked proposal panel has not reached consensus_ready (defensive)', async () => {
      const [proposal] = improvement.generateFromReflection({
        whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix a security vulnerability in refinement-defensive'],
      });
      db.prepare("UPDATE self_improvements SET status = 'needs_more_evidence' WHERE id = ?").run(proposal.id);
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), fakeRefiner());
      const result = await scheduler.tick();
      expect(result.refined).toEqual([]);
    });

    it('reports refinementAttempted even when every attempt fails, so a persistently-broken refiner cannot go silent', async () => {
      const parked = await parkedProposal('Fix a security vulnerability in refinement-silent-failure');
      process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED = 'true';
      const alwaysNullRefiner = fakeRefiner(null); // mirrors a misconfigured model: every call returns null, no thrown error
      const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'), alwaysNullRefiner);
      const result = await scheduler.tick();
      expect(result.refined).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.refinementAttempted).toBe(1);
      expect(improvement.getImprovement(parked.id).refinedAt).toBeNull();
    });
  });
});
