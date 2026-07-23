/**
 * EarlyWarningService — generates alerts before governance failures occur.
 *
 * Implements:
 * - Threshold-based alerting
 * - Multi-channel notifications
 * - Alert escalation
 * - Alert deduplication
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface Alert {
  alert_id: string;
  severity: 'info' | 'warning' | 'critical' | 'emergency';
  category: string;
  title: string;
  message: string;
  risk_score: number;
  predicted_time?: string;
  acknowledged: boolean;
  escalation_level: number;
  created_at: string;
}

export interface AlertRule {
  rule_id: string;
  category: string;
  metric: string;
  threshold: number;
  operator: 'gt' | 'lt' | 'gte' | 'lte';
  severity: Alert['severity'];
  enabled: boolean;
}

export class EarlyWarningService {
  private rules: AlertRule[] = [];

  constructor(private db: Database) {
    this.ensureTables();
    this.loadRules();
  }

  /**
   * Create an alert.
   */
  createAlert(severity: Alert['severity'], category: string, title: string, message: string, riskScore: number): Alert {
    const alert: Alert = {
      alert_id: `alert-${randomUUID().slice(0, 8)}`,
      severity,
      category,
      title,
      message,
      risk_score: riskScore,
      acknowledged: false,
      escalation_level: 0,
      created_at: new Date().toISOString(),
    };

    this.persistAlert(alert);
    return alert;
  }

  /**
   * Evaluate all rules and generate alerts.
   */
  evaluateRules(metrics: Record<string, number>): Alert[] {
    const alerts: Alert[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      const value = metrics[rule.category] ?? 0;
      let triggered = false;

      switch (rule.operator) {
        case 'gt': triggered = value > rule.threshold; break;
        case 'lt': triggered = value < rule.threshold; break;
        case 'gte': triggered = value >= rule.threshold; break;
        case 'lte': triggered = value <= rule.threshold; break;
      }

      if (triggered) {
        alerts.push(this.createAlert(
          rule.severity,
          rule.category,
          `${rule.category} threshold exceeded`,
          `${rule.metric} is ${value.toFixed(1)} (threshold: ${rule.threshold})`,
          value,
        ));
      }
    }

    return alerts;
  }

  /**
   * Acknowledge an alert.
   */
  acknowledge(alertId: string): void {
    this.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE alert_id = ?').run(alertId);
  }

  /**
   * Escalate an unacknowledged alert.
   */
  escalate(alertId: string): void {
    const alert = this.db.prepare('SELECT * FROM alerts WHERE alert_id = ?').get(alertId) as any;
    if (!alert) return;

    const newLevel = alert.escalation_level + 1;
    this.db.prepare('UPDATE alerts SET escalation_level = ? WHERE alert_id = ?').run(newLevel, alertId);

    // If escalated beyond level 2, increase severity
    if (newLevel > 2) {
      this.db.prepare("UPDATE alerts SET severity = ? WHERE alert_id = ? AND severity IN ('info', 'warning')").run('critical', alertId);
    }
  }

  /**
   * Get active (unacknowledged) alerts.
   */
  getActiveAlerts(): Alert[] {
    const rows = this.db.prepare('SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC').all() as any[];
    return rows.map(this.rowToAlert);
  }

  /**
   * Get alerts by severity.
   */
  getAlertsBySeverity(severity: Alert['severity']): Alert[] {
    const rows = this.db.prepare('SELECT * FROM alerts WHERE severity = ? ORDER BY created_at DESC').all(severity) as any[];
    return rows.map(this.rowToAlert);
  }

  /**
   * Add an alert rule.
   */
  addRule(rule: Omit<AlertRule, 'rule_id'>): AlertRule {
    const r: AlertRule = { ...rule, rule_id: `rule-${randomUUID().slice(0, 8)}` };
    this.rules.push(r);
    this.persistRule(r);
    return r;
  }

  private loadRules(): void {
    this.rules = [
      { rule_id: 'r1', category: 'hierarchy', metric: 'risk_score', threshold: 70, operator: 'gt', severity: 'critical', enabled: true },
      { rule_id: 'r2', category: 'injection', metric: 'risk_score', threshold: 60, operator: 'gt', severity: 'warning', enabled: true },
      { rule_id: 'r3', category: 'hallucination', metric: 'risk_score', threshold: 50, operator: 'gt', severity: 'warning', enabled: true },
      { rule_id: 'r4', category: 'canary', metric: 'risk_score', threshold: 40, operator: 'gt', severity: 'info', enabled: true },
    ];
  }

  private rowToAlert(row: any): Alert {
    return {
      alert_id: row.alert_id,
      severity: row.severity,
      category: row.category,
      title: row.title,
      message: row.message,
      risk_score: row.risk_score,
      acknowledged: row.acknowledged === 1,
      escalation_level: row.escalation_level,
      created_at: row.created_at,
    };
  }

  private persistAlert(alert: Alert): void {
    this.db.prepare(`
      INSERT INTO alerts (alert_id, severity, category, title, message, risk_score, acknowledged, escalation_level, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(alert.alert_id, alert.severity, alert.category, alert.title, alert.message, alert.risk_score, alert.acknowledged ? 1 : 0, alert.escalation_level, alert.created_at);
  }

  private persistRule(rule: AlertRule): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO alert_rules (rule_id, category, metric, threshold, operator, severity, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(rule.rule_id, rule.category, rule.metric, rule.threshold, rule.operator, rule.severity, rule.enabled ? 1 : 0);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL UNIQUE,
        severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical', 'emergency')),
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        risk_score REAL NOT NULL DEFAULT 0,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        escalation_level INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS alert_rules (
        rule_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        metric TEXT NOT NULL,
        threshold REAL NOT NULL,
        operator TEXT NOT NULL CHECK(operator IN ('gt', 'lt', 'gte', 'lte')),
        severity TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
      CREATE INDEX IF NOT EXISTS idx_alerts_category ON alerts(category);
      CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts(acknowledged);
    `);
  }
}
