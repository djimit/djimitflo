import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CausalWorldModelService } from '../services/causal-world-model-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let model: CausalWorldModelService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  model = new CausalWorldModelService(db);
});

afterEach(() => {
  db?.close();
});

describe('G63: Causal World Model', () => {
  it('learns from positive outcome', () => {
    model.learnFromOutcome('codex', 'ts-fix-success', true);
    const edges = model.getCausalEdges('codex');
    expect(edges.length).toBe(1);
    expect(edges[0].strength).toBeGreaterThan(0.5);
  });

  it('learns from negative outcome', () => {
    model.learnFromOutcome('codex', 'ts-fix-fail', false);
    const edges = model.getCausalEdges('codex');
    expect(edges[0].strength).toBeLessThan(0.5);
  });

  it('updates strength with more evidence', () => {
    model.learnFromOutcome('codex', 'success', true);
    model.learnFromOutcome('codex', 'success', true);
    model.learnFromOutcome('codex', 'success', true);
    const edges = model.getCausalEdges('codex');
    expect(edges[0].evidence).toBe(3);
    expect(edges[0].strength).toBeGreaterThan(0.7);
  });

  it('predictIntervention returns query', () => {
    model.learnFromOutcome('codex', 'success', true);
    const query = model.predictIntervention({ codex: 'true' }, 'success');
    expect(query.predictedProbability).toBeGreaterThan(0);
    expect(query.confidence).toBeGreaterThan(0);
  });

  it('predictCounterfactual returns result', () => {
    model.learnFromOutcome('codex', 'success', true);
    model.learnFromOutcome('opencode', 'success', false);
    const result = model.predictCounterfactual(
      { runtime: 'codex' },
      { runtime: 'opencode' },
      'success'
    );
    expect(result.predictedOutcome).toBeDefined();
    expect(result.probability).toBeGreaterThanOrEqual(0);
  });

  it('getCausalEdges returns both directions', () => {
    model.learnFromOutcome('A', 'B', true);
    const edgesA = model.getCausalEdges('A');
    const edgesB = model.getCausalEdges('B');
    expect(edgesA.length).toBe(1);
    expect(edgesB.length).toBe(1);
  });

  it('getStrongestCauses returns sorted', () => {
    model.learnFromOutcome('strong', 'effect', true);
    model.learnFromOutcome('weak', 'effect', false);
    const causes = model.getStrongestCauses('effect', 5);
    expect(causes.length).toBe(2);
    expect(causes[0].cause).toBe('strong');
  });

  it('getModelSize returns counts', () => {
    model.learnFromOutcome('A', 'B', true);
    model.learnFromOutcome('C', 'D', false);
    const size = model.getModelSize();
    expect(size.edges).toBe(2);
    expect(size.observations).toBe(2);
  });

  it('strength converges with many observations', () => {
    for (let i = 0; i < 100; i++) {
      model.learnFromOutcome('codex', 'success', i < 80);
    }
    const edges = model.getCausalEdges('codex');
    expect(edges[0].strength).toBeGreaterThan(0.7);
    expect(edges[0].strength).toBeLessThan(0.9);
  });

  it('prediction confidence increases with evidence', () => {
    model.learnFromOutcome('codex', 'success', true);
    const lowConf = model.predictIntervention({ codex: 'true' }, 'success');
    for (let i = 0; i < 20; i++) model.learnFromOutcome('codex', 'success', true);
    const highConf = model.predictIntervention({ codex: 'true' }, 'success');
    expect(highConf.confidence).toBeGreaterThan(lowConf.confidence);
  });

  it('handles unknown cause gracefully', () => {
    const query = model.predictIntervention({ unknown: 'true' }, 'success');
    expect(query.confidence).toBeLessThan(0.2);
  });

  it('multiple causes combine', () => {
    model.learnFromOutcome('codex', 'success', true);
    model.learnFromOutcome('good-prompt', 'success', true);
    const causes = model.getStrongestCauses('success', 5);
    expect(causes.length).toBe(2);
  });

  it('counterfactual log is persisted', () => {
    model.learnFromOutcome('codex', 'success', true);
    model.predictCounterfactual({ r: 'codex' }, { r: 'opencode' }, 'success');
    const log = db.prepare('SELECT COUNT(*) as c FROM counterfactual_log').get() as { c: number };
    expect(log.c).toBe(1);
  });

  it('evidence count tracks correctly', () => {
    for (let i = 0; i < 5; i++) model.learnFromOutcome('X', 'Y', true);
    const edges = model.getCausalEdges('X');
    expect(edges[0].evidence).toBe(5);
  });
});
