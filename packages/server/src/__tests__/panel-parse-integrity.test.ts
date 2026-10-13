import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementAgentReviewService, validateReview } from '../services/self-improvement-agent-review-service';
import { SelfImprovementService } from '../services/self-improvement-service';

// B32 (operator 'Restore Evolutionary Health' 11-10, P0.2): a malformed specialist answer used to become a stored review
// (confidence 0, 'could not be parsed', stance coerced to needs_evidence) — prod 30 d: 2 535 reviews, 42 unparseable,
// 208 generation failures and 253 coerced to the synthetic evidence marker. No silent coercion any more.
let db: Database.Database;
let panels: SpecialistPanelService;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); panels = new SpecialistPanelService(db); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const panelFixture = () => panels.createPanel({
  topic: 'Test proposal', question: 'Authorize as goal?', risk_class: 'high', specialist_ids: ['systems_architect', 'security_reviewer'],
  metadata: { self_improvement_id: 'fixture' }, context: { description: 'Add a flag', rationale: 'Reduces surprise' },
});
const good = (stance = 'support', confidence = 0.9) => JSON.stringify({ stance, confidence, findings: ['checked the rationale'], evidence_refs: ['context:rationale'] });
const quarantined = (panelId: string) => db.prepare('SELECT * FROM specialist_review_quarantine WHERE panel_id = ? ORDER BY created_at').all(panelId) as Array<Record<string, unknown>>;

it('a malformed answer is not stored as a review: quarantined with raw hash, prompt hash and model', async () => {
  const panel = panelFixture();
  const reviewer = new SelfImprovementAgentReviewService(db, async () => 'Sure! I think it is fine overall.');
  const after = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
  expect(after.reviews ?? []).toHaveLength(0);
  const q = quarantined(panel.id);
  expect(q).toHaveLength(2);
  expect(q[0].raw_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(q[0].prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(q[0].model).toBeTruthy();
  expect(q[0].attempt).toBe(2); // the initial call plus the one re-ask
});

it('the re-ask quotes the validation error, and a valid second answer becomes the review (attempt 2)', async () => {
  const panel = panelFixture();
  const prompts: string[] = [];
  const reviewer = new SelfImprovementAgentReviewService(db, async (prompt) => {
    prompts.push(prompt);
    return prompt.includes('Your previous answer was rejected') ? good() : JSON.stringify({ stance: 'approve', confidence: 0.9, findings: ['x'], evidence_refs: ['context:rationale'] });
  });
  const after = await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
  expect(prompts.filter((p) => p.includes('stance must be one of support|oppose|uncertain|needs_evidence'))).toHaveLength(2);
  expect(after.consensus.support_count).toBe(2);
  const row = db.prepare('SELECT model, prompt_sha256, raw_sha256, attempt FROM specialist_reviews WHERE panel_id = ? LIMIT 1').get(panel.id) as Record<string, unknown>;
  expect(row.attempt).toBe(2);
  expect(row.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(row.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(row.model).toBeTruthy();
});

it('semantic-invalid answers (verdict outside the set, confidence out of range, empty findings) are quarantined, never coerced', () => {
  expect(validateReview(JSON.stringify({ stance: 'approve', confidence: 0.9, findings: ['x'], evidence_refs: ['ref:1'] })).ok).toBe(false);
  expect(validateReview(JSON.stringify({ stance: 'support', confidence: 1.4, findings: ['x'], evidence_refs: ['ref:1'] })).ok).toBe(false);
  expect(validateReview(JSON.stringify({ stance: 'support', confidence: 0.9, findings: [], evidence_refs: ['ref:1'] })).ok).toBe(false);
  expect(validateReview(JSON.stringify({ stance: 'support', confidence: 0.9, findings: ['x'], evidence_refs: ['...'] })).ok).toBe(false);
  expect(validateReview(JSON.stringify({ stance: 'support', confidence: '0.9', findings: ['x'], evidence_refs: ['ref:1'] })).ok).toBe(false);
  const ok = validateReview(`<think>{"stance":"oppose"}</think>${good('oppose', 0.4)}`);
  expect(ok.ok && ok.review.stance).toBe('oppose');
});

it('only valid reviews decide: one valid oppose + one closed seat → blocked on the valid review; never needs_more_evidence from a failure', async () => {
  const panel = panelFixture();
  let n = 0;
  // seat 1 answers validly; seat 2 always answers garbage
  const reviewer = new SelfImprovementAgentReviewService(db, async () => (n++ === 0 ? good('oppose', 0.8) : 'garbage'));
  await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
  const after = await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
  expect(after.status).toBe('consensus_ready');
  expect(after.consensus.submitted_reviews).toBe(1);
  expect(after.consensus.required_reviews).toBe(1);
  expect(after.consensus.decision).toBe('blocked');
  expect(after.consensus.needs_evidence_count).toBe(0);
});

it('a single valid support cannot authorize a goal on its own (closed seat): at most backlog', async () => {
  const panel = panelFixture();
  let n = 0;
  const reviewer = new SelfImprovementAgentReviewService(db, async () => (n++ === 0 ? good('support', 0.95) : 'garbage'));
  await reviewer.reviewMissingSpecialists(panel.id, 'run-1');
  const after = await reviewer.reviewMissingSpecialists(panel.id, 'run-2');
  expect(after.consensus.decision).not.toBe('goal');
});

it('zero valid reviews → the #758 panel_failed path (reset once, then infra_failed), never needs_more_evidence', async () => {
  const svc = new SelfImprovementService(db);
  const [p] = svc.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix error handling in the loop worker'] });
  const reviewer = new SelfImprovementAgentReviewService(db, async () => 'garbage');
  await reviewer.reviewMissingSpecialists(p.panelId!, 'run-1');
  await reviewer.reviewMissingSpecialists(p.panelId!, 'run-2');
  expect(svc.agentApproveIfReady(p.id, 'tick-1')!.status).toBe('proposed'); // reset for one retry
  expect(panels.closedSeats(p.panelId!).size).toBe(0); // quarantine cleared by the reset
  await reviewer.reviewMissingSpecialists(p.panelId!, 'run-3');
  await reviewer.reviewMissingSpecialists(p.panelId!, 'run-4');
  expect(svc.agentApproveIfReady(p.id, 'tick-2')!.status).toBe('infra_failed');
});

it('the honest unparseable count comes from quarantined attempts', async () => {
  const panel = panelFixture();
  const since = new Date(Date.now() - 1000).toISOString();
  await new SelfImprovementAgentReviewService(db, async () => 'garbage').reviewMissingSpecialists(panel.id, 'run-1');
  expect(panels.quarantinedAttemptsSince(since)).toBe(2);
});
