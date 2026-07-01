import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CognitiveMemoryService } from '../services/cognitive-memory-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let memory: CognitiveMemoryService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  memory = new CognitiveMemoryService(db);
});

afterEach(() => {
  db?.close();
});

describe('G53: Cognitive Memory Patterns', () => {
  it('stores a skill', () => {
    const skill = memory.storeSkill('fix typescript errors', { step: 1, action: 'analyze' });
    expect(skill.id).toBeDefined();
    expect(skill.intentEmbedding).toBe('fix typescript errors');
  });

  it('retrieves skills by intent', () => {
    memory.storeSkill('fix typescript errors', { step: 1 });
    memory.storeSkill('fix python errors', { step: 2 });
    const results = memory.retrieveSkills('typescript', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('recordSuccess increments count', () => {
    const skill = memory.storeSkill('test', {});
    memory.recordSuccess(skill.id);
    const stats = memory.getSkillStats(skill.id);
    expect(stats.success).toBe(1);
  });

  it('recordFailure increments count', () => {
    const skill = memory.storeSkill('test', {});
    memory.recordFailure(skill.id);
    const stats = memory.getSkillStats(skill.id);
    expect(stats.fail).toBe(1);
  });

  it('records causal edge', () => {
    memory.recordCausalEdge('rain', 'wet_ground', 0.9);
    const edges = memory.explainCausation('rain');
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('updates causal edge strength on duplicate', () => {
    memory.recordCausalEdge('cause', 'effect', 0.8);
    memory.recordCausalEdge('cause', 'effect', 0.6);
    const edges = memory.explainCausation('cause');
    expect(edges.length).toBe(1);
  });

  it('getSkillStats returns rate', () => {
    const skill = memory.storeSkill('rate-test', {});
    memory.recordSuccess(skill.id);
    memory.recordSuccess(skill.id);
    memory.recordFailure(skill.id);
    const stats = memory.getSkillStats(skill.id);
    expect(stats.rate).toBeCloseTo(0.67, 1);
  });
});
