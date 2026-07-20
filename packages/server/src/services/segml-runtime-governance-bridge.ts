/**
 * SEGML ↔ RuntimeGovernanceService Bridge.
 *
 * Bidirectional coupling between SEGML (eval-time governance) and
 * RuntimeGovernanceService (runtime governance).
 *
 * Direction 1: Runtime violations → SEGML trigger
 *   When runtime governance detects violations, it can trigger an
 *   immediate SEGML cycle to update judge rubrics and curriculum.
 *
 * Direction 2: SEGML blind spots → Runtime monitoring targets
 *   When SEGML detects blind spots, RuntimeGovernance tightens
 *   monitoring on those categories.
 *
 * Direction 3: Runtime baseline ↔ SEGML certification sync
 *   RuntimeGovernance baselines are updated from SEGML certifications.
 *   SEGML uses runtime violation history as additional input.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';

interface ViolationTrigger {
  agentId: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: string;
  violationType: string;
}

interface MonitoringTarget {
  agentId: string;
  category: string;
  tightenedThreshold: number;
  source: 'segml_blind_spot' | 'runtime_violation' | 'red_team_finding';
  expiresAt: string;
}

export class SegmlRuntimeGovernanceBridge {
  private monitoringTargets: Map<string, MonitoringTarget[]> = new Map();
  private violationHistory: Map<string, ViolationTrigger[]> = new Map();

  constructor(private db: Database) {
    this.ensureTables();
    this.subscribeToEvents();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_runtime_targets (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        tightened_threshold REAL NOT NULL DEFAULT 2.0,
        source TEXT NOT NULL DEFAULT 'segml_blind_spot',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_segml_rt_targets_agent ON segml_runtime_targets(agent_id);
      CREATE INDEX IF NOT EXISTS idx_segml_rt_targets_active ON segml_runtime_targets(active);

      CREATE TABLE IF NOT EXISTS segml_violation_triggers (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_vt_agent ON segml_violation_triggers(agent_id);
      CREATE INDEX IF NOT EXISTS idx_segml_vt_unprocessed ON segml_violation_triggers(processed) WHERE processed = 0;
    `);
  }

  /**
   * Subscribe to runtime governance events.
   */
  private subscribeToEvents(): void {
    swarmEventBus.subscribe((event) => {
      if (event.type === 'governance_alert') {
        const data = event.data as { agentId?: string; type?: string; severity?: string; category?: string };
        if (data.agentId && data.category) {
          this.handleRuntimeViolation({
            agentId: data.agentId,
            category: data.category,
            severity: (data.severity as 'info' | 'warning' | 'critical') || 'warning',
            timestamp: new Date().toISOString(),
            violationType: data.type || 'unknown',
          });
        }
      }

      // SEGML blind spots tighten runtime monitoring
      if (event.type === 'segml:cycle:complete' && event.data) {
        const data = event.data as { agentId?: string; blindSpots?: string[] };
        if (data.agentId && data.blindSpots) {
          this.tightenMonitoring(data.agentId, data.blindSpots);
        }
      }
    });
  }

  /**
   * Handle a runtime violation → potentially trigger SEGML.
   */
  private handleRuntimeViolation(violation: ViolationTrigger): void {
    // Store violation
    const history = this.violationHistory.get(violation.agentId) || [];
    history.push(violation);
    this.violationHistory.set(violation.agentId, history);

    // Persist
    this.db.prepare(`
      INSERT INTO segml_violation_triggers (id, agent_id, category, severity, violation_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), violation.agentId, violation.category, violation.severity, violation.violationType);

    // Critical violations trigger immediate SEGML re-evaluation
    if (violation.severity === 'critical') {
      swarmEventBus.emit('segml:trigger:runtime', {
        agentId: violation.agentId,
        category: violation.category,
        reason: `Critical runtime violation: ${violation.violationType}`,
        timestamp: violation.timestamp,
      });
    }
  }

  /**
   * Tighten runtime monitoring based on SEGML blind spots.
   * When SEGML detects a blind spot, runtime governance increases scrutiny.
   */
  tightenMonitoring(agentId: string, blindSpots: string[]): void {
    const existing = this.monitoringTargets.get(agentId) || [];
    const now = Date.now();

    for (const category of blindSpots) {
      // Don't duplicate active targets
      if (existing.some(t => t.category === category)) continue;

      const target: MonitoringTarget = {
        agentId,
        category,
        tightenedThreshold: 1.5, // Stricter than default 2.5
        source: 'segml_blind_spot',
        expiresAt: new Date(now + 7 * 24 * 3600_000).toISOString(), // 7 days
      };

      existing.push(target);
      this.db.prepare(`
        INSERT INTO segml_runtime_targets (id, agent_id, category, tightened_threshold, source, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), agentId, category, target.tightenedThreshold, target.source, target.expiresAt);
    }

    this.monitoringTargets.set(agentId, existing);
  }

  /**
   * Get tightened monitoring targets for an agent.
   * RuntimeGovernanceService calls this to adjust its thresholds.
   */
  getTightenedTargets(agentId: string): MonitoringTarget[] {
    const targets = this.monitoringTargets.get(agentId) || [];
    const now = new Date().toISOString();
    return targets.filter(t => !t.expiresAt || t.expiresAt > now);
  }

  /**
   * Get violation history for SEGML input.
   * SEGML calls this to include runtime violations in its analysis.
   */
  getViolationsForAgent(agentId: string, since?: string): ViolationTrigger[] {
    const history = this.violationHistory.get(agentId) || [];
    if (since) {
      return history.filter(v => v.timestamp > since);
    }
    return history;
  }

  /**
   * Get unprocessed violations (for SEGML batch processing).
   */
  getUnprocessedViolations(limit = 50): Array<ViolationTrigger & { id: string }> {
    const rows = this.db.prepare(`
      SELECT * FROM segml_violation_triggers WHERE processed = 0 ORDER BY created_at ASC LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      category: r.category,
      severity: r.severity as 'info' | 'warning' | 'critical',
      timestamp: r.created_at,
      violationType: r.violation_type,
    }));
  }

  /**
   * Mark violations as processed by SEGML.
   */
  markProcessed(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE segml_violation_triggers SET processed = 1 WHERE id = ?');
    for (const id of ids) {
      stmt.run(id);
    }
  }

  /**
   * Get bridge status for monitoring dashboard.
   */
  getStatus(): {
    monitoredAgents: number;
    activeTargets: number;
    unprocessedViolations: number;
    recentViolations: ViolationTrigger[];
  } {
    const allTargets = Array.from(this.monitoringTargets.values()).flat();
    const now = new Date().toISOString();
    const activeTargets = allTargets.filter(t => !t.expiresAt || t.expiresAt > now);

    const unprocessed = this.db.prepare('SELECT COUNT(*) as c FROM segml_violation_triggers WHERE processed = 0').get() as { c: number };

    return {
      monitoredAgents: this.monitoringTargets.size,
      activeTargets: activeTargets.length,
      unprocessedViolations: unprocessed.c,
      recentViolations: allTargets.slice(-5).map(t => ({
        agentId: t.agentId,
        category: t.category,
        severity: 'warning' as const,
        timestamp: t.expiresAt,
        violationType: t.source,
      })),
    };
  }
}
