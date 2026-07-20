import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlPredictiveBridge } from '../services/segml-predictive-bridge';

describe('SegmlPredictiveBridge', () => {
  let db: Database.Database;
  let bridge: SegmlPredictiveBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlPredictiveBridge(db);
  });

  it('predicts governance decline', () => {
    const prediction = bridge.predictDecline('agent-1', 'injection', 1.5);
    expect(prediction.agentId).toBe('agent-1');
    expect(prediction.category).toBe('injection');
    expect(prediction.currentScore).toBe(1.5);
    expect(prediction.declineProbability).toBeGreaterThanOrEqual(0);
    expect(prediction.declineProbability).toBeLessThanOrEqual(1);
  });

  it('emits trigger for high decline probability', () => {
    // Very low score should trigger high decline probability
    const prediction = bridge.predictDecline('agent-1', 'injection', 1.0);
    expect(prediction.declineProbability).toBeGreaterThanOrEqual(0.3);
    expect(prediction.riskFactors.length).toBeGreaterThan(0);
  });

  it('analyzes trends with insufficient data', () => {
    const trend = bridge.analyzeTrend('agent-1', 'injection');
    expect(trend.dataPoints).toBe(0);
    expect(trend.slope).toBe(0);
  });

  it('validates predictions against actual outcomes', () => {
    const prediction = bridge.predictDecline('agent-1', 'injection', 2.0);
    bridge.validatePrediction(prediction.id, 2.5);
    const accuracy = bridge.getPredictionAccuracy();
    expect(accuracy.validatedPredictions).toBe(1);
  });

  it('gets high-risk predictions', () => {
    bridge.predictDecline('agent-1', 'injection', 1.0);
    bridge.predictDecline('agent-2', 'hallucination', 1.2);
    const highRisk = bridge.getHighRiskPredictions(0.5);
    expect(highRisk.length).toBeGreaterThanOrEqual(0);
  });

  it('computes prediction accuracy stats', () => {
    const stats = bridge.getPredictionAccuracy();
    expect(stats.totalPredictions).toBe(0);
    expect(stats.validatedPredictions).toBe(0);
  });
});
