import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { commonsChildOutcomes, commonsGroundingStops } from '../services/honest-numbers';

// prod 10-10 (scratchpad/commons-trace.md): 0 of 24 validly grounded Commons proposals reached a goal — the grounded target
// never reached the pre-screen, and 10 were parked by a panel whose every review was a model failure.
let db: Database.Database;
let svc: SelfImprovementService;
let panels: SpecialistPanelService;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); svc = new SelfImprovementService(db); panels = new SpecialistPanelService(db); });
afterEach(() => db.close());

it('a grounded refinement names its target and test in the description the pre-screen reads', () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
    VALUES ('p1', 'feature', 'Idea', 'A paper idea', 'r', 'reflection', 'needs_grounding', 0.5, '["reflection:x"]', ?, ?)`).run(now, now);
  const child = svc.groundFromCommons('p1', { target: 'packages/server/src/services/foo.ts', acceptanceTest: 'packages/server/src/__tests__/foo.test.ts' }, 'commons:t1')!;
  expect(child.description).toContain('packages/server/src/services/foo.ts');
  expect(child.description).toContain('packages/server/src/__tests__/foo.test.ts');
});

function proposalWithReviews(review: (i: number) => { stance: 'needs_evidence' | 'support'; confidence: number; findings: string[]; evidence_refs: string[] }) {
  const [p] = svc.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix error handling in the loop worker'] });
  const panel = panels.getPanel(p.panelId!);
  panel.panel.forEach((s, i) => panels.submitReview(panel.id, { specialist_id: s.id, ...review(i) }, `agent:${s.id}:run-1`));
  return p;
}
const failed = () => ({ stance: 'needs_evidence' as const, confidence: 0, findings: ['Model response could not be parsed as a structured review.'], evidence_refs: ['agent-review:model-response-unparseable-or-missing-evidence'] });

it('a panel of only model failures is not a verdict: reset once, then infra_failed, never needs_more_evidence', () => {
  const p = proposalWithReviews(failed);
  expect(svc.agentApproveIfReady(p.id, 'run-1')!.status).toBe('proposed');
  expect(panels.getPanel(p.panelId!).status).not.toBe('consensus_ready');
  const panel = panels.getPanel(p.panelId!);
  panel.panel.forEach((s) => panels.submitReview(panel.id, { specialist_id: s.id, ...failed() }, `agent:${s.id}:run-2`));
  expect(svc.agentApproveIfReady(p.id, 'run-2')!.status).toBe('infra_failed');
  expect((db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'panel_failed' AND subject_id = ?").get(p.id) as { n: number }).n).toBe(2);
});

it('one parsed review keeps the normal decision', () => {
  const p = proposalWithReviews((i) => (i === 0 ? { stance: 'needs_evidence', confidence: 0.7, findings: ['no test named'], evidence_refs: ['test:1'] } : failed()));
  expect(svc.agentApproveIfReady(p.id, 'run-1')!.status).toBe('needs_more_evidence');
});

// AC-03 (audit 24-10): 10 of 18 grounded child panels hold only pre-#784 'could not be parsed' fallback reviews; the Commons
// funnel showed them as idea rejections. Read-only classification of each grounded child's panel outcome.
const at = '2026-09-26T10:00:00Z';
type Seat = { stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence'; confidence: number; findings: string[] };
const legacy = (): Seat => ({ stance: 'needs_evidence', confidence: 0, findings: ['Model response could not be parsed as a structured review.'] });
function groundedChild(n: string, decision: string, seats: Seat[], status = 'archived') {
  db.prepare(`INSERT INTO specialist_panels (id, topic, question, status, risk_class, panel_json, consensus_json, created_at)
    VALUES (?, 't', 'q', 'consensus_ready', 'medium', ?, ?, ?)`).run(`panel-${n}`, JSON.stringify(seats.map((_, i) => ({ id: `s${i}` }))), JSON.stringify({ decision }), at);
  seats.forEach((s, i) => db.prepare(`INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, findings_json, status, created_at)
    VALUES (?, ?, ?, 'T', ?, ?, ?, 'submitted', ?)`).run(`r-${n}-${i}`, `panel-${n}`, `s${i}`, s.stance, s.confidence, JSON.stringify(s.findings), at));
  for (const [id, st, panel] of [[`parent-${n}`, 'archived', null], [`kid-${n}`, status, `panel-${n}`]]) {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at)
      VALUES (?, 'feature', 't', 'd', 'r', 'reflection', ?, 0.5, ?, ?, ?)`).run(id, st, panel, at, at);
  }
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'commons_grounding', 'self_improvement', ?, 'h', 'enforce', 'yes', 'r', ?, ?)`).run(`g-${n}`, `parent-${n}`, JSON.stringify({ refinement_id: `kid-${n}` }), at);
}

it('AC-03: a panel of only legacy unparseable fallbacks is a technical review failure, not an idea rejection', () => {
  groundedChild('a', 'needs_more_evidence', [legacy(), legacy()]);
  const o = commonsChildOutcomes(db)!;
  expect(o.children).toBe(1);
  expect(o.outcomes).toMatchObject({ technical_failure: 1, needs_evidence: 0, blocked: 0, goal: 0 });
  expect(o.legacy_fallback_reviews).toBe(2);
  // the parent-level stop agrees: a failed panel, not a rejection
  expect(commonsGroundingStops(db)).toMatchObject({ panel_failed: 1, rejected: 0 });
});

it('AC-03: one real confidence > 0 needs-evidence review stays substantive missing evidence, next to a legacy fallback', () => {
  groundedChild('b', 'needs_more_evidence', [{ stance: 'needs_evidence', confidence: 0.7, findings: ['no reproduction of the failure'] }, legacy()]);
  expect(commonsChildOutcomes(db)!.outcomes).toMatchObject({ needs_evidence: 1, technical_failure: 0 });
  expect(commonsGroundingStops(db)).toMatchObject({ rejected: 1, panel_failed: 0 });
});

it('AC-03: support + backlog stays backlog; opposed stays blocked; no status changes', () => {
  groundedChild('c', 'backlog', [{ stance: 'support', confidence: 0.8, findings: ['ok'] }, { stance: 'support', confidence: 0.7, findings: ['ok'] }]);
  groundedChild('d', 'blocked', [{ stance: 'oppose', confidence: 0.8, findings: ['wrong layer'] }, { stance: 'oppose', confidence: 0.6, findings: ['risk'] }]);
  const before = db.prepare('SELECT id, status FROM self_improvements ORDER BY id').all();
  expect(commonsChildOutcomes(db)!.outcomes).toMatchObject({ backlog: 1, blocked: 1, technical_failure: 0, needs_evidence: 0 });
  expect(db.prepare('SELECT id, status FROM self_improvements ORDER BY id').all()).toEqual(before);
});
