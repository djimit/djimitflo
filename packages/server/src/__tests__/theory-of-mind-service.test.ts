import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TheoryOfMindService } from '../services/theory-of-mind-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let tom: TheoryOfMindService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tom = new TheoryOfMindService(db);
});

afterEach(() => {
  db?.close();
});

describe('G61: Theory of Mind', () => {
  it('models agent intent from observations', () => {
    const model = tom.modelAgentIntent('agent-1', ['fix errors', 'run tests']);
    expect(model.agentId).toBe('agent-1');
    expect(model.confidence).toBeGreaterThan(0);
    expect(model.observationCount).toBe(2);
  });

  it('extracts beliefs from observations', () => {
    const model = tom.modelAgentIntent('agent-2', ['task has errors', 'testing required']);
    expect(model.beliefs.length).toBeGreaterThan(0);
  });

  it('extracts goals from observations', () => {
    const model = tom.modelAgentIntent('agent-3', ['fix issues', 'improve quality']);
    expect(model.goals).toContain('fix_issues');
  });

  it('predicts action for unknown agent', () => {
    const action = tom.predictAgentAction('unknown-agent');
    expect(action).toBe('unknown');
  });

  it('predicts action based on model', () => {
    tom.modelAgentIntent('agent-4', ['write code', 'fix bugs']);
    const action = tom.predictAgentAction('agent-4');
    expect(action).toBeDefined();
  });

  it('updateModel adjusts confidence on correct prediction', () => {
    tom.modelAgentIntent('agent-5', ['write code']);
    const before = tom.getIntentModel('agent-5');
    tom.updateModel('agent-5', before!.plannedActions[0] || 'write_code');
    const after = tom.getIntentModel('agent-5');
    expect(after!.confidence).toBeGreaterThanOrEqual(before!.confidence);
  });

  it('getIntentModel returns null for unknown', () => {
    expect(tom.getIntentModel('nonexistent')).toBeNull();
  });

  it('getAllModels returns all', () => {
    tom.modelAgentIntent('a1', ['obs1']);
    tom.modelAgentIntent('a2', ['obs2']);
    const models = tom.getAllModels();
    expect(models.length).toBe(2);
  });

  it('confidence increases with more observations', () => {
    const m1 = tom.modelAgentIntent('agent-6', ['obs1']);
    const m2 = tom.modelAgentIntent('agent-6', ['obs2', 'obs3', 'obs4', 'obs5', 'obs6', 'obs7', 'obs8', 'obs9', 'obs10']);
    expect(m2.confidence).toBeGreaterThan(m1.confidence);
  });
});
