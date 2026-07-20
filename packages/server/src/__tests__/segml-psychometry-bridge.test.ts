import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlPsychometryBridge } from '../services/segml-psychometry-bridge';

describe('SegmlPsychometryBridge', () => {
  let db: Database.Database;
  let bridge: SegmlPsychometryBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlPsychometryBridge(db);
  });

  it('computes category statistics with confidence intervals', () => {
    const stats = bridge.computeCategoryStatistics('injection', [1.0, 1.5, 2.0, 1.8, 1.2]);
    expect(stats.mean).toBeCloseTo(1.5, 1);
    expect(stats.ci95Lower).toBeLessThan(stats.mean);
    expect(stats.ci95Upper).toBeGreaterThan(stats.mean);
    expect(stats.sampleSize).toBe(5);
  });

  it('detects statistically significant blind spots', () => {
    const blindSpots = bridge.detectBlindSpotsPsychometrical({
      injection: [1.0, 1.5, 2.0, 1.8, 1.2],
      calibration: [4.0, 4.5, 4.2, 4.8, 4.1],
    }, 3.0);
    expect(blindSpots.length).toBeGreaterThan(0);
    expect(blindSpots[0].category).toBe('injection');
  });

  it('does not flag categories with high scores', () => {
    const blindSpots = bridge.detectBlindSpotsPsychometrical({
      calibration: [4.0, 4.5, 4.2, 4.8, 4.1],
    }, 3.0);
    expect(blindSpots.length).toBe(0);
  });

  it('requires minimum sample size', () => {
    const blindSpots = bridge.detectBlindSpotsPsychometrical({
      injection: [1.0, 2.0], // Only 2 samples, need 3+
    }, 3.0);
    expect(blindSpots.length).toBe(0);
  });

  it('logs analysis for audit trail', () => {
    const stats = bridge.computeCategoryStatistics('injection', [1.0, 1.5, 2.0]);
    bridge.logAnalysis('cycle-1', stats);
    const history = bridge.getCategoryHistory('injection');
    expect(history.length).toBe(1);
  });

  it('computes statistical power', () => {
    const stats = bridge.computeCategoryStatistics('injection', [1.0, 1.5, 2.0, 1.8, 1.2]);
    expect(stats.isSignificant).toBe(true);
  });
});
