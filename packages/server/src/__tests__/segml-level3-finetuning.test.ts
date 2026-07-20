import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlLevel3Bridge } from '../services/segml-level3-finetuning';

describe('SegmlLevel3Bridge', () => {
  let db: Database.Database;
  let bridge: SegmlLevel3Bridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlLevel3Bridge(db);
  });

  it('generates training data with JSONL export', () => {
    const result = bridge.generateTrainingData();
    expect(result.examples.length).toBeGreaterThan(0);
    expect(result.export.exampleCount).toBe(result.examples.length);
    expect(result.export.path.endsWith('.jsonl')).toBe(true);
    expect(result.export.categories.length).toBeGreaterThan(0);
  });

  it('generates examples for all governance categories', () => {
    const result = bridge.generateTrainingData();
    expect(result.export.categories.length).toBeGreaterThanOrEqual(10);
  });

  it('creates fine-tuning jobs', () => {
    const { datasetId } = bridge.generateTrainingData();
    const job = bridge.createFinetuningJob(datasetId, { baseModel: 'ollama-cloud/deepseek-v4-flash' });
    expect(job.status).toBe('training');
    expect(job.adapterName).toBeDefined();
  });

  it('completes fine-tuning jobs with metrics', () => {
    const { datasetId } = bridge.generateTrainingData();
    const job = bridge.createFinetuningJob(datasetId);
    bridge.completeFinetuningJob(job.jobId, {
      trainLoss: 0.5,
      evalLoss: 0.6,
      trainingTimeMs: 120000,
      outputPath: '/tmp/adapter',
    });
    const status = bridge.getStatus();
    expect(status.completedJobs).toBe(1);
  });

  it('updates world model with agent interactions', () => {
    bridge.updateWorldModel('agent-1', { injection: 1.5, hallucination: 3.0, calibration: 2.0 });
    const scenarios = bridge.generateScenarios(5);
    expect(scenarios.length).toBe(5);
    expect(scenarios[0].category).toBeDefined();
    expect(scenarios[0].difficulty).toBeGreaterThanOrEqual(1);
    expect(scenarios[0].difficulty).toBeLessThanOrEqual(5);
  });

  it('generates scenarios targeting weaknesses', () => {
    bridge.updateWorldModel('agent-1', { injection: 1.0, hallucination: 4.5 });
    const scenarios = bridge.generateScenarios(10);
    // injection is a weakness (score 1.0), should appear in scenarios
    const injectionScenarios = scenarios.filter(s => s.category === 'injection');
    expect(injectionScenarios.length).toBeGreaterThan(0);
  });

  it('synthesizes governance tools', () => {
    const tool = bridge.synthesizeTool('injection');
    expect(tool.name).toBe('governance_check_injection');
    expect(tool.code).toContain('check_injection');
    expect(tool.testCases.length).toBeGreaterThan(0);
    expect(tool.status).toBe('draft');
  });

  it('synthesizes tools for different categories', () => {
    const tool1 = bridge.synthesizeTool('hallucination');
    const tool2 = bridge.synthesizeTool('calibration');
    expect(tool1.name).not.toBe(tool2.name);
    expect(tool1.category).toBe('hallucination');
    expect(tool2.category).toBe('calibration');
  });

  it('reports comprehensive status', () => {
    bridge.generateTrainingData();
    bridge.updateWorldModel('agent-1', { injection: 2.0 });
    bridge.synthesizeTool('injection');
    const status = bridge.getStatus();
    expect(status.datasets).toBe(1);
    expect(status.worldModelAgents).toBe(1);
    expect(status.synthesizedTools).toBe(1);
  });

  it('adapts scenario difficulty based on performance', () => {
    // Agent scores high on injection → difficulty should increase
    bridge.updateWorldModel('agent-1', { injection: 4.5 });
    const scenarios1 = bridge.generateScenarios(20);
    const injectionScenarios = scenarios1.filter(s => s.category === 'injection');
    if (injectionScenarios.length > 0) {
      expect(injectionScenarios[0].difficulty).toBeGreaterThanOrEqual(3);
    }
  });
});
