import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlComplianceBridge } from '../services/segml-compliance-bridge';
import type { SegmlCycleResult } from '../services/segml-types';

describe('SegmlComplianceBridge', () => {
  let db: Database.Database;
  let bridge: SegmlComplianceBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlComplianceBridge(db);
  });

  const mockResult: SegmlCycleResult = {
    id: 'cycle-1',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    status: 'completed',
    stage: 'completed',
    eval_run_id: 'run-1',
    memories_created: 3,
    memories_consolidated: 1,
    cases_generated: 5,
    rules_updated: 2,
    judge_rubrics_updated: 1,
    curriculum_phases_adjusted: 1,
    score_delta: 0.3,
    blind_spots_detected: ['injection', 'hallucination'],
    errors: [],
  };

  it('logs SEGML cycle to compliance audit trail', () => {
    bridge.logSegmlCycle(mockResult, 'agent-1');
    const trail = bridge.getGovernanceAuditTrail('agent-1');
    expect(trail.length).toBeGreaterThan(0);
  });

  it('maps categories to compliance controls', () => {
    const controls = bridge.mapCategoryToControls('injection');
    expect(controls.length).toBeGreaterThan(0);
    expect(controls[0]).toContain('ISO27001');
  });

  it('computes governance compliance metrics', () => {
    bridge.logSegmlCycle(mockResult, 'agent-1');
    const metrics = bridge.computeMetrics('agent-1');
    expect(metrics.totalCycles).toBe(1);
    expect(metrics.totalBlindSpotsDetected).toBe(2);
  });

  it('generates compliance findings', () => {
    bridge.logSegmlCycle(mockResult, 'agent-1');
    const findings = bridge.generateComplianceFindings('agent-1');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].control).toBe('governance_evolution_coverage');
  });

  it('returns empty audit trail for unknown agent', () => {
    const trail = bridge.getGovernanceAuditTrail('unknown');
    expect(trail.length).toBe(0);
  });
});
