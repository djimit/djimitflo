import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { GoalBatchService } from '../services/goal-batch-service';
import { WorldLabEvidenceService } from '../services/worldlab-evidence-service';
import { AgentInteractionLedgerService } from '../services/agent-interaction-ledger-service';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => db.close());

function createGoal() {
  return new GoalBatchService(db).apply({ batch: {
    schema: 'djimit.openmythos.worldlab.goal.v1', campaign_id: 'campaign-1',
    source: { finding_id: 'finding-1', evidence_hash: `sha256:${'a'.repeat(64)}` },
    finding: { failure_mode: 'epistemic_contagion' },
    waves: [{ wave_id: 'confirm', goals: [{ id: 'goal-1', objective: 'Confirm finding', risk_class: 'medium',
      acceptance_criteria: ['all gates pass'], constraints: [], falsification_tests: ['failure not reproduced'] }] }],
  } }).created_goals[0];
}

function retest(goalId: string, gates: Record<string, string> = {
  static_openmythos: 'PASS', worldlab_targeted: 'PASS', djimitflo_tests: 'PASS', security_invariants: 'PASS',
}) {
  return {
    schema: 'djimit.openmythos.worldlab.retest.v1', finding_id: 'finding-1', goal_id: goalId,
    change_id: 'change-1', commit: 'abcdef1234567', trajectory_id: 'trajectory-retest-1',
    evidence_hash: `sha256:${'b'.repeat(64)}`, gates,
    evidence_refs: ['openmythos:static-1', 'worldlab:retest-1', 'djimitflo:proof-1', 'security:invariants-1'],
  };
}

describe('WorldLabEvidenceService', () => {
  it('links finding, change, commit, retest and goal without promoting', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(service.recordRetest(retest(goal.id))).toMatchObject({ decision: 'PROMOTION_CANDIDATE', duplicate: false, promoted: false });
    expect(service.recordRetest(retest(goal.id))).toMatchObject({ decision: 'PROMOTION_CANDIDATE', duplicate: true, promoted: false });
    const stored = db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(goal.id) as any;
    expect(stored.status).toBe('created');
    expect(JSON.parse(stored.metadata)).toMatchObject({ promotion_state: 'PROMOTION_CANDIDATE', worldlab_retests: [{ promoted: false }] });
    expect(new AgentInteractionLedgerService(db).list({ source: 'swarm_evidence_edges' }).length).toBeGreaterThanOrEqual(7);
  });

  it('never treats unknown or incomplete evidence as pass', () => {
    const goal = createGoal();
    const service = new WorldLabEvidenceService(db);
    expect(service.recordRetest(retest(goal.id, {
      static_openmythos: 'PASS', worldlab_targeted: 'UNDETERMINED', djimitflo_tests: 'PASS', security_invariants: 'PASS',
    }))).toMatchObject({ decision: 'UNDETERMINED', promoted: false });
    expect(() => service.recordRetest({ ...retest(goal.id), evidence_refs: ['worldlab:only'] }))
      .toThrow('WORLDLAB_RETEST_INVALID');
  });
});
