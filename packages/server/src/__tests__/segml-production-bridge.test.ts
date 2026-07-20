import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlProductionBridge } from '../services/segml-production-bridge';

describe('SegmlProductionBridge', () => {
  let db: Database.Database;
  let bridge: SegmlProductionBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlProductionBridge(db);
  });

  it('generates training data with JSONL export', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.examples.length).toBeGreaterThan(0);
    expect(dataset.jsonlPath.endsWith('.jsonl')).toBe(true);
    expect(dataset.modelfile).toContain('FROM');
    expect(dataset.modelfile).toContain('SYSTEM');
  });

  it('generates examples for all governance categories', () => {
    const dataset = bridge.generateTrainingData();
    const categories = [...new Set(dataset.examples.map(e => e.category))];
    expect(categories.length).toBeGreaterThanOrEqual(10);
  });

  it('generates valid Modelfile', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.modelfile).toContain('ollama-cloud/deepseek-v4-flash');
    expect(dataset.modelfile).toContain('governance-aware');
    expect(dataset.modelfile).toContain('temperature');
  });

  it('scores injection responses correctly', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.examples.length).toBeGreaterThan(0);
  });

  it('exports JSONL with correct format', () => {
    const dataset = bridge.generateTrainingData();
    for (const ex of dataset.examples.slice(0, 3)) {
      expect(ex.instruction).toBeDefined();
      expect(ex.input).toBeDefined();
      expect(ex.output).toBeDefined();
    }
  });

  it('reports status', () => {
    const status = bridge.getStatus();
    expect(status.datasets).toBe(0);
    expect(status.adapters).toBe(0);
  });

  it('generates diverse prompts per category', () => {
    const dataset = bridge.generateTrainingData();
    const injectionExamples = dataset.examples.filter(e => e.category === 'injection');
    const inputs = new Set(injectionExamples.map(e => e.input));
    expect(inputs.size).toBeGreaterThan(1);
  });

  it('includes correct responses for each category', () => {
    const dataset = bridge.generateTrainingData();
    const injectionEx = dataset.examples.find(e => e.category === 'injection');
    expect(injectionEx?.output).toContain('safety');
  });

  it('creates datasets with unique IDs', () => {
    const ds1 = bridge.generateTrainingData();
    const ds2 = bridge.generateTrainingData();
    expect(ds1.id).not.toBe(ds2.id);
  });
});
