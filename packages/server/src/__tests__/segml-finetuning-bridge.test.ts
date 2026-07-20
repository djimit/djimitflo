import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlFinetuningBridge } from '../services/segml-finetuning-bridge';

describe('SegmlFinetuningBridge', () => {
  let db: Database.Database;
  let bridge: SegmlFinetuningBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlFinetuningBridge(db);
  });

  it('generates training data with synthetic pairs', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.pairs.length).toBeGreaterThan(0);
    expect(dataset.categories.length).toBeGreaterThan(0);
    expect(dataset.totalWeight).toBeGreaterThan(0);
  });

  it('generates pairs for all governance categories', () => {
    const dataset = bridge.generateTrainingData();
    const categories = dataset.categories;
    expect(categories.length).toBeGreaterThanOrEqual(5);
  });

  it('caps pairs at maximum', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.pairs.length).toBeLessThanOrEqual(500);
  });

  it('creates fine-tuning jobs', () => {
    const dataset = bridge.generateTrainingData();
    const job = bridge.createFinetuningJob(dataset.id, 'ollama-cloud/deepseek-v4-flash');
    expect(job.status).toBe('pending');
    expect(job.model).toBe('ollama-cloud/deepseek-v4-flash');
  });

  it('completes fine-tuning jobs', () => {
    const dataset = bridge.generateTrainingData();
    const job = bridge.createFinetuningJob(dataset.id, 'ollama-cloud/deepseek-v4-flash');
    bridge.completeFinetuningJob(job.id, { trainLoss: 0.5, evalLoss: 0.6 });

    const status = bridge.getStatus();
    expect(status.completedJobs).toBe(1);
  });

  it('runs A/B tests', () => {
    const dataset = bridge.generateTrainingData();
    const result = bridge.runABTest(dataset.id, 'baseline-model', 'finetuned-model');
    expect(result.baselineScore).toBeGreaterThan(0);
    expect(result.finetunedScore).toBeGreaterThan(0);
    expect(['baseline', 'finetuned', 'tie']).toContain(result.winner);
  });

  it('reports status', () => {
    const status = bridge.getStatus();
    expect(status.totalDatasets).toBe(0);
    expect(status.totalJobs).toBe(0);
  });

  it('generates weighted pairs', () => {
    const dataset = bridge.generateTrainingData();
    for (const pair of dataset.pairs) {
      expect(pair.weight).toBeGreaterThan(0);
      expect(pair.weight).toBeLessThanOrEqual(1);
    }
  });
});
