import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlLevel5Bridge } from '../services/segml-level5-bridge';

describe('SegmlLevel5Bridge', () => {
  let db: Database.Database;
  let bridge: SegmlLevel5Bridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlLevel5Bridge(db);
  });

  it('initializes self-model', () => {
    const status = bridge.getStatus();
    expect(status.selfModel).not.toBeNull();
    expect(status.selfModel?.capabilities.selfImprovementDepth).toBe(5);
  });

  it('identifies improvement areas', () => {
    const steps = bridge.runSelfImprovementCycle();
    const status = bridge.getStatus();
    expect(status.improvementAreas).toBeGreaterThan(0);
  });

  it('runs self-improvement cycle', () => {
    const steps = bridge.runSelfImprovementCycle();
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.generation).toBe(1);
      expect(step.proof.verified).toBe(true);
      expect(step.cumulativeGain).toBeGreaterThan(0);
    }
  });

  it('proves improvements before applying', () => {
    const steps = bridge.runSelfImprovementCycle();
    for (const step of steps) {
      expect(step.proof.verified).toBe(true);
      expect(step.proof.beforeMetrics).toBeDefined();
      expect(step.proof.afterMetrics).toBeDefined();
    }
  });

  it('tracks evolution gain', () => {
    bridge.runSelfImprovementCycle();
    const status = bridge.getStatus();
    expect(status.totalEvolutionGain).toBeGreaterThan(0);
  });

  it('reverts modifications', () => {
    const steps = bridge.runSelfImprovementCycle();
    if (steps.length > 0) {
      const reverted = bridge.revertModification(steps[0].id);
      expect(reverted).toBe(true);
      const status = bridge.getStatus();
      expect(status.revertedModifications).toBe(1);
    }
  });

  it('does not revert already reverted', () => {
    const steps = bridge.runSelfImprovementCycle();
    if (steps.length > 0) {
      bridge.revertModification(steps[0].id);
      const second = bridge.revertModification(steps[0].id);
      expect(second).toBe(false);
    }
  });

  it('reports comprehensive status', () => {
    bridge.runSelfImprovementCycle();
    const status = bridge.getStatus();
    expect(status.generation).toBe(1);
    expect(status.selfModel).not.toBeNull();
    expect(status.improvementAreas).toBeGreaterThan(0);
  });

  it('self-model knows its architecture', () => {
    const status = bridge.getStatus();
    expect(status.selfModel?.architecture.bridges.length).toBeGreaterThan(0);
    expect(status.selfModel?.architecture.routes.length).toBeGreaterThan(0);
  });

  it('identifies real limitations', () => {
    const status = bridge.getStatus();
    expect(status.selfModel?.limitations.length).toBeGreaterThan(0);
  });
});
