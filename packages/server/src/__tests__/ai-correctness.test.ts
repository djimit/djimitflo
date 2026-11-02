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

  it('prices unknown usage as unknown, never at an invented $2/Mtok; dollars only from a dated lease price', () => {
    const database = db();
    const run = (id: string, leaseMeta: Record<string, unknown>) => {
      database.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, completed_at) VALUES (?, 'test', 'closed', 'completed', ?, datetime('now', '-1 hour'), datetime('now'))`)
        .run(id, JSON.stringify({ goal_type: 'docs' }));
      database.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES (?, ?, 'maker', 'codex', 'completed', 'f', '/tmp', ?)`)
        .run(`lease-${id}`, id, JSON.stringify(leaseMeta));
    };
    run('tokens-no-price', { runtime_usage: { total_tokens: 1_000_000 } });
    const svc = new PredictiveAnalyticsService(database);
    const unpriced = svc.predict({ goalType: 'docs', runtime: 'codex', mode: 'closed' });
    expect(unpriced.expectedCostDollars).toBeNull();
    expect(unpriced.expectedCostReason).toBe('no_dated_model_price');
    expect(unpriced.costCoverage).toEqual({ priced: 0, total: 1 });
    run('priced', { runtime_usage: { total_tokens: 500_000 }, token_accounting: { estimated_cost_usd: 0.4, cost_completeness: 'complete', price_version: '2026-10-01' } });
    const priced = svc.predict({ goalType: 'docs', runtime: 'codex', mode: 'closed' });
    expect(priced.expectedCostDollars).toBe(0.4); // the unpriced run is left out, not counted as $0 or $2
    expect(priced.expectedCostReason).toBeNull();
    expect(priced.costCoverage).toEqual({ priced: 1, total: 2 });
    const none = new PredictiveAnalyticsService(db()).predict({ goalType: 'docs', runtime: 'codex', mode: 'closed' });
    expect(none.expectedCostDollars).toBeNull();
    expect(none.expectedCostReason).toBe('no_history');
  });

  it('a dated but partial or mixed-lease cost is no prediction (L-F04 review): unknown with reason partial_price', () => {
    const database = db();
    const run = (id: string, leases: Array<Record<string, unknown>>) => {
      database.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, completed_at) VALUES (?, 'test', 'closed', 'completed', ?, datetime('now', '-1 hour'), datetime('now'))`)
        .run(id, JSON.stringify({ goal_type: 'docs' }));
      leases.forEach((meta, i) => database.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata) VALUES (?, ?, 'maker', 'codex', 'completed', 'f', '/tmp', ?)`)
        .run(`lease-${id}-${i}`, id, JSON.stringify(meta)));
    };
    const dated = (usd: number, completeness: string | undefined) => ({ runtime_usage: { total_tokens: 1000 },
      token_accounting: { estimated_cost_usd: usd, price_version: 'v1', ...(completeness ? { cost_completeness: completeness } : {}) } });
    // cache tokens not priced: maker-token-accounting emits a dated cost with cost_completeness 'partial'
    run('partial-cache', [dated(0.3, 'partial')]);
    // one lease completely priced, its sibling reported tokens without a price
    run('mixed', [dated(0.2, 'complete'), { runtime_usage: { total_tokens: 1000 } }]);
    // a dated cost without completeness is not known to be complete
    run('no-completeness', [dated(0.5, undefined)]);
    const svc = new PredictiveAnalyticsService(database);
    const p = svc.predict({ goalType: 'docs', runtime: 'codex', mode: 'closed' });
    expect(p.expectedCostDollars).toBeNull();
    expect(p.expectedCostReason).toBe('partial_price');
    expect(p.costCoverage).toEqual({ priced: 0, total: 3 });
    run('complete', [dated(0.1, 'complete'), dated(0.3, 'complete')]);
    const q = svc.predict({ goalType: 'docs', runtime: 'codex', mode: 'closed' });
    expect(q.expectedCostDollars).toBe(0.4);
    expect(q.costCoverage).toEqual({ priced: 1, total: 4 });
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
