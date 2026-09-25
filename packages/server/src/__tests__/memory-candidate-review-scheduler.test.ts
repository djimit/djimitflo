import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { SelfImprovementService } from '../services/self-improvement-service';
import { MemoryCandidateReviewScheduler } from '../services/memory-candidate-review-scheduler';

function supportResponse() {
  return JSON.stringify({ stance: 'support', confidence: 0.9, findings: ['ok'], evidence_refs: ['context:content'] });
}
function needsEvidenceResponse(limitation: string) {
  return JSON.stringify({ stance: 'needs_evidence', confidence: 0.4, findings: [limitation], evidence_refs: ['context:content'], limitations: limitation });
}

describe('MemoryCandidateReviewScheduler', () => {
  let db: Database.Database;
  let candidates: MemoryCandidateService;
  let panels: SpecialistPanelService;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    candidates = new MemoryCandidateService(db);
    panels = new SpecialistPanelService(db);
    for (const key of ['MEMORY_CANDIDATE_REVIEW_ENABLED', 'MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES']) {
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

  function scheduler(callModel: () => Promise<string>) {
    return new MemoryCandidateReviewScheduler(db, { reviewer: new SelfImprovementAgentReviewService(db, callModel) });
  }

  function operationalCandidate(title: string) {
    return candidates.create({ title, content: `${title} content, nothing sensitive here.`, memory_type: 'operational_memory' });
  }

  it('does not arm when disabled (default off)', () => {
    const s = scheduler(async () => supportResponse());
    expect(s.start()).toBe(false);
    s.stop();
  });

  it('creates a specialist panel and promotes a candidate on unanimous support', async () => {
    const candidate = operationalCandidate('Run summary A');
    const s = scheduler(async () => supportResponse());
    const result = await s.tick();
    expect(result.reviewed).toEqual([candidate.id]);
    expect(result.promoted).toEqual([candidate.id]);
    expect(candidates.get(candidate.id).status).toBe('promoted');
  });

  it('reuses the same panel across ticks instead of creating a new one', async () => {
    const candidate = operationalCandidate('Run summary B');
    const s = scheduler(async () => needsEvidenceResponse('insufficient evidence'));
    await s.tick();
    const panelIdAfterFirst = candidates.get(candidate.id).metadata.review_panel_id;
    expect(typeof panelIdAfterFirst).toBe('string');
    const panelCountAfterFirst = (db.prepare("SELECT COUNT(*) AS n FROM specialist_panels WHERE json_extract(metadata, '$.memory_candidate_id') = ?").get(candidate.id) as { n: number }).n;
    expect(panelCountAfterFirst).toBe(1);
  });

  it('leaves a candidate pending — not promoted, not rejected — when the panel needs more evidence', async () => {
    const candidate = operationalCandidate('Run summary C');
    const s = scheduler(async () => needsEvidenceResponse('no clear evidence of durable value'));
    const result = await s.tick();
    expect(result.promoted).toEqual([]);
    expect(result.parked).toEqual([candidate.id]);
    const stored = candidates.get(candidate.id);
    expect(stored.status).toBe('candidate');
    expect(stored.promotion_status).toBe('blocked_pending_review');
  });

  it('does not re-review a parked candidate on a later tick', async () => {
    const candidate = operationalCandidate('Run summary C2');
    const s = scheduler(async () => needsEvidenceResponse('no clear evidence of durable value'));
    await s.tick();
    expect(candidates.get(candidate.id).promotion_status).toBe('blocked_pending_review');
    const second = await s.tick();
    expect(second.reviewed).toEqual([]);
    expect(second.parked).toEqual([]);
  });

  it('never reviews a candidate that classify() routed to review_required', async () => {
    const rule = candidates.create({ title: 'Auth rule', content: 'How to configure oauth token exchange.', memory_type: 'engineering_rule' });
    const s = scheduler(async () => supportResponse());
    const result = await s.tick();
    expect(result.reviewed).toEqual([]);
    expect(candidates.get(rule.id).status).toBe('review_required');
  });

  it('generates exactly one evolution proposal after 5 non-goal panels accumulate, and not a 6th until it resolves', async () => {
    const s = scheduler(async () => needsEvidenceResponse('missing provenance'));
    for (let i = 0; i < 5; i += 1) {
      operationalCandidate(`Run summary evolve-${i}`);
    }
    const result = await s.tick();
    expect(result.evolutionProposalGenerated).toBe(true);
    const improvements = new SelfImprovementService(db);
    const proposals = improvements.listImprovements('proposed');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].description).toContain('memory_scientist');

    // A 6th non-goal panel accumulates, but the first proposal is still active (fingerprint dedup).
    operationalCandidate('Run summary evolve-5');
    const second = await s.tick();
    expect(second.evolutionProposalGenerated).toBe(false);
    expect(improvements.listImprovements('proposed')).toHaveLength(1);
  });

  it('falls back to a 15-minute interval for invalid configuration', () => {
    const s = scheduler(async () => supportResponse());
    process.env.MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES = 'not-a-number';
    expect(s.intervalMinutes()).toBe(15);
    process.env.MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES = '-5';
    expect(s.intervalMinutes()).toBe(15);
  });
});
