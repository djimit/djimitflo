import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';

// E2 invariant: no valid observation ≠ negative observation — for reviewer (checker) verdicts and specialist panels.

describe('checker: a runtime / parse failure is insufficient evidence, never a rejection', () => {
  const svc = Object.create(LoopService.prototype) as {
    extractCheckerVerdict(stdout: string): string;
    checkResultsForReviewer(raw: unknown): string;
  };

  it('unparseable reviewer output → insufficient_evidence (not rejected / needs_revision)', () => {
    expect(svc.extractCheckerVerdict('')).toBe('insufficient_evidence');
    expect(svc.extractCheckerVerdict('Error: provider returned 502 Bad Gateway')).toBe('insufficient_evidence');
    expect(svc.extractCheckerVerdict('{"verdict":"accepted|needs_revision|rejected|insufficient_evidence"}')).toBe('insufficient_evidence');
    expect(svc.extractCheckerVerdict('{"verdict": "nope"')).toBe('insufficient_evidence');
  });

  it('a parsed verdict is still evaluated (valid observations decide)', () => {
    expect(svc.extractCheckerVerdict('{"verdict":"rejected","notes":"wrong file"}')).toBe('rejected');
    expect(svc.extractCheckerVerdict('{"verdict":"accepted","notes":"ok"}')).toBe('accepted');
  });

  it('checkResultsForReviewer: unavailable logs read as unavailable, a missing tool as environment, a skipped check as skipped', () => {
    const text = svc.checkResultsForReviewer([
      { name: 'test', status: 'pass', exit_status: 0, stdout_path: '/nonexistent/e2/stdout.log' },
      { name: 'lint', status: 'fail', exit_status: 127 },
      { name: 'type-check', status: 'skipped', exit_status: null },
    ]);
    expect(text).toContain('### test: pass');
    expect(text).toContain('stdout: (empty or unavailable)');
    expect(text).toMatch(/### lint: fail — tool missing \(environment failure/);
    expect(text).toContain('### type-check: skipped');
    expect(svc.checkResultsForReviewer(undefined)).toBe('No deterministic checks recorded.');
  });
});

describe('panel: an invalid specialist answer never votes', () => {
  let db: Database.Database; let panels: SpecialistPanelService;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); panels = new SpecialistPanelService(db); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  const panelFixture = () => panels.createPanel({
    topic: 'Test proposal', question: 'Authorize as goal?', risk_class: 'high', specialist_ids: ['systems_architect', 'security_reviewer'],
    metadata: { self_improvement_id: 'fixture' }, context: { description: 'Add a flag', rationale: 'Reduces surprise' },
  });
  const good = (stance: string, confidence = 0.9) => JSON.stringify({ stance, confidence, findings: ['checked the rationale'], evidence_refs: ['context:rationale'] });

  it('a generation failure (model throws) never becomes a review or a vote', async () => {
    const panel = panelFixture();
    const reviewer = new SelfImprovementAgentReviewService(db, async () => { throw new Error('model exploded'); });
    for (let i = 0; i < 6; i++) await reviewer.reviewMissingSpecialists(panel.id, `run-${i}`);
    const after = panels.getPanel(panel.id);
    expect(after.reviews ?? []).toHaveLength(0);
    expect(after.consensus.oppose_count).toBe(0);
    expect(after.consensus.needs_evidence_count).toBe(0);
    expect(after.consensus.decision).not.toBe('blocked');
  });

  it('a legacy machine-failed review row (pre-#784 coercion) is not counted as a vote: the valid review decides', () => {
    const panel = panelFixture();
    panels.submitReview(panel.id, { specialist_id: 'systems_architect', stance: 'support', confidence: 0.95, findings: ['solid'], evidence_refs: ['context:rationale'] } as never, 'actor-a');
    // the old fallback row: stance coerced to needs_evidence, confidence 0, fixed finding text
    const after = panels.submitReview(panel.id, { specialist_id: 'security_reviewer', stance: 'needs_evidence', confidence: 0, findings: ['Model response could not be parsed: garbage'], evidence_refs: ['legacy:fallback'] } as never, 'actor-b');
    expect(after.consensus.needs_evidence_count).toBe(0);
    expect(after.consensus.submitted_reviews).toBe(1);
    expect(after.consensus.required_reviews).toBe(1);
    expect(after.consensus.dissent).toEqual([]);
  });

  it('a valid oppose still blocks (FAIL stays FAIL on valid evidence)', async () => {
    const panel = panelFixture();
    const reviewer = new SelfImprovementAgentReviewService(db, async () => good('oppose', 0.8));
    const after = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
    expect(after.consensus.decision).toBe('blocked');
  });
});
