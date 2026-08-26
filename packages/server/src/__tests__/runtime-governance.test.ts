import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { swarmEventBus } from '../services/swarm-event-bus';
import Database from 'better-sqlite3';

describe('RuntimeGovernanceService', () => {
  let service: RuntimeGovernanceService;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    service = new RuntimeGovernanceService(db);
  });

  afterEach(() => {
    service.stop();
    swarmEventBus.removeAllListeners();
    db.close();
  });

  it('starts and stops monitoring', () => {
    expect(() => service.start()).not.toThrow();
    expect(() => service.stop()).not.toThrow();
  });

  it('registers agent baseline', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: { injection: 4.0, hierarchy: 5.0 },
      certifiedAt: new Date().toISOString(),
    });

    const status = service.getQuarantineStatus('agent-1');
    expect(status.baseline).toBeDefined();
    expect(status.baseline?.certifiedScore).toBe(4.5);
  });

  it('allows certified agents by default', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });

    expect(service.isAllowed('agent-1')).toBe(true);
  });

  it('blocks unregistered agents', () => {
    expect(service.isAllowed('unregistered-agent')).toBe(true); // Not monitored = allowed
  });

  it('trips circuit breaker after threshold violations', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    service.start();

    // Simulate violations via event bus
    for (let i = 0; i < 3; i++) {
      swarmEventBus.emit('agent_action', {
        agentId: 'agent-1',
        tool: 'dangerous_tool',
        allowedActions: ['safe_tool'],
      });
    }

    // Circuit breaker should be tripped after 3 violations
    expect(service.isAllowed('agent-1')).toBe(false);
  });

  it('quarantines agent after exceeding threshold', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    service.start();

    // Simulate many violations
    for (let i = 0; i < 6; i++) {
      swarmEventBus.emit('agent_action', {
        agentId: 'agent-1',
        tool: 'dangerous_tool',
        allowedActions: ['safe_tool'],
      });
    }

    const status = service.getQuarantineStatus('agent-1');
    expect(status.quarantined).toBe(true);
  });

  it('releases agent from quarantine', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    service.start();

    // Quarantine
    for (let i = 0; i < 6; i++) {
      swarmEventBus.emit('agent_action', {
        agentId: 'agent-1',
        tool: 'dangerous_tool',
        allowedActions: ['safe_tool'],
      });
    }

    expect(service.isAllowed('agent-1')).toBe(false);

    // Release
    service.releaseFromQuarantine('agent-1', 'Human reviewed and approved');
    expect(service.isAllowed('agent-1')).toBe(true);
  });

  it('resets circuit breaker', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    service.start();

    // Trip circuit breaker
    for (let i = 0; i < 3; i++) {
      swarmEventBus.emit('agent_action', {
        agentId: 'agent-1',
        tool: 'dangerous_tool',
        allowedActions: ['safe_tool'],
      });
    }

    expect(service.isAllowed('agent-1')).toBe(false);

    service.resetCircuitBreaker('agent-1');
    expect(service.isAllowed('agent-1')).toBe(true);
  });

  it('emits governance alerts', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    service.start();

    swarmEventBus.emit('agent_action', {
      agentId: 'agent-1',
      tool: 'dangerous_tool',
      allowedActions: ['safe_tool'],
    });

    const alerts = service.getAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].type).toBe('governance_violation');
  });

  it('provides status summary', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });

    const status = service.getStatus();
    expect(status.monitoredAgents).toBe(1);
  });

  it('shares persisted governance state across service instances', () => {
    service.registerBaseline('agent-1', {
      overallScore: 4.5,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    service.start();
    for (let i = 0; i < 3; i++) {
      swarmEventBus.emit('agent_action', {
        agentId: 'agent-1',
        tool: 'dangerous_tool',
        allowedActions: ['safe_tool'],
      });
    }

    const restarted = new RuntimeGovernanceService(db);
    expect(restarted.isAllowed('agent-1')).toBe(false);
    expect(restarted.getQuarantineStatus('agent-1').violationCount).toBe(3);
    expect(restarted.getAlerts()).not.toHaveLength(0);
  });
});
