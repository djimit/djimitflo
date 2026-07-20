import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlWorldModelBridge } from '../services/segml-world-model-bridge';

describe('SegmlWorldModelBridge', () => {
  let db: Database.Database;
  let bridge: SegmlWorldModelBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlWorldModelBridge(db);
  });

  it('seeds default simulation scenarios', () => {
    const status = bridge.getStatus();
    expect(status.totalScenarios).toBeGreaterThanOrEqual(12);
  });

  it('builds governance profile for unknown agent', () => {
    const profile = bridge.buildGovernanceProfile('unknown-agent');
    expect(profile.agentId).toBe('unknown-agent');
    expect(profile.overallScore).toBe(0);
    expect(profile.trendDirection).toBe('stable');
  });

  it('runs simulation and produces a report', () => {
    const report = bridge.runSimulation('agent-1');
    expect(report.agentId).toBe('agent-1');
    expect(report.scenariosRun).toBeGreaterThan(0);
    expect(['approved', 'warning', 'blocked']).toContain(report.deploymentGate);
  });

  it('blocks deployment for low governance agents', () => {
    // Agent with no eval data gets score 0 → should be blocked
    const report = bridge.runSimulation('new-agent');
    expect(report.deploymentGate).toBe('blocked');
    expect(report.scenariosFailed).toBeGreaterThan(0);
    expect(report.predictedOverallScore).toBeLessThan(2.5);
  });

  it('gets latest report for an agent', () => {
    bridge.runSimulation('agent-1');
    const latest = bridge.getLatestReport('agent-1');
    expect(latest).not.toBeNull();
    expect(latest?.agentId).toBe('agent-1');
  });

  it('returns null for unknown agent', () => {
    const latest = bridge.getLatestReport('unknown');
    expect(latest).toBeNull();
  });

  it('generates recommendations', () => {
    const report = bridge.runSimulation('agent-1');
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('reports world model status', () => {
    bridge.runSimulation('agent-1');
    const status = bridge.getStatus();
    expect(status.totalReports).toBe(1);
    expect(status.totalScenarios).toBeGreaterThan(0);
  });
});
