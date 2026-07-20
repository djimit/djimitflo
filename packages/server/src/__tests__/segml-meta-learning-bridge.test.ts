import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlMetaLearningBridge } from '../services/segml-meta-learning-bridge';

describe('SegmlMetaLearningBridge', () => {
  let db: Database.Database;
  let bridge: SegmlMetaLearningBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlMetaLearningBridge(db);
  });

  it('initializes with default configuration', () => {
    const config = bridge.getCurrentConfig();
    expect(config.failure_threshold).toBeGreaterThan(0);
    expect(config.min_cases_for_pattern).toBeGreaterThan(0);
  });

  it('records performance for meta-learning', () => {
    bridge.recordPerformance('cycle-1', 0.3);
    bridge.recordPerformance('cycle-2', -0.1);
    const status = bridge.getStatus();
    expect(status.performanceHistoryLength).toBe(2);
  });

  it('adapts configuration after 5 cycles', () => {
    // Record 5 declining performances
    for (let i = 0; i < 5; i++) {
      bridge.recordPerformance(`cycle-${i}`, -0.2);
    }
    const status = bridge.getStatus();
    expect(status.adaptationCount).toBeGreaterThan(0);
  });

  it('reverts last change', () => {
    for (let i = 0; i < 5; i++) {
      bridge.recordPerformance(`cycle-${i}`, -0.3);
    }
    const reverted = bridge.revertLastChange();
    expect(reverted).toBe(true);
    const status = bridge.getStatus();
    expect(status.revertedChanges).toBe(1);
  });

  it('respects parameter bounds', () => {
    // Record many declining cycles to push adaptation
    for (let i = 0; i < 20; i++) {
      bridge.recordPerformance(`cycle-${i}`, -0.5);
    }
    const config = bridge.getCurrentConfig();
    expect(config.failure_threshold).toBeGreaterThanOrEqual(1.0);
    expect(config.failure_threshold).toBeLessThanOrEqual(4.0);
  });

  it('reports meta-learning status', () => {
    const status = bridge.getStatus();
    expect(status.totalChanges).toBe(0);
    expect(status.adaptationCount).toBe(0);
  });
});
