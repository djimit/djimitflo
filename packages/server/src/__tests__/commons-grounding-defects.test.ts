import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SpecialistPanelService } from '../services/specialist-panel-service';

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
