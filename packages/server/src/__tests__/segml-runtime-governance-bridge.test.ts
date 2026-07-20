import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlRuntimeGovernanceBridge } from '../services/segml-runtime-governance-bridge';

describe('SegmlRuntimeGovernanceBridge', () => {
  let db: Database.Database;
  let bridge: SegmlRuntimeGovernanceBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlRuntimeGovernanceBridge(db);
  });

  it('tightens monitoring based on blind spots', () => {
    bridge.tightenMonitoring('agent-1', ['injection', 'hallucination']);
    const targets = bridge.getTightenedTargets('agent-1');
    expect(targets.length).toBe(2);
    expect(targets[0].tightenedThreshold).toBe(1.5);
  });

  it('does not duplicate targets for same category', () => {
    bridge.tightenMonitoring('agent-1', ['injection']);
    bridge.tightenMonitoring('agent-1', ['injection']);
    const targets = bridge.getTightenedTargets('agent-1');
    expect(targets.length).toBe(1);
  });

  it('gets unprocessed violations', () => {
    const violations = bridge.getUnprocessedViolations(10);
    expect(violations.length).toBe(0);
  });

  it('marks violations as processed', () => {
    bridge.markProcessed(['nonexistent-id']);
    // Should not throw
  });

  it('reports bridge status', () => {
    const status = bridge.getStatus();
    expect(status.monitoredAgents).toBe(0);
    expect(status.activeTargets).toBe(0);
  });
});
