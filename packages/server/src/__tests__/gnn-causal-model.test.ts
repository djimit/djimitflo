import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { GNNCausalModel } from '../services/gnn-causal-model';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let gnn: GNNCausalModel;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  gnn = new GNNCausalModel(db);
});

afterEach(() => { db?.close(); });

describe('G134: GNN Causal Model', () => {
  it('adds nodes', () => {
    gnn.addNode({ id: 'n1', features: [0.1, 0.2, 0.3], nodeType: 'agent', label: 'Agent 1' });
    const stats = gnn.getGraphStats();
    expect(stats.nodes).toBe(1);
  });

  it('adds edges', () => {
    gnn.addNode({ id: 'n2', features: [0.1], nodeType: 'action', label: 'Action 1' });
    gnn.addNode({ id: 'n3', features: [0.5], nodeType: 'outcome', label: 'Success' });
    gnn.addEdge({ id: 'e1', from: 'n2', to: 'n3', relation: 'causes', weight: 0.9 });
    const stats = gnn.getGraphStats();
    expect(stats.edges).toBe(1);
  });

  it('predicts intervention', () => {
    gnn.addNode({ id: 'n4', features: [0.2], nodeType: 'context', label: 'codex' });
    gnn.addNode({ id: 'n5', features: [0.8], nodeType: 'outcome', label: 'success' });
    gnn.addEdge({ id: 'e2', from: 'n4', to: 'n5', relation: 'leads_to', weight: 0.8 });
    const prediction = gnn.predictIntervention('n4');
    expect(prediction.predictedOutcome).toBeGreaterThanOrEqual(0);
    expect(prediction.predictedOutcome).toBeLessThanOrEqual(1);
  });

  it('learns from observation', () => {
    gnn.learnFromObservation({ runtime: 'codex', capability: 'ts-fix' }, 1.0);
    const stats = gnn.getGraphStats();
    expect(stats.nodes).toBeGreaterThanOrEqual(2);
  });

  it('gets graph stats', () => {
    const stats = gnn.getGraphStats();
    expect(typeof stats.nodes).toBe('number');
    expect(typeof stats.edges).toBe('number');
    expect(typeof stats.density).toBe('number');
  });
});
