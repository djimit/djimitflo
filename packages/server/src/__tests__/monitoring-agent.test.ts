import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MonitoringAgent } from '../services/monitoring-agent';
import { createTestDb } from './helpers/test-db';


let db: Database.Database;
let monitoring: MonitoringAgent;

beforeEach(() => {
  db = createTestDb();
  db.pragma('foreign_keys = ON');
  
  
  monitoring = new MonitoringAgent(db);
});

afterEach(() => {
  db?.close();
});

describe('MonitoringAgent', () => {
  it('returns agent info', () => {
    const info = monitoring.getAgentInfo();
    expect(info.id).toBe('monitoring');
    expect(info.capabilities).toContain('monitoring');
    expect(info.capabilities).toContain('alerting');
  });

  it('checks agent health', () => {
    const result = monitoring.checkHealth('agent-1', 'Test Agent');
    expect(result.status).toBe('healthy');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('checks all agents', () => {
    const agents = [
      { id: 'a1', name: 'Agent 1' },
      { id: 'a2', name: 'Agent 2' },
    ];
    const results = monitoring.checkAllAgents(agents);
    expect(results.length).toBe(2);
  });

  it('creates alerts', () => {
    const alert = monitoring.createAlert('critical', 'test', 'Test alert');
    expect(alert.severity).toBe('critical');
    expect(alert.acknowledged).toBe(false);
  });

  it('gets active alerts', () => {
    monitoring.createAlert('warning', 'test', 'Alert 1');
    monitoring.createAlert('info', 'test', 'Alert 2');
    const alerts = monitoring.getActiveAlerts();
    expect(alerts.length).toBe(2);
  });

  it('acknowledges alerts', () => {
    const alert = monitoring.createAlert('warning', 'test', 'Test');
    monitoring.acknowledgeAlert(alert.id);
    const active = monitoring.getActiveAlerts();
    expect(active.find(a => a.id === alert.id)).toBeUndefined();
  });

  it('gets health history', () => {
    monitoring.checkHealth('agent-1', 'Test');
    monitoring.checkHealth('agent-1', 'Test');
    const history = monitoring.getHealthHistory('agent-1', 10);
    expect(history.length).toBe(2);
  });

  it('gets metrics', () => {
    monitoring.checkHealth('agent-1', 'Test');
    const metrics = monitoring.getMetrics();
    expect(metrics.totalHealthChecks).toBe(1);
    expect(metrics.healthyCount).toBe(1);
  });
});
