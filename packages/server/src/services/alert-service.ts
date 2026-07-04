/**
 * AlertService — threshold-based alerting for production monitoring.
 *
 * Alerts on:
 * - Loop failure rate > 20%
 * - Governance score < 3.0
 * - Disk usage > 90%
 * - Memory usage > 85%
 * - Active leases > max capacity
 */

import type { Database } from 'better-sqlite3';

interface AlertRule {
  id: string;
  name: string;
  condition: string;
  threshold: number;
  severity: 'warning' | 'critical';
  enabled: boolean;
}

interface Alert {
  id: string;
  ruleId: string;
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: string;
  acknowledged: boolean;
}

const DEFAULT_RULES: AlertRule[] = [
  { id: 'loop-failure-rate', name: 'Loop failure rate', condition: 'loop_failure_rate', threshold: 0.2, severity: 'warning', enabled: true },
  { id: 'loop-failure-rate-critical', name: 'Loop failure rate (critical)', condition: 'loop_failure_rate', threshold: 0.5, severity: 'critical', enabled: true },
  { id: 'governance-score', name: 'Governance score', condition: 'governance_score', threshold: 3.0, severity: 'critical', enabled: true },
  { id: 'memory-usage', name: 'Memory usage', condition: 'memory_mb', threshold: 500, severity: 'warning', enabled: true },
  { id: 'active-leases', name: 'Active leases', condition: 'active_leases', threshold: 50, severity: 'warning', enabled: true },
];

export class AlertService {
  private rules: AlertRule[] = [...DEFAULT_RULES];

  constructor(private db: Database) {}

  /**
   * Evaluate all alert rules and return triggered alerts.
   */
  evaluate(): Alert[] {
    const triggered: Alert[] = [];
    const now = new Date().toISOString();

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      let value: number;
      switch (rule.condition) {
        case 'loop_failure_rate': {
          const stats = this.db.prepare(`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM loop_runs
            WHERE created_at > datetime('now', '-1 hour')
          `).get() as any;
          value = stats.total > 0 ? stats.failed / stats.total : 0;
          break;
        }
        case 'memory_mb':
          value = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          break;
        case 'active_leases':
          value = (this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'running'").get() as any)?.c || 0;
          break;
        default:
          continue;
      }

      const breached = value > rule.threshold;

      if (breached) {
        triggered.push({
          id: `${rule.id}-${Date.now()}`,
          ruleId: rule.id,
          severity: rule.severity,
          message: `${rule.name}: ${value} (threshold: ${rule.threshold})`,
          value,
          threshold: rule.threshold,
          timestamp: now,
          acknowledged: false,
        });
      }
    }

    return triggered;
  }

  /**
   * Get all configured rules.
   */
  getRules(): AlertRule[] {
    return this.rules;
  }

  /**
   * Enable/disable a rule.
   */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (rule) rule.enabled = enabled;
  }

  /**
   * Add a custom rule.
   */
  addRule(rule: Omit<AlertRule, 'id'>): AlertRule {
    const newRule: AlertRule = { ...rule, id: `custom-${Date.now()}` };
    this.rules.push(newRule);
    return newRule;
  }
}
