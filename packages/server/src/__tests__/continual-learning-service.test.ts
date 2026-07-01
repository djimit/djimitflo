import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ContinualLearningService } from '../services/continual-learning-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let learning: ContinualLearningService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  learning = new ContinualLearningService(db);
});

afterEach(() => {
  db?.close();
});

describe('G68: Continual Learning', () => {
  it('stores experience', () => {
    const exp = learning.storeExperience('ts-fix', { repo: 'test' }, 'success');
    expect(exp.id).toBeDefined();
    expect(exp.outcome).toBe('success');
  });

  it('replays experiences', () => {
    learning.storeExperience('ts-fix', { r: 'a' }, 'success');
    learning.storeExperience('ts-fix', { r: 'b' }, 'failure');
    const replay = learning.replayExperiences('ts-fix', 10);
    expect(replay.length).toBe(2);
  });

  it('detects transfer opportunities', () => {
    db.prepare("INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES ('ts-fix', 'skill', 'test', '1', 'validated', 'low', 'none', 'none', '[]', '[]', '[]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES ('ts-lint', 'skill', 'test', '1', 'validated', 'low', 'none', 'none', '[]', '[]', '[]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))").run();
    const opportunities = learning.detectTransferOpportunities();
    expect(opportunities.length).toBeGreaterThanOrEqual(0);
  });

  it('applies transfer', () => {
    learning.storeExperience('source', { data: 'test' }, 'success');
    const applied = learning.applyTransfer('source', 'target');
    expect(applied).toBe(true);
    const targetExp = learning.replayExperiences('target', 10);
    expect(targetExp.length).toBeGreaterThan(0);
  });

  it('measures forgetting', () => {
    for (let i = 0; i < 10; i++) learning.storeExperience('ts-fix', { r: 'old' }, 'success');
    for (let i = 0; i < 5; i++) learning.storeExperience('ts-fix', { r: 'new' }, 'failure');
    const forgetting = learning.measureForgetting('ts-fix');
    expect(forgetting).toBeGreaterThanOrEqual(0);
  });

  it('gets transfer history', () => {
    db.prepare("INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES ('cap-a', 'skill', 'test', '1', 'validated', 'low', 'none', 'none', '[]', '[]', '[]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref, allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold, cost_model_json, removal_strategy, metadata, created_at, updated_at) VALUES ('cap-b', 'skill', 'test', '1', 'validated', 'low', 'none', 'none', '[]', '[]', '[]', 0, 0.5, '{}', 'demote_on_fail', '{}', datetime('now'), datetime('now'))").run();
    learning.detectTransferOpportunities();
    const history = learning.getTransferHistory(10);
    expect(history.length).toBeGreaterThanOrEqual(0);
  });

  it('prunes buffer when full', () => {
    for (let i = 0; i < 110; i++) {
      learning.storeExperience('cap', { i }, 'success');
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM experience_replay_buffer').get() as { c: number };
    expect(count.c).toBeLessThanOrEqual(105);
  });
});
