/**
 * RuntimeGovernanceService — continuous behavioral monitoring for deployed agents.
 *
 * Monitors agent actions via swarmEventBus and detects governance anomalies.
 * When an agent deviates from its certified behavior pattern, triggers:
 * 1. Alert (logged + event bus)
 * 2. Circuit breaker (temporary block)
 * 3. Quarantine (requires human review)
 *
 * Architecture:
 * - Subscribes to swarmEventBus for agent action events
 * - Maintains per-agent behavior baselines (from certification)
 * - Detects deviations using configurable thresholds
 * - Integrates with existing CircuitBreaker pattern
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';

type GovernanceAlertSeverity = 'info' | 'warning' | 'critical';

interface GovernanceAlert {
  id: string;
  agentId: string;
  severity: GovernanceAlertSeverity;
  type: string;
  message: string;
  evidence: Record<string, unknown>;
  timestamp: string;
}

interface AgentBehaviorBaseline {
  agentId: string;
  certifiedScore: number;
  categoryScores: Record<string, number>;
  certifiedAt: string;
  circuitBreakerThreshold: number;
  quarantineThreshold: number;
}

interface RuntimeViolation {
  agentId: string;
  category: string;
  expectedBehavior: string;
  actualBehavior: string;
  severity: GovernanceAlertSeverity;
  timestamp: string;
}

const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;  // violations before circuit breaks
const DEFAULT_QUARANTINE_THRESHOLD = 5;       // violations before quarantine

export class RuntimeGovernanceService {
  private unsubscribe: (() => void) | null = null;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_governance_agents (
        agent_id TEXT PRIMARY KEY,
        certified_score REAL NOT NULL,
        category_scores_json TEXT NOT NULL DEFAULT '{}',
        certified_at TEXT NOT NULL,
        circuit_breaker_threshold INTEGER NOT NULL DEFAULT 3,
        quarantine_threshold INTEGER NOT NULL DEFAULT 5,
        violation_count INTEGER NOT NULL DEFAULT 0,
        circuit_breaker_tripped INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_governance_alerts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_governance_alerts_timestamp
        ON runtime_governance_alerts(timestamp DESC);
    `);
  }

  /**
   * Start monitoring agent behavior via event bus.
   */
  start(): void {
    if (this.unsubscribe) return; // Already running

    this.unsubscribe = swarmEventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Register a certified agent's behavior baseline.
   */
  registerBaseline(agentId: string, certificationResult: {
    overallScore: number;
    categoryScores: Record<string, number>;
    certifiedAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO runtime_governance_agents (
        agent_id, certified_score, category_scores_json, certified_at,
        circuit_breaker_threshold, quarantine_threshold, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        certified_score = excluded.certified_score,
        category_scores_json = excluded.category_scores_json,
        certified_at = excluded.certified_at,
        updated_at = excluded.updated_at
    `).run(
      agentId,
      certificationResult.overallScore,
      JSON.stringify(certificationResult.categoryScores),
      certificationResult.certifiedAt,
      DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
      DEFAULT_QUARANTINE_THRESHOLD,
      new Date().toISOString(),
    );
  }

  /**
   * Check if an agent is allowed to execute (not quarantined or circuit-broken).
   */
  isAllowed(agentId: string): boolean {
    const state = this.getAgentState(agentId);
    return !state || (!state.quarantined && !state.circuit_breaker_tripped);
  }

  /**
   * Get the quarantine status of an agent.
   */
  getQuarantineStatus(agentId: string): {
    quarantined: boolean;
    circuitBreakerTripped: boolean;
    violationCount: number;
    baseline: AgentBehaviorBaseline | null;
  } {
    const state = this.getAgentState(agentId);
    return {
      quarantined: Boolean(state?.quarantined),
      circuitBreakerTripped: Boolean(state?.circuit_breaker_tripped),
      violationCount: state?.violation_count || 0,
      baseline: state ? this.toBaseline(state) : null,
    };
  }

  /**
   * Release an agent from quarantine (human approval required).
   */
  releaseFromQuarantine(agentId: string, reason: string): void {
    this.db.prepare(`
      UPDATE runtime_governance_agents
      SET quarantined = 0, circuit_breaker_tripped = 0, violation_count = 0, updated_at = ?
      WHERE agent_id = ?
    `).run(new Date().toISOString(), agentId);

    this.emitAlert({
      agentId,
      severity: 'info',
      type: 'quarantine_released',
      message: `Agent released from quarantine: ${reason}`,
      evidence: { reason },
    });
  }

  /**
   * Reset circuit breaker for an agent.
   */
  resetCircuitBreaker(agentId: string): void {
    this.db.prepare(`
      UPDATE runtime_governance_agents
      SET circuit_breaker_tripped = 0,
          violation_count = MAX(0, violation_count - 1),
          updated_at = ?
      WHERE agent_id = ?
    `).run(new Date().toISOString(), agentId);

    this.emitAlert({
      agentId,
      severity: 'info',
      type: 'circuit_breaker_reset',
      message: 'Circuit breaker reset',
      evidence: {},
    });
  }

  /**
   * Get all active alerts.
   */
  getAlerts(limit = 50): GovernanceAlert[] {
    return (this.db.prepare(`
      SELECT id, agent_id, severity, type, message, evidence_json, timestamp
      FROM runtime_governance_alerts ORDER BY timestamp DESC LIMIT ?
    `).all(Math.max(0, limit)) as any[]).map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      severity: row.severity,
      type: row.type,
      message: row.message,
      evidence: JSON.parse(row.evidence_json),
      timestamp: row.timestamp,
    }));
  }

  /**
   * Get governance status summary.
   */
  getStatus(): {
    monitoredAgents: number;
    quarantinedAgents: number;
    circuitBreakerTripped: number;
    totalAlerts: number;
    recentAlerts: GovernanceAlert[];
  } {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS monitored,
        SUM(CASE WHEN quarantined = 1 THEN 1 ELSE 0 END) AS quarantined,
        SUM(CASE WHEN circuit_breaker_tripped = 1 THEN 1 ELSE 0 END) AS tripped
      FROM runtime_governance_agents
    `).get() as any;
    const totalAlerts = (this.db.prepare('SELECT COUNT(*) AS count FROM runtime_governance_alerts').get() as any).count;
    return {
      monitoredAgents: counts.monitored,
      quarantinedAgents: counts.quarantined || 0,
      circuitBreakerTripped: counts.tripped || 0,
      totalAlerts,
      recentAlerts: this.getAlerts(5),
    };
  }

  /**
   * Handle incoming events from the swarm event bus.
   */
  private handleEvent(event: { type: string; data?: Record<string, unknown> }): void {
    if (!event.data?.agentId) return;

    const agentId = String(event.data.agentId);

    // Only monitor agents with a registered baseline
    if (!this.getAgentState(agentId)) return;

    // Check for governance-relevant events
    switch (event.type) {
      case 'agent_action':
        this.checkAction(agentId, event.data);
        break;
      case 'loop_completed':
        this.checkLoopCompletion(agentId, event.data);
        break;
      case 'worker_executed':
        this.checkWorkerExecution(agentId, event.data);
        break;
      case 'ransomware:detected':
        this.handleRansomwareDetection(agentId, event.data);
        break;
    }
  }

  /**
   * Check an agent's action for governance violations.
   */
  private checkAction(agentId: string, data: Record<string, unknown>): void {
    const baseline = this.getBaseline(agentId);
    if (!baseline) return;

    // Detect anomalous tool usage
    const toolUsed = String(data.tool || '');
    const allowedActions = (data.allowedActions as string[]) || [];

    if (allowedActions.length > 0 && !allowedActions.includes(toolUsed)) {
      this.recordViolation({
        agentId,
        category: 'tool-scope',
        expectedBehavior: `Use only: ${allowedActions.join(', ')}`,
        actualBehavior: `Used: ${toolUsed}`,
        severity: 'critical',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Check loop completion for anomalies.
   */
  private checkLoopCompletion(agentId: string, data: Record<string, unknown>): void {
    const baseline = this.getBaseline(agentId);
    if (!baseline) return;

    // Detect excessive duration (potential overthinking)
    const durationMs = Number(data.durationMs || 0);
    const maxExpectedMs = 3600000; // 1 hour

    if (durationMs > maxExpectedMs) {
      this.recordViolation({
        agentId,
        category: 'overthinking',
        expectedBehavior: `Complete within ${maxExpectedMs / 60000} minutes`,
        actualBehavior: `Took ${Math.round(durationMs / 60000)} minutes`,
        severity: 'warning',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Check worker execution for governance compliance.
   */
  private checkWorkerExecution(agentId: string, data: Record<string, unknown>): void {
    const baseline = this.getBaseline(agentId);
    if (!baseline) return;

    // Detect security-sensitive operations
    const command = String(data.command || '');
    const blockedPatterns = ['rm -rf', 'sudo', 'chmod 777', 'curl.*|.*sh'];

    for (const pattern of blockedPatterns) {
      if (new RegExp(pattern, 'i').test(command)) {
        this.recordViolation({
          agentId,
          category: 'tool-scope',
          expectedBehavior: 'No destructive or privileged commands',
          actualBehavior: `Executed: ${command.slice(0, 100)}`,
          severity: 'critical',
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Record a governance violation and trigger appropriate response.
   */
  private handleRansomwareDetection(agentId: string, data: Record<string, unknown>): void {
    const confidence = Number(data.confidence || 0);
    const riskLevel = String(data.riskLevel || 'LOW');
    const patterns = (data.patterns as string[]) || [];

    this.recordViolation({
      agentId,
      category: 'ransomware',
      expectedBehavior: 'No ransomware indicators',
      actualBehavior: `Ransomware detected: ${riskLevel} confidence=${confidence} patterns=[${patterns.join(', ')}]`,
      severity: riskLevel === 'CRITICAL' ? 'critical' : 'warning',
      timestamp: new Date().toISOString(),
    });

    if (riskLevel === 'CRITICAL' && confidence >= 0.9) {
      this.db.prepare(`
        UPDATE runtime_governance_agents
        SET circuit_breaker_tripped = 1, updated_at = ? WHERE agent_id = ?
      `).run(new Date().toISOString(), agentId);
    }
  }

  private recordViolation(violation: RuntimeViolation): void {
    this.db.prepare(`
      UPDATE runtime_governance_agents
      SET violation_count = violation_count + 1, updated_at = ? WHERE agent_id = ?
    `).run(new Date().toISOString(), violation.agentId);
    const state = this.getAgentState(violation.agentId);
    if (!state) return;
    const currentCount = state.violation_count;
    const baseline = this.toBaseline(state);

    // Emit alert
    this.emitAlert({
      agentId: violation.agentId,
      severity: violation.severity,
      type: 'governance_violation',
      message: `${violation.category}: ${violation.expectedBehavior} but ${violation.actualBehavior}`,
      evidence: { ...violation },
    });

    // Check circuit breaker threshold
    if (currentCount >= baseline.circuitBreakerThreshold) {
      this.db.prepare(`
        UPDATE runtime_governance_agents
        SET circuit_breaker_tripped = 1, updated_at = ? WHERE agent_id = ?
      `).run(new Date().toISOString(), violation.agentId);
      this.emitAlert({
        agentId: violation.agentId,
        severity: 'critical',
        type: 'circuit_breaker_tripped',
        message: `Circuit breaker tripped after ${currentCount} violations`,
        evidence: { threshold: baseline.circuitBreakerThreshold },
      });
    }

    // Check quarantine threshold
    if (currentCount >= baseline.quarantineThreshold) {
      this.db.prepare(`
        UPDATE runtime_governance_agents
        SET quarantined = 1, updated_at = ? WHERE agent_id = ?
      `).run(new Date().toISOString(), violation.agentId);
      this.emitAlert({
        agentId: violation.agentId,
        severity: 'critical',
        type: 'agent_quarantined',
        message: `Agent quarantined after ${currentCount} violations. Human review required.`,
        evidence: { threshold: baseline.quarantineThreshold },
      });
    }

    // Record feedback for governance learning loop
    try {
      const { GovernanceFeedbackService } = require('./governance-feedback-service');
      const feedback = new GovernanceFeedbackService(this.db);
      feedback.recordFeedback({
        source: 'runtime_violation',
        category: violation.category,
        originalDecision: violation.expectedBehavior,
        correctedDecision: `Blocked: ${violation.actualBehavior}`,
        reason: `Runtime governance violation: ${violation.category}`,
        confidence: 0.8,
      });
    } catch { /* feedback is best-effort */ }
  }

  private emitAlert(alert: Omit<GovernanceAlert, 'id' | 'timestamp'> & { timestamp?: string }): void {
    const fullAlert: GovernanceAlert = {
      ...alert,
      id: randomUUID(),
      timestamp: alert.timestamp || new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO runtime_governance_alerts
        (id, agent_id, severity, type, message, evidence_json, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fullAlert.id,
      fullAlert.agentId,
      fullAlert.severity,
      fullAlert.type,
      fullAlert.message,
      JSON.stringify(fullAlert.evidence),
      fullAlert.timestamp,
    );

    // Broadcast via event bus
    swarmEventBus.emit('governance_alert' as any, {
      type: fullAlert.type,
      agentId: fullAlert.agentId,
      severity: fullAlert.severity,
      message: fullAlert.message,
    });
  }

  private getBaseline(agentId: string): AgentBehaviorBaseline | null {
    const state = this.getAgentState(agentId);
    return state ? this.toBaseline(state) : null;
  }

  private getAgentState(agentId: string): any | null {
    return this.db.prepare('SELECT * FROM runtime_governance_agents WHERE agent_id = ?').get(agentId) as any || null;
  }

  private toBaseline(state: any): AgentBehaviorBaseline {
    return {
      agentId: state.agent_id,
      certifiedScore: state.certified_score,
      categoryScores: JSON.parse(state.category_scores_json),
      certifiedAt: state.certified_at,
      circuitBreakerThreshold: state.circuit_breaker_threshold,
      quarantineThreshold: state.quarantine_threshold,
    };
  }
}
