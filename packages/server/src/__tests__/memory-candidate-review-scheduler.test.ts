import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { SelfImprovementService } from '../services/self-improvement-service';
import { MemoryCandidateReviewScheduler } from '../services/memory-candidate-review-scheduler';
import { resetSchedulers } from '../services/scheduler-registry';

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
    resetSchedulers();
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

  it('uses a custom interval when configured with a positive number', () => {
    const s = scheduler(async () => supportResponse());
    process.env.MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES = '7';
    expect(s.intervalMinutes()).toBe(7);
  });

  it('falls back to 15 for a zero interval', () => {
    const s = scheduler(async () => supportResponse());
    process.env.MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES = '0';
    expect(s.intervalMinutes()).toBe(15);
  });

  it('arms and starts the interval when enabled, and stop() clears the timer', () => {
    process.env.MEMORY_CANDIDATE_REVIEW_ENABLED = 'true';
    process.env.MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES = '7';
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const s = scheduler(async () => supportResponse());
    expect(s.start()).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const delay = setIntervalSpy.mock.calls[0][1];
    expect(delay).toBe(7 * 60 * 1000);
    s.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('reports all-empty results and does not log when there is nothing to review', async () => {
    const s = scheduler(async () => supportResponse());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await s.tick();
    expect(result.reviewed).toEqual([]);
    expect(result.promoted).toEqual([]);
    expect(result.parked).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.evolutionProposalGenerated).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('logs a summary line and reports clean fields when a candidate is promoted', async () => {
    const candidate = operationalCandidate('Run summary log');
    const s = scheduler(async () => supportResponse());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await s.tick();
    expect(result.reviewed).toEqual([candidate.id]);
    expect(result.promoted).toEqual([candidate.id]);
    expect(result.failed).toEqual([]);
    expect(result.evolutionProposalGenerated).toBe(false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('memory-candidate review tick');
    logSpy.mockRestore();
  });

  it('records a failed review in result.failed and still logs', async () => {
    const candidate = operationalCandidate('Run summary fail');
    candidates.setReviewPanel(candidate.id, 'nonexistent-panel-id');
    const s = scheduler(async () => supportResponse());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await s.tick();
    expect(result.reviewed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(candidate.id);
    expect(result.failed[0].error).toContain('SPECIALIST_PANEL_NOT_FOUND');
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('reuses the existing review panel on a second tick without creating a duplicate', async () => {
    const candidate = operationalCandidate('Run summary reuse');
    const s = scheduler(async () => needsEvidenceResponse('insufficient'));
    await s.tick();
    expect(candidates.get(candidate.id).promotion_status).toBe('blocked_pending_review');
    db.prepare("UPDATE memory_candidates SET promotion_status = 'proposed' WHERE id = ?").run(candidate.id);
    const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM specialist_panels WHERE json_extract(metadata, '$.memory_candidate_id') = ?").get(candidate.id) as { n: number }).n;
    expect(countBefore).toBe(1);
    await s.tick();
    const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM specialist_panels WHERE json_extract(metadata, '$.memory_candidate_id') = ?").get(candidate.id) as { n: number }).n;
    expect(countAfter).toBe(1);
  });
});
