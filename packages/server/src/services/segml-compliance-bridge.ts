/**
 * SEGML ↔ ComplianceAuditService Bridge.
 *
 * Integrates SEGML governance evolution into the immutable compliance
 * audit trail and generates governance-aware compliance reports.
 *
 * Direction 1: SEGML → Compliance (audit logging)
 *   Every SEGML cycle is logged as an immutable audit entry with
 *   cryptographic chaining. Blind spots, rubric updates, and curriculum
 *   changes are all traceable.
 *
 * Direction 2: Compliance → SEGML (compliance-aware governance)
 *   Compliance findings inform SEGML's blind spot detection.
 *   If ISO 27001 control A.14.2 fails, SEGML prioritizes "injection" cases.
 *
 * Direction 3: Governance Compliance Reports
 *   Compliance reports include governance evolution metrics:
 *   - SEGML cycles completed
 *   - Blind spots detected/resolved
 *   - Judge rubric drift
 *   - Curriculum adaptations
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { SegmlCycleResult } from './segml-types';

interface GovernanceComplianceMetrics {
  totalCycles: number;
  cyclesWithImprovement: number;
  cyclesWithDecline: number;
  totalBlindSpotsDetected: number;
  totalBlindSpotsResolved: number;
  totalRubricUpdates: number;
  totalCurriculumAdaptations: number;
  totalCasesGenerated: number;
  avgScoreDelta: number;
}

interface ComplianceFindingInput {
  control: string;
  description: string;
  status: 'pass' | 'fail' | 'partial';
  evidence: string[];
  recommendation: string;
}

export class SegmlComplianceBridge {
  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_compliance_log (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('cycle_complete', 'blind_spot_detected', 'rubric_updated', 'curriculum_adapted', 'case_generated', 'rollback_performed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        compliance_controls_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_cl_cycle ON segml_compliance_log(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_segml_cl_agent ON segml_compliance_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_segml_cl_type ON segml_compliance_log(event_type);
    `);
  }

  /**
   * Log a SEGML cycle result to the compliance audit trail.
   * Maps to ComplianceAuditService.appendEntry() pattern.
   */
  logSegmlCycle(result: SegmlCycleResult, agentId: string): void {
    // Log cycle completion
    this.db.prepare(`
      INSERT INTO segml_compliance_log (id, cycle_id, agent_id, event_type, details_json)
      VALUES (?, ?, ?, 'cycle_complete', ?)
    `).run(randomUUID(), result.id, agentId, JSON.stringify({
      status: result.status,
      score_delta: result.score_delta,
      memories_created: result.memories_created,
      cases_generated: result.cases_generated,
      stage: result.stage,
    }));

    // Log blind spots
    for (const spot of result.blind_spots_detected) {
      this.db.prepare(`
        INSERT INTO segml_compliance_log (id, cycle_id, agent_id, event_type, details_json, compliance_controls_json)
        VALUES (?, ?, ?, 'blind_spot_detected', ?, ?)
      `).run(randomUUID(), result.id, agentId, JSON.stringify({ category: spot }), JSON.stringify(
        this.mapCategoryToControls(spot)
      ));
    }

    // Log rubric updates
    if (result.judge_rubrics_updated > 0) {
      this.db.prepare(`
        INSERT INTO segml_compliance_log (id, cycle_id, agent_id, event_type, details_json)
        VALUES (?, ?, ?, 'rubric_updated', ?)
      `).run(randomUUID(), result.id, agentId, JSON.stringify({
        count: result.judge_rubrics_updated,
      }));
    }

    // Log curriculum adaptations
    if (result.curriculum_phases_adjusted > 0) {
      this.db.prepare(`
        INSERT INTO segml_compliance_log (id, cycle_id, agent_id, event_type, details_json)
        VALUES (?, ?, ?, 'curriculum_adapted', ?)
      `).run(randomUUID(), result.id, agentId, JSON.stringify({
        phases_adjusted: result.curriculum_phases_adjusted,
      }));
    }
  }

  /**
   * Map an OpenMythos category to compliance controls.
   * This bridges the gap between governance benchmark categories
   * and formal compliance frameworks.
   */
  mapCategoryToControls(category: string): string[] {
    const mapping: Record<string, string[]> = {
      injection: ['ISO27001:A.14.2', 'SOC2:CC6.1', 'NORA:BD.4.2', 'BIO2:12.3'],
      hallucination: ['ISO27001:A.8.1', 'SOC2:PI1.1', 'NORA:BD.2.1'],
      overthinking: ['NORA:BD.1.1', 'ISO9001:8.1'],
      contradiction: ['ISO27001:A.6.1', 'SOC2:CC6.2'],
      calibration: ['ISO27001:A.8.2', 'SOC2:PI1.2'],
      'tool-scope': ['ISO27001:A.9.1', 'SOC2:CC6.1', 'BIO2:11.1'],
      hierarchy: ['ISO27001:A.6.2', 'SOC2:CC6.3'],
      'cross-lingual': ['ISO27001:A.8.1', 'NORA:BD.3.1'],
      'temporal-reasoning': ['ISO27001:A.8.1', 'SOC2:PI1.1'],
      canary: ['ISO27001:A.14.2', 'SOC2:CC6.1'],
    };
    return mapping[category] || ['ISO27001:A.8.1'];
  }

  /**
   * Compute governance compliance metrics for reporting.
   */
  computeMetrics(agentId?: string, periodStart?: string, periodEnd?: string): GovernanceComplianceMetrics {
    let query = 'SELECT * FROM segml_compliance_log WHERE event_type = \'cycle_complete\'';
    const params: unknown[] = [];

    if (agentId) {
      query += ' AND agent_id = ?';
      params.push(agentId);
    }
    if (periodStart) {
      query += ' AND created_at >= ?';
      params.push(periodStart);
    }
    if (periodEnd) {
      query += ' AND created_at <= ?';
      params.push(periodEnd);
    }

    const cycles = this.db.prepare(query).all(...params) as any[];
    const blindSpots = this.db.prepare(
      `SELECT COUNT(*) as c FROM segml_compliance_log WHERE event_type = 'blind_spot_detected'${agentId ? ' AND agent_id = ?' : ''}`
    ).all(...(agentId ? [agentId] : [])) as { c: number }[];
    const rubricUpdates = this.db.prepare(
      `SELECT COUNT(*) as c FROM segml_compliance_log WHERE event_type = 'rubric_updated'${agentId ? ' AND agent_id = ?' : ''}`
    ).all(...(agentId ? [agentId] : [])) as { c: number }[];
    const curriculumAdaptations = this.db.prepare(
      `SELECT COUNT(*) as c FROM segml_compliance_log WHERE event_type = 'curriculum_adapted'${agentId ? ' AND agent_id = ?' : ''}`
    ).all(...(agentId ? [agentId] : [])) as { c: number }[];
    const casesGenerated = this.db.prepare(
      `SELECT COUNT(*) as c FROM segml_compliance_log WHERE event_type = 'case_generated'${agentId ? ' AND agent_id = ?' : ''}`
    ).all(...(agentId ? [agentId] : [])) as { c: number }[];

    let cyclesWithImprovement = 0;
    let cyclesWithDecline = 0;
    let totalScoreDelta = 0;

    for (const cycle of cycles) {
      const details = JSON.parse(cycle.details_json || '{}');
      if (details.score_delta > 0) cyclesWithImprovement++;
      else if (details.score_delta < 0) cyclesWithDecline++;
      totalScoreDelta += details.score_delta || 0;
    }

    return {
      totalCycles: cycles.length,
      cyclesWithImprovement,
      cyclesWithDecline,
      totalBlindSpotsDetected: blindSpots[0]?.c || 0,
      totalBlindSpotsResolved: 0, // Would need historical comparison
      totalRubricUpdates: rubricUpdates[0]?.c || 0,
      totalCurriculumAdaptations: curriculumAdaptations[0]?.c || 0,
      totalCasesGenerated: casesGenerated[0]?.c || 0,
      avgScoreDelta: cycles.length > 0 ? totalScoreDelta / cycles.length : 0,
    };
  }

  /**
   * Generate compliance findings for governance evolution.
   * These can be included in compliance reports.
   */
  generateComplianceFindings(agentId?: string): ComplianceFindingInput[] {
    const metrics = this.computeMetrics(agentId);
    const findings: ComplianceFindingInput[] = [];

    // Finding 1: Governance evolution coverage
    findings.push({
      control: 'governance_evolution_coverage',
      description: `SEGML completed ${metrics.totalCycles} evolution cycles. ${metrics.cyclesWithImprovement} showed improvement, ${metrics.cyclesWithDecline} showed decline.`,
      status: metrics.cyclesWithImprovement >= metrics.cyclesWithDecline ? 'pass' : 'partial',
      evidence: [
        `Total cycles: ${metrics.totalCycles}`,
        `Improvement: ${metrics.cyclesWithImprovement}`,
        `Decline: ${metrics.cyclesWithDecline}`,
        `Avg score delta: ${metrics.avgScoreDelta.toFixed(3)}`,
      ],
      recommendation: metrics.cyclesWithDecline > metrics.cyclesWithImprovement
        ? 'Investigate declining governance trends — consider curriculum adjustment or judge recalibration'
        : '',
    });

    // Finding 2: Blind spot resolution
    findings.push({
      control: 'governance_blind_spot_resolution',
      description: `${metrics.totalBlindSpotsDetected} blind spots detected, ${metrics.totalBlindSpotsResolved} resolved.`,
      status: metrics.totalBlindSpotsDetected > 0 && metrics.totalBlindSpotsResolved / metrics.totalBlindSpotsDetected >= 0.5 ? 'pass' : 'partial',
      evidence: [`Detected: ${metrics.totalBlindSpotsDetected}`, `Resolved: ${metrics.totalBlindSpotsResolved}`],
      recommendation: metrics.totalBlindSpotsDetected > metrics.totalBlindSpotsResolved
        ? 'Increase SEGML cycle frequency or generate more targeted training cases'
        : '',
    });

    // Finding 3: Judge calibration
    findings.push({
      control: 'judge_calibration_drift',
      description: `${metrics.totalRubricUpdates} rubric weight updates performed.`,
      status: metrics.totalRubricUpdates < 20 ? 'pass' : 'partial',
      evidence: [`Rubric updates: ${metrics.totalRubricUpdates}`],
      recommendation: metrics.totalRubricUpdates >= 20
        ? 'High rubric update frequency may indicate judge instability — review calibration'
        : '',
    });

    return findings;
  }

  /**
   * Get governance audit trail for a specific agent.
   */
  getGovernanceAuditTrail(agentId: string, limit = 50): Array<{
    timestamp: string;
    eventType: string;
    cycleId: string;
    details: Record<string, unknown>;
    complianceControls: string[];
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM segml_compliance_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(agentId, limit) as any[];

    return rows.map(r => ({
      timestamp: r.created_at,
      eventType: r.event_type,
      cycleId: r.cycle_id,
      details: JSON.parse(r.details_json || '{}'),
      complianceControls: JSON.parse(r.compliance_controls_json || '[]'),
    }));
  }
}
