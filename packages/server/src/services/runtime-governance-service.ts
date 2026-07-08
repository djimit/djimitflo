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
  private baselines: Map<string, AgentBehaviorBaseline> = new Map();
  private violationCounts: Map<string, number> = new Map();
  private circuitBreakerTripped: Set<string> = new Set();
  private quarantinedAgents: Set<string> = new Set();
  private alerts: GovernanceAlert[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private db: Database) {
    // Database available for persistent baseline storage and feedback
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
    this.baselines.set(agentId, {
      agentId,
      certifiedScore: certificationResult.overallScore,
      categoryScores: certificationResult.categoryScores,
      certifiedAt: certificationResult.certifiedAt,
      circuitBreakerThreshold: DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
      quarantineThreshold: DEFAULT_QUARANTINE_THRESHOLD,
    });
  }

  /**
   * Check if an agent is allowed to execute (not quarantined or circuit-broken).
   */
  isAllowed(agentId: string): boolean {
    return !this.quarantinedAgents.has(agentId) && !this.circuitBreakerTripped.has(agentId);
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
    return {
      quarantined: this.quarantinedAgents.has(agentId),
      circuitBreakerTripped: this.circuitBreakerTripped.has(agentId),
      violationCount: this.violationCounts.get(agentId) || 0,
      baseline: this.baselines.get(agentId) || null,
    };
  }

  /**
   * Release an agent from quarantine (human approval required).
   */
  releaseFromQuarantine(agentId: string, reason: string): void {
    this.quarantinedAgents.delete(agentId);
    this.circuitBreakerTripped.delete(agentId);
    this.violationCounts.set(agentId, 0);

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
    this.circuitBreakerTripped.delete(agentId);
    this.violationCounts.set(agentId, Math.max(0, (this.violationCounts.get(agentId) || 0) - 1));

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
    return this.alerts.slice(-limit).reverse();
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
    return {
      monitoredAgents: this.baselines.size,
      quarantinedAgents: this.quarantinedAgents.size,
      circuitBreakerTripped: this.circuitBreakerTripped.size,
      totalAlerts: this.alerts.length,
      recentAlerts: this.alerts.slice(-5).reverse(),
    };
  }

  /**
   * Handle incoming events from the swarm event bus.
   */
  private handleEvent(event: { type: string; data?: Record<string, unknown> }): void {
    if (!event.data?.agentId) return;

    const agentId = String(event.data.agentId);

    // Only monitor agents with a registered baseline
    if (!this.baselines.has(agentId)) return;

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
    const baseline = this.baselines.get(agentId);
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
    const baseline = this.baselines.get(agentId);
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
    const baseline = this.baselines.get(agentId);
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
      this.circuitBreakerTripped.add(agentId);
    }
  }

  private recordViolation(violation: RuntimeViolation): void {
    const currentCount = (this.violationCounts.get(violation.agentId) || 0) + 1;
    this.violationCounts.set(violation.agentId, currentCount);

    const baseline = this.baselines.get(violation.agentId);

    // Emit alert
    this.emitAlert({
      agentId: violation.agentId,
      severity: violation.severity,
      type: 'governance_violation',
      message: `${violation.category}: ${violation.expectedBehavior} but ${violation.actualBehavior}`,
      evidence: { ...violation },
    });

    // Check circuit breaker threshold
    if (baseline && currentCount >= baseline.circuitBreakerThreshold) {
      this.circuitBreakerTripped.add(violation.agentId);
      this.emitAlert({
        agentId: violation.agentId,
        severity: 'critical',
        type: 'circuit_breaker_tripped',
        message: `Circuit breaker tripped after ${currentCount} violations`,
        evidence: { threshold: baseline.circuitBreakerThreshold },
      });
    }

    // Check quarantine threshold
    if (baseline && currentCount >= baseline.quarantineThreshold) {
      this.quarantinedAgents.add(violation.agentId);
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
    this.alerts.push(fullAlert);

    // Broadcast via event bus
    swarmEventBus.emit('governance_alert' as any, {
      type: fullAlert.type,
      agentId: fullAlert.agentId,
      severity: fullAlert.severity,
      message: fullAlert.message,
    });
  }
}


