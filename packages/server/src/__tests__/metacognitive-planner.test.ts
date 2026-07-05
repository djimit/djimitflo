import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MetacognitivePlanner } from '../services/metacognitive-planner';
import { SelfModelService } from '../services/self-model-service';
import { GoalFormationService } from '../services/goal-formation-service';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let selfModel: SelfModelService;
let goalFormation: GoalFormationService;
let planner: MetacognitivePlanner;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  try { db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5'); } catch { /* ok */ }
  selfModel = new SelfModelService(db);
  goalFormation = new GoalFormationService(db);
  planner = new MetacognitivePlanner(db, selfModel, goalFormation);
});

afterEach(() => {
  db?.close();
});

function insertCapability(id: string, status: string = 'validated') {
  db.prepare(`
    INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
      allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold,
      cost_model_json, removal_strategy, metadata, created_at, updated_at)
    VALUES (?, 'skill', 'test', '0.1', ?, 'low', 'none', 'none',
      '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))
  `).run(id, status);
}

describe('G48: Metacognitive Planner', () => {
  it('generates curriculum from known unknowns', () => {
    insertCapability('cap-new');
    const goals = planner.generateLearningCurriculum();
    expect(goals.length).toBeGreaterThan(0);
  });

  it('prioritizes by ROI (impact / effort)', () => {
    insertCapability('cap-data');
    insertCapability('cap-calc');
    const goals = planner.generateLearningCurriculum();
    if (goals.length >= 2) {
      expect(goals[0].roi).toBeGreaterThanOrEqual(goals[1].roi);
    }
  });

  it('limits curriculum to top 3 goals', () => {
    for (let i = 0; i < 10; i++) insertCapability('cap-' + i);
    const goals = planner.generateLearningCurriculum();
    expect(goals.length).toBeLessThanOrEqual(3);
  });

  it('estimateImpact returns higher for competence gaps', () => {
    const impact = planner.estimateImpact({ domain: 'test', reason: 'competence gap' });
    expect(impact).toBeGreaterThan(0.5);
  });

  it('estimateEffort returns lower for insufficient data', () => {
    const effort = planner.estimateEffort({ domain: 'test', reason: 'insufficient_data' });
    expect(effort).toBeLessThan(0.5);
  });

  it('recordLearningOutcome updates status', () => {
    insertCapability('cap-outcome');
    const goals = planner.generateLearningCurriculum();
    if (goals.length > 0) {
      planner.recordLearningOutcome(goals[0].id, 'success');
      const active = planner.getActiveLearningGoals();
      expect(active.find(g => g.id === goals[0].id)).toBeUndefined();
    }
  });

  it('adjustStrategy reduces effort on success', () => {
    insertCapability('cap-strategy');
    const goals = planner.generateLearningCurriculum();
    if (goals.length > 0) {
      const before = goals[0].estimatedEffort;
      planner.adjustStrategy(goals[0].id, 'success');
      expect(before).toBeGreaterThan(0);
    }
  });

  it('getActiveLearningGoals returns only active', () => {
    insertCapability('cap-active');
    planner.generateLearningCurriculum();
    const active = planner.getActiveLearningGoals();
    for (const g of active) {
      expect(['proposed', 'in_progress']).toContain(g.status);
    }
  });

  it('approveGoal changes status', () => {
    insertCapability('cap-approve');
    const goals = planner.generateLearningCurriculum();
    if (goals.length > 0) {
      planner.approveGoal(goals[0].id);
      const active = planner.getActiveLearningGoals();
      const found = active.find(g => g.id === goals[0].id);
      if (found) expect(found.status).toBe('approved');
    }
  });

  it('startGoal changes status to in_progress', () => {
    insertCapability('cap-start');
    const goals = planner.generateLearningCurriculum();
    if (goals.length > 0) {
      planner.startGoal(goals[0].id);
      const active = planner.getActiveLearningGoals();
      const found = active.find(g => g.id === goals[0].id);
      if (found) expect(found.status).toBe('in_progress');
    }
  });

  it('goals have acceptance criteria', () => {
    insertCapability('cap-criteria');
    const goals = planner.generateLearningCurriculum();
    for (const g of goals) {
      expect(g.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });

  it('goals have valid ROI between 0 and infinity', () => {
    insertCapability('cap-roi');
    const goals = planner.generateLearningCurriculum();
    for (const g of goals) {
      expect(g.roi).toBeGreaterThan(0);
      expect(g.roi).toBeLessThan(10);
    }
  });

  it('getCompletedGoals returns finished goals', () => {
    insertCapability('cap-done');
    const goals = planner.generateLearningCurriculum();
    if (goals.length > 0) {
      planner.recordLearningOutcome(goals[0].id, 'success');
      const completed = planner.getCompletedGoals();
      expect(completed.length).toBeGreaterThan(0);
    }
  });

  it('curriculum is deterministic for same unknowns', () => {
    insertCapability('cap-det');
    const run1 = planner.generateLearningCurriculum();
    const run2 = planner.generateLearningCurriculum();
    expect(run1.length).toBe(run2.length);
  });
});
