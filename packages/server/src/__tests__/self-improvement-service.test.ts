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
  it('requires evidence-bound distinct actors for high-risk panels', () => {
    const panels = new SpecialistPanelService(db);
    const panel = panels.createPanel({
      topic: 'DAPS acceptance',
      question: 'May the next governed wave start?',
      risk_class: 'high',
      specialist_ids: ['systems_architect', 'security_reviewer'],
    });
    const review = { stance: 'support' as const, confidence: 0.8, evidence_refs: ['test:1'] };

    expect(() => panels.submitReview(panel.id, { ...review, specialist_id: 'systems_architect' }))
      .toThrow('SPECIALIST_REVIEW_ACTOR_REQUIRED');
    panels.submitReview(panel.id, { ...review, specialist_id: 'systems_architect' }, 'reviewer-a');
    expect(() => panels.submitReview(panel.id, { ...review, specialist_id: 'security_reviewer' }, 'reviewer-a'))
      .toThrow('SPECIALIST_INDEPENDENT_REVIEW_REQUIRED');
    expect(panels.submitReview(panel.id, { ...review, specialist_id: 'security_reviewer' }, 'reviewer-b').status)
      .toBe('consensus_ready');
  });

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

  it('generates from security findings, routed through the same security review as other proposals', () => {
    const proposals = improvement.generateFromSecurityFindings(['high finding at src/auth.ts: token not validated']);
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('security');
    const panels = new SpecialistPanelService(db);
    const panel = panels.getPanel(proposals[0].panelId!);
    expect(panel.risk_class).toBe('high');
    expect(panel.panel.map((p) => p.id)).toEqual(expect.arrayContaining(['security_reviewer']));
  });

  describe('outcome feedback (Thompson-sampling priority per source)', () => {
    function seedResolvedHistory(source: string, statuses: string[]) {
      const now = new Date().toISOString();
      statuses.forEach((status, i) => {
        db.prepare(`
          INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
          VALUES (?, 'feature', ?, ?, 'seeded history', ?, ?, 0.6, ?, ?)
        `).run(`seed-${source}-${i}`, `seed ${i}`, `seed ${i}`, source, status, now, now);
      });
    }
    // Posterior mean instead of a random draw, so priorities are deterministic here.
    const meanSampler = (a: number, b: number) => a / (a + b);
    const priorityFor = () => new SelfImprovementService(db, meanSampler).generateFromReflection({
      whatFailed: [], lessonsLearned: [], proposedImprovements: ['Add try-catch to all handlers'],
    })[0].priority;

    it('leaves priority unchanged when there is not enough resolved history yet', () => {
      seedResolvedHistory('reflection', ['needs_more_evidence', 'needs_more_evidence']); // below the 5-sample floor
      expect(priorityFor()).toBe(0.9);
    });

    it('ignores in-flight, archived and ungrounded rows (no outcome yet)', () => {
      seedResolvedHistory('reflection', [...Array(10).fill('scheduled'), ...Array(10).fill('archived'), ...Array(10).fill('needs_grounding')]);
      expect(priorityFor()).toBe(0.9);
    });

    it('raises priority for a source whose proposals verify (posterior mean 11/12)', () => {
      seedResolvedHistory('reflection', Array(10).fill('verified'));
      expect(priorityFor()).toBe(1); // 0.9 * (0.5 + 0.917) clamped to 1
    });

    it('lowers priority for a source that mostly parks or produces no change', () => {
      seedResolvedHistory('reflection', [...Array(16).fill('needs_more_evidence'), ...Array(4).fill('regressed')]);
      // successes 0, failures 4, parked 16 -> Beta(1, 13): mean 1/14
      expect(priorityFor()).toBeCloseTo(0.9 * (0.5 + 1 / 14), 5);
    });

    it('only considers the most recent 50 resolved proposals for the source', () => {
      seedResolvedHistory('reflection', Array(60).fill('needs_more_evidence'));
      expect(priorityFor()).toBeCloseTo(0.9 * (0.5 + 1 / 27), 5); // Beta(1, 1 + 0.5*50)
    });
  });

  it('caps reflection proposals per day when REFLECTION_PROPOSALS_MAX_PER_DAY is set (J4)', () => {
    process.env.REFLECTION_PROPOSALS_MAX_PER_DAY = '2';
    try {
      const made = improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix A in x', 'Fix B in y', 'Fix C in z'] });
      expect(made).toHaveLength(2);
      expect(improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix D in w'] })).toHaveLength(0);
    } finally { delete process.env.REFLECTION_PROPOSALS_MAX_PER_DAY; }
    expect(improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix E in v'] })).toHaveLength(1); // unset = no cap
  });

  describe('recordOutcome', () => {
    const seed = (id: string, status: string) => db.prepare(`
      INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, created_at, updated_at)
      VALUES (?, 'feature', 't', 'd', 'r', 'reflection', ?, 0.5, datetime('now'), datetime('now'))`).run(id, status);

    it('moves an in-flight proposal to its outcome, and nothing else', () => {
      seed('a', 'executing'); seed('b', 'needs_more_evidence'); seed('c', 'applied');
      expect(improvement.recordOutcome('a', 'verified')).toBe(true);
      expect(improvement.recordOutcome('b', 'regressed')).toBe(false);
      expect(improvement.recordOutcome('c', 'regressed')).toBe(false);
      expect(improvement.getImprovement('a').status).toBe('verified');
      expect(improvement.getImprovement('c').status).toBe('applied');
    });

    it('lets a later verified outcome override a premature regressed, not the reverse', () => {
      seed('r', 'regressed'); seed('v', 'verified');
      expect(improvement.recordOutcome('r', 'verified')).toBe(true);
      expect(improvement.recordOutcome('v', 'regressed')).toBe(false);
      expect(improvement.getImprovement('r').status).toBe('verified');
      expect(improvement.getImprovement('v').status).toBe('verified');
    });
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

  it('allows a high-risk (security) proposal to reach goal consensus on unanimous high-confidence support', () => {
    // Documents a deliberate policy change: computeConsensus() used to cap
    // decision at 'backlog' for anything above risk_class 'low', regardless
    // of review outcome. That ceiling was removed at explicit operator
    // request — this proposal is 'security' (=> risk_class 'high') and must
    // now be able to reach 'goal' and pass approveImprovement, not get stuck
    // at 'backlog' forever.
    const [proposal] = improvement.generateFromReflection({
      whatFailed: [],
      lessonsLearned: [],
      proposedImprovements: ['Fix security vulnerability in the auth handler'],
    });
    expect(proposal.type).toBe('security');

    const panels = new SpecialistPanelService(db);
    const panel = panels.getPanel(proposal.panelId!);
    expect(panel.risk_class).toBe('high');
    for (const specialist of panel.panel) {
      panels.submitReview(panel.id, {
        specialist_id: specialist.id,
        stance: 'support',
        confidence: 0.9,
        evidence_refs: proposal.evidenceRefs.length ? proposal.evidenceRefs : ['test:evidence'],
      }, `reviewer-${specialist.id}`);
    }
    const ready = panels.getPanel(panel.id);
    expect(ready.status).toBe('consensus_ready');
    expect(ready.consensus.decision).toBe('goal');
    expect(improvement.approveImprovement(proposal.id, 'admin-1')).toMatchObject({ status: 'scheduled' });
  });

  describe('agentApproveIfReady', () => {
    function highRiskConsensusReadyProposal() {
      const [proposal] = improvement.generateFromReflection({
        whatFailed: [], lessonsLearned: [],
        proposedImprovements: ['Fix security vulnerability in the session store'],
      });
      const panels = new SpecialistPanelService(db);
      const panel = panels.getPanel(proposal.panelId!);
      for (const specialist of panel.panel) {
        panels.submitReview(panel.id, {
          specialist_id: specialist.id,
          stance: 'support',
          confidence: 0.9,
          evidence_refs: proposal.evidenceRefs.length ? proposal.evidenceRefs : ['test:evidence'],
        }, `agent:${specialist.id}:run-1`);
      }
      return proposal;
    }

    it('returns null when the panel is not consensus_ready yet', () => {
      const proposals = improvement.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Fix Z'] });
      expect(improvement.agentApproveIfReady(proposals[0].id, 'run-1')).toBeNull();
    });

    it('approves autonomously once consensus is goal, using an approver identity distinct from every reviewer', () => {
      const proposal = highRiskConsensusReadyProposal();
      const result = improvement.agentApproveIfReady(proposal.id, 'run-1');
      expect(result).toMatchObject({ status: 'scheduled', approvedBy: 'agent:approver:run-1' });
    });

    it('does not double-approve an already-scheduled proposal', () => {
      const proposal = highRiskConsensusReadyProposal();
      improvement.agentApproveIfReady(proposal.id, 'run-1');
      expect(improvement.agentApproveIfReady(proposal.id, 'run-2')).toBeNull();
    });

    it('parks a proposal as needs_more_evidence when its panel reaches consensus without a goal decision, instead of leaving it stuck at proposed forever', () => {
      const [proposal] = improvement.generateFromReflection({
        whatFailed: [], lessonsLearned: [], proposedImprovements: ['Investigate a vague performance concern'],
      });
      const panels = new SpecialistPanelService(db);
      const panel = panels.getPanel(proposal.panelId!);
      for (const specialist of panel.panel) {
        panels.submitReview(panel.id, { specialist_id: specialist.id, stance: 'uncertain', confidence: 0.5, evidence_refs: ['test:evidence'] }, `agent:${specialist.id}:run-1`);
      }
      const ready = panels.getPanel(panel.id);
      expect(ready.status).toBe('consensus_ready');
      expect(ready.consensus.decision).not.toBe('goal');

      const result = improvement.agentApproveIfReady(proposal.id, 'run-1');
      expect(result).toMatchObject({ status: 'needs_more_evidence' });
      expect(improvement.listImprovements('proposed').map((p) => p.id)).not.toContain(proposal.id);

      // Parked, not re-attempted: a later tick is a no-op, not a repeated transition.
      expect(improvement.agentApproveIfReady(proposal.id, 'run-2')).toBeNull();
    });
  });

  it('retains duplicate reflection evidence without changing an existing review decision', () => {
    const reflection = { whatFailed: [], lessonsLearned: ['Candidate only'], proposedImprovements: ['Add peer evidence view'] };
    const [first] = improvement.generateFromReflection({ ...reflection, reflectionId: 'first' }, true);
    const [duplicate] = improvement.generateFromReflection({ ...reflection, reflectionId: 'second' }, true);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.evidenceRefs).toEqual(['reflection:first', 'reflection:second']);
    const panels = new SpecialistPanelService(db);
    let panel = panels.getPanel(first.panelId!);
    expect(panel.context.evidence_refs).toEqual(duplicate.evidenceRefs);
    const review = { stance: 'support' as const, confidence: 0.9, evidence_refs: duplicate.evidenceRefs };
    panels.submitReview(panel.id, { ...review, specialist_id: panel.panel[0].id }, 'reviewer-a');
    const reviewing = panels.getPanel(panel.id);
    improvement.generateFromReflection({ ...reflection, reflectionId: 'third' }, true);
    panel = panels.getPanel(panel.id);
    expect(panel.status).toBe('reviewing');
    expect(panel.context).toEqual(reviewing.context);
    expect(panel.consensus).toEqual(reviewing.consensus);
    expect(panel.reviews).toEqual(reviewing.reviews);
    expect(panel.metadata.pending_evidence_refs).toEqual(['reflection:third']);
    panels.submitReview(panel.id, { ...review, specialist_id: panel.panel[1].id }, 'reviewer-b');
    improvement.approveImprovement(first.id, 'operator');
    const approved = panels.getPanel(panel.id);
    improvement.generateFromReflection({ ...reflection, reflectionId: 'fourth' }, true);
    improvement.generateFromReflection({ ...reflection, reflectionId: 'fourth' }, true);
    panel = panels.getPanel(panel.id);
    expect(panel.context).toEqual(approved.context);
    expect(panel.consensus).toEqual(approved.consensus);
    expect(panel.reviews).toEqual(approved.reviews);
    expect(panel.status).toBe('goal_created');
    expect(panel.metadata.pending_evidence_refs).toEqual(['reflection:third', 'reflection:fourth']);
    expect(improvement.getImprovement(first.id)).toMatchObject({ status: 'scheduled', approvedBy: 'operator', evidenceRefs: duplicate.evidenceRefs });
    expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM specialist_panels').get()).toEqual({ n: 1 });
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
