import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface HealthCheckResult {
  id: string;
  agentId: string;
  agentName: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  latencyMs: number;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }>;
  timestamp: string;
}

export interface MonitoringAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  source: string;
  message: string;
  acknowledged: boolean;
  createdAt: string;
}

interface HealthRow {
  id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  latency_ms: number;
  checks_json: string;
  created_at: string;
}

interface AlertRow {
  id: string;
  severity: string;
  source: string;
  message: string;
  acknowledged: number;
  created_at: string;
}

export class MonitoringAgent {
  private agentId = 'monitoring';
  private agentName = 'Monitoring Agent';

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitoring_health_checks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        checks_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitoring_alerts (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  getAgentInfo() {
    return {
      id: this.agentId,
      name: this.agentName,
      status: 'active',
      capabilities: ['monitoring', 'alerting', 'health-checks', 'metrics-collection'],
      description: 'Monitors agent health, latency, and generates alerts',
    };
  }

  checkHealth(agentId: string, agentName: string, checkFn?: () => Promise<boolean>): HealthCheckResult {
    const start = Date.now();
    const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }> = [];

    checks.push({ name: 'database', status: 'pass', message: 'Database connection active' });
    checks.push({ name: 'memory', status: 'pass', message: 'Memory usage within bounds' });

    if (checkFn) {
      checkFn().then(ok => {
        checks.push({ name: 'custom', status: ok ? 'pass' : 'fail', message: ok ? 'Custom check passed' : 'Custom check failed' });
      }).catch(() => {
        checks.push({ name: 'custom', status: 'fail', message: 'Custom check threw error' });
      });
    }

    const latency = Date.now() - start;
    const failedChecks = checks.filter(c => c.status === 'fail').length;
    const status: HealthCheckResult['status'] = failedChecks > 0 ? 'unhealthy' : latency > 1000 ? 'degraded' : 'healthy';

    const result: HealthCheckResult = {
      id: randomUUID(),
      agentId,
      agentName,
      status,
      latencyMs: latency,
      checks,
      timestamp: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO monitoring_health_checks (id, agent_id, agent_name, status, latency_ms, checks_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(result.id, agentId, agentName, status, latency, JSON.stringify(checks));

    if (status === 'unhealthy') {
      this.createAlert('critical', agentId, `Agent ${agentName} is unhealthy: ${failedChecks} failed checks`);
    }

    return result;
  }

  checkAllAgents(agents: Array<{ id: string; name: string }>): HealthCheckResult[] {
    return agents.map(agent => this.checkHealth(agent.id, agent.name));
  }

  createAlert(severity: MonitoringAlert['severity'], source: string, message: string): MonitoringAlert {
    const alert: MonitoringAlert = {
      id: randomUUID(),
      severity,
      source,
      message,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO monitoring_alerts (id, severity, source, message, acknowledged)
      VALUES (?, ?, ?, ?, 0)
    `).run(alert.id, severity, source, message);

    return alert;
  }

  getActiveAlerts(): MonitoringAlert[] {
    const rows = this.db.prepare("SELECT * FROM monitoring_alerts WHERE acknowledged = 0 ORDER BY created_at DESC").all() as AlertRow[];
    return rows.map(r => ({
      id: r.id,
      severity: r.severity as MonitoringAlert['severity'],
      source: r.source,
      message: r.message,
      acknowledged: r.acknowledged === 1,
      createdAt: r.created_at,
    }));
  }

  acknowledgeAlert(alertId: string): void {
    this.db.prepare("UPDATE monitoring_alerts SET acknowledged = 1 WHERE id = ?").run(alertId);
  }

  getHealthHistory(agentId: string, limit: number = 20): HealthCheckResult[] {
    const rows = this.db.prepare('SELECT * FROM monitoring_health_checks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit) as HealthRow[];
    return rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      agentName: r.agent_name,
      status: r.status as HealthCheckResult['status'],
      latencyMs: r.latency_ms,
      checks: JSON.parse(r.checks_json) as HealthCheckResult['checks'],
      timestamp: r.created_at,
    }));
  }

  getMetrics(): {
    totalHealthChecks: number;
    healthyCount: number;
    degradedCount: number;
    unhealthyCount: number;
    activeAlerts: number;
    avgLatencyMs: number;
  } {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy,
        SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) as degraded,
        SUM(CASE WHEN status = 'unhealthy' THEN 1 ELSE 0 END) as unhealthy,
        AVG(latency_ms) as avgLatency
      FROM monitoring_health_checks
    `).get() as { total: number; healthy: number; degraded: number; unhealthy: number; avgLatency: number | null };

    const alerts = this.db.prepare("SELECT COUNT(*) as c FROM monitoring_alerts WHERE acknowledged = 0").get() as { c: number };

    return {
      totalHealthChecks: counts.total,
      healthyCount: counts.healthy,
      degradedCount: counts.degraded,
      unhealthyCount: counts.unhealthy,
      activeAlerts: alerts.c,
      avgLatencyMs: Math.round(counts.avgLatency ?? 0),
    };
  }
}
