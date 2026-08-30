import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SelfImprovementService } from '../services/self-improvement-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';

let db: Database.Database;
let improvement: SelfImprovementService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  improvement = new SelfImprovementService(db);
});

afterEach(() => {
  db?.close();
});

describe('G71: Self Improvement', () => {
  it('generates from reflection', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: ['test failed'],
      lessonsLearned: ['Need better error handling'],
      proposedImprovements: ['Add try-catch to all handlers'],
    });
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('bug_fix');
  });

  it('generates from knowledge gaps', () => {
    const proposals = improvement.generateFromGaps([
      { domain: 'kubernetes', description: 'Need to learn K8s' },
    ]);
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('feature');
  });

  it('generates from build errors', () => {
    const proposals = improvement.generateFromBuildErrors(['ERROR: type mismatch']);
    expect(proposals.length).toBe(1);
    expect(proposals[0].priority).toBeGreaterThan(0.9);
  });

  it('gets proposed improvements', () => {
    improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Improve X'],
    });
    const proposed = improvement.getProposedImprovements();
    expect(proposed.length).toBe(1);
  });

  it('requires specialist consensus and operator approval before creating one goal', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Fix Y'],
      loopRunId: 'verified-run',
      reflectionId: 'reflection-1',
    });
    expect(improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix Y'] })).toHaveLength(0);
    const goals = new AutonomousGoalGenerator(db);
    expect(goals.generateFromSelfImprovements()).toBe(0);
    expect(() => improvement.approveImprovement(proposals[0].id, 'admin-1')).toThrow('SELF_IMPROVEMENT_CONSENSUS_REQUIRED');

    const panels = new SpecialistPanelService(db);
    const panel = panels.getPanel(proposals[0].panelId!);
    for (const specialist of panel.panel) {
      panels.submitReview(panel.id, {
        specialist_id: specialist.id,
        stance: 'support',
        confidence: 0.9,
        findings: ['Evidence is sufficient'],
        evidence_refs: proposals[0].evidenceRefs,
      }, `reviewer-${specialist.id}`);
    }
    expect(() => panels.submitReview(panel.id, {
      specialist_id: panel.panel[0].id,
      stance: 'support',
      confidence: 0.8,
    }, `reviewer-${panel.panel[0].id}`)).toThrow('SPECIALIST_REVIEW_EVIDENCE_REQUIRED');
    expect(() => panels.submitReview(panel.id, {
      specialist_id: panel.panel[0].id,
      stance: 'oppose',
      confidence: 0.8,
      evidence_refs: proposals[0].evidenceRefs,
    }, 'different-reviewer')).toThrow('SPECIALIST_REVIEW_ACTOR_MISMATCH');
    expect(() => panels.submitReview(panel.id, {
      specialist_id: panel.panel[1].id,
      stance: 'support',
      confidence: 0.8,
      evidence_refs: proposals[0].evidenceRefs,
    }, `reviewer-${panel.panel[0].id}`)).toThrow('SPECIALIST_INDEPENDENT_REVIEW_REQUIRED');
    expect(() => improvement.approveImprovement(proposals[0].id, `reviewer-${panel.panel[0].id}`)).toThrow('SELF_IMPROVEMENT_OPERATOR_SEPARATION_REQUIRED');

    expect(improvement.approveImprovement(proposals[0].id, 'admin-1')).toMatchObject({ status: 'scheduled', approvedBy: 'admin-1' });
    expect(() => panels.submitReview(panel.id, {
      specialist_id: panel.panel[0].id,
      stance: 'oppose',
      confidence: 0.9,
      evidence_refs: proposals[0].evidenceRefs,
    }, `reviewer-${panel.panel[0].id}`)).toThrow('SPECIALIST_PANEL_CLOSED');
    expect(goals.generateImprovement(proposals[0].id)).toBe(1);
    expect(goals.generateImprovement(proposals[0].id)).toBe(0);
    expect(improvement.getImprovement(proposals[0].id).status).toBe('executing');
    expect((db.prepare('SELECT COUNT(*) AS count FROM goals WHERE improvement_id = ?').get(proposals[0].id) as { count: number }).count).toBe(1);
  });

  it('completes improvement', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Add Z'],
    });
    expect(() => improvement.completeImprovement(proposals[0].id)).toThrow('SELF_IMPROVEMENT_NOT_EVALUATING');
    db.prepare("UPDATE self_improvements SET status = 'evaluating' WHERE id = ?").run(proposals[0].id);
    improvement.completeImprovement(proposals[0].id);
    const history = improvement.getImprovementHistory(10);
    expect(history[0].status).toBe('applied');
  });

  it('allows a recurring regression after the previous proposal is terminal', () => {
    const reflection = { whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix recurring fault'], loopRunId: 'run-1' };
    const [first] = improvement.generateFromReflection(reflection);
    db.prepare("UPDATE self_improvements SET status = 'regressed' WHERE id = ?").run(first.id);
    expect(improvement.generateFromReflection({ ...reflection, loopRunId: 'run-2' })).toHaveLength(1);
  });

  it('adopts a legacy goal without creating a duplicate', () => {
    const [proposal] = improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Keep legacy goal'] });
    db.prepare("UPDATE self_improvements SET status = 'scheduled' WHERE id = ?").run(proposal.id);
    db.prepare(`
      INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, metadata, created_at, updated_at)
      VALUES ('legacy-goal', 'Legacy', 'created', 'low', '[]', '{}', ?, datetime('now'), datetime('now'))
    `).run(JSON.stringify({ source: 'self-improvement', improvement_id: proposal.id }));
    expect(new AutonomousGoalGenerator(db).generateImprovement(proposal.id)).toBe(0);
    expect(db.prepare("SELECT improvement_id FROM goals WHERE id = 'legacy-goal'").get()).toMatchObject({ improvement_id: proposal.id });
    expect((db.prepare('SELECT COUNT(*) AS count FROM goals').get() as { count: number }).count).toBe(1);
  });

  it('classifies security improvements', () => {
    const proposals = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Fix security vulnerability in auth'],
    });
    expect(proposals[0].type).toBe('security');
  });

  it('gets improvement history', () => {
    improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['A', 'B'],
    });
    const history = improvement.getImprovementHistory(10);
    expect(history.length).toBe(2);
  });
});
