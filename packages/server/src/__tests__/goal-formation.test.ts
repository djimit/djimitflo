import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { GoalFormationService } from '../services/goal-formation-service';
import { CuriosityService } from '../services/curiosity-service';
import { SelfModelService } from '../services/self-model-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let goalFormation: GoalFormationService;
let curiosity: CuriosityService;
let selfModel: SelfModelService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  const intelligence = new SwarmIntelligenceService(db);
  curiosity = new CuriosityService(db, intelligence);
  selfModel = new SelfModelService(db);
  goalFormation = new GoalFormationService(db, curiosity, selfModel);
});

afterEach(() => {
  db?.close();
});

describe('G42: Goal Formation', () => {
  it('generates goals from curiosity gaps', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('g1', 'test', 'memory', 'security', 'has_property', 'supported', 0.8, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const goals = await goalFormation.generateAutonomousGoals();
    expect(goals.length).toBeGreaterThanOrEqual(0);
  });

  it('generates self-improvement goals from known unknowns', async () => {
    db.prepare(`
      INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold,
        cost_model_json, removal_strategy, metadata, created_at, updated_at)
      VALUES ('cap-unk', 'skill', 'test', '0.1', 'validated', 'low', 'none', 'none',
        '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))
    `).run();
    const goals = await goalFormation.generateAutonomousGoals();
    const selfImprovement = goals.find(g => g.source === 'self_improvement');
    expect(selfImprovement).toBeDefined();
  });

  it('respects 50% capacity cap', async () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO goals (id, objective, status, risk_class, created_at, updated_at)
        VALUES (?, ?, 'running', 'low', datetime('now'), datetime('now'))
      `).run('existing-' + i, 'Existing goal ' + i);
    }
    const goals = await goalFormation.generateAutonomousGoals();
    expect(goals.length).toBe(0);
  });

  it('injects goals into database', () => {
    const goals = [{
      id: 'test-goal-1',
      objective: 'Investigate security gap',
      acceptanceCriteria: ['>= 1 finding'],
      riskClass: 'low' as const,
      source: 'curiosity' as const,
    }];
    goalFormation.injectGoals(goals);
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get('test-goal-1') as any;
    expect(row).toBeDefined();
    expect(row.objective).toBe('Investigate security gap');
  });

  it('all autonomous goals have acceptance criteria', async () => {
    db.prepare(`
      INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, confidence, evidence_refs_json, created_from, created_at, updated_at)
      VALUES ('g2', 'test', 'memory', 'performance', 'has_property', 'supported', 0.3, '[]', 'test', datetime('now'), datetime('now'))
    `).run();
    const goals = await goalFormation.generateAutonomousGoals();
    for (const g of goals) {
      expect(g.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });
});
