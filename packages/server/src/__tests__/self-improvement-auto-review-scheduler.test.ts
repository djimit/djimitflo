import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAutoReviewScheduler } from '../services/self-improvement-auto-review-scheduler';
import type { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';

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
    for (const key of ['SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED', 'SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES']) {
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

  it('leaves a proposal unapproved when reviews land on oppose', async () => {
    improvement.generateFromReflection({
      whatFailed: [], lessonsLearned: [],
      proposedImprovements: ['Fix a security vulnerability in the auth handler'],
    });
    const scheduler = new SelfImprovementAutoReviewScheduler(db, fakeReviewer('oppose'));
    const result = await scheduler.tick();
    expect(result.reviewed.length).toBe(1);
    expect(result.approved.length).toBe(0);
    const [proposal] = improvement.listImprovements();
    expect(proposal.status).toBe('proposed');
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
    expect(secondTick).toEqual({ reviewed: [], approved: [], failed: [] });

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
});
