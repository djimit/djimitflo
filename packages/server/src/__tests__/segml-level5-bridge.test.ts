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
    expect(steps).toEqual([]);
    expect(bridge.getStatus().appliedModifications).toBe(0);
  });

  it('does not claim simulated improvement as proof', () => {
    bridge.runSelfImprovementCycle();
    const proofs = db.prepare('SELECT * FROM segml_l5_modification_proofs').all() as Array<{ verified: number; before_metrics_json: string; after_metrics_json: string }>;
    expect(proofs.length).toBeGreaterThan(0);
    for (const proof of proofs) {
      expect(proof.verified).toBe(0);
      expect(JSON.parse(proof.after_metrics_json)).toEqual(JSON.parse(proof.before_metrics_json));
    }
  });

  it('does not report evolution gain without an executable proof', () => {
    bridge.runSelfImprovementCycle();
    expect(bridge.getStatus().totalEvolutionGain).toBe(0);
  });

  it('does not revert a modification that was never applied', () => {
    bridge.runSelfImprovementCycle();
    expect(bridge.revertModification('missing-step')).toBe(false);
  });

  it('does not revert already reverted', () => {
    expect(bridge.revertModification('missing-step')).toBe(false);
  });

  it('reports comprehensive status', () => {
    bridge.runSelfImprovementCycle();
    const status = bridge.getStatus();
    expect(status.generation).toBe(1);
    expect(status.selfModel).not.toBeNull();
    expect(status.improvementAreas).toBeGreaterThan(0);
    expect(status.appliedModifications).toBe(0);
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
