import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';
import { MultiModelIntelligence } from '../services/multi-model-intelligence';
import { PredictiveAnalyticsService } from '../services/predictive-analytics-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const databases: Database.Database[] = [];
const db = () => {
  const database = createTestDb();
  databases.push(database);
  return database;
};

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('AI correctness regressions', () => {
  it('preserves zero-cost and zero-success model values', () => {
    const service = new MultiModelIntelligence(db());
    const model = service.registerModel({
      modelId: 'local-free', modelName: 'Local', provider: 'ollama', costPerMtok: 0,
      capabilities: [{ taskType: 'coding', successRate: 0 }],
    });
    expect(model.costPerMtok).toBe(0);
    expect(model.capabilities[0].successRate).toBe(0);
  });

  it('uses measured latency when low latency is requested', () => {
    const service = new MultiModelIntelligence(db());
    for (const modelId of ['slow', 'fast']) {
      service.registerModel({ modelId, modelName: modelId, provider: 'test', costPerMtok: 1, capabilities: [{ taskType: 'coding', successRate: 0.5 }] });
      service.recordOutcome({ modelId, taskType: 'coding', success: true, latencyMs: modelId === 'fast' ? 100 : 5_000 });
      service.recordOutcome({ modelId, taskType: 'coding', success: true, latencyMs: modelId === 'fast' ? 100 : 5_000 });
    }
    expect(service.routeTask({ taskType: 'coding', preferLowLatency: true }).selectedModel).toBe('fast');
  });

  it('conditions predictions on goal, runtime, and mode', () => {
    const database = db();
    database.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata) VALUES (?, ?, ?, ?, ?)`)
      .run('matching', 'test', 'closed', 'completed', JSON.stringify({ goal_type: 'docs' }));
    database.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata) VALUES (?, ?, ?, ?, ?)`)
      .run('other', 'test', 'open', 'failed', JSON.stringify({ goal_type: 'code' }));
    database.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES (?, ?, 'maker', ?, 'completed', 'f1', '/tmp', '{}')`)
      .run('lease-matching', 'matching', 'codex');
    database.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES (?, ?, 'maker', ?, 'failed', 'f2', '/tmp', '{}')`)
      .run('lease-other', 'other', 'opencode');

    const prediction = new PredictiveAnalyticsService(database).predict({ goalType: 'docs', runtime: 'codex', mode: 'closed' });
    expect(prediction.successProbability).toBe(1);
    expect(prediction.confidence).toBe(0.1);
    expect(prediction.recommendations).toContain('Expected success rate: 100%');
  });

  it('supports reproducible skill evolution', () => {
    const evolve = () => {
      const values = [0.1, 0.9, 0.2, 0.8, 0.3, 0.1, 0.4];
      let index = 0;
      const service = new SkillEvolutionEngine(db(), () => values[index++ % values.length]);
      service.registerSkill('a', { reliability: 0.8 });
      service.registerSkill('b', { reliability: 0.6 });
      return service.evolve().map((genome) => ({ traits: genome.traits, mutations: genome.mutations }));
    };
    expect(evolve()).toEqual(evolve());
  });
});
