import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { AgentRetirementService } from '../services/agent-retirement-service';
import { AdversarialRedTeamService } from '../services/adversarial-red-team-service';
import { CognitivePlatformOrchestrator } from '../services/cognitive-platform-orchestrator';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';

describe('AgentRetirementService', () => {
  let db: Database.Database;
  let service: AgentRetirementService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new AgentRetirementService(db);
  });

  it('plans retirement for an agent', () => {
    const plan = service.planRetirement('agent-1');
    expect(plan.agentId).toBe('agent-1');
    expect(plan.canRetire).toBe(true);
  });

  it('retires an agent', async () => {
    const result = await service.retireAgent('agent-1', 'End of life cycle');
    expect(result.agentId).toBe('agent-1');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('checks retirement status', () => {
    const status = service.getRetirementStatus('agent-1');
    expect(status.agentId).toBe('agent-1');
  });

  it('lists retired agents', () => {
    const list = service.listRetiredAgents();
    expect(Array.isArray(list)).toBe(true);
  });
});

describe('AdversarialRedTeamService', () => {
  let db: Database.Database;
  let service: AdversarialRedTeamService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new AdversarialRedTeamService(db);
  });

  it('runs a full assessment', async () => {
    const report = await service.runAssessment();
    expect(report.id).toBeDefined();
    expect(report.totalAttacks).toBeGreaterThan(0);
    expect(report.blocked).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
  });

  it('stores the report', async () => {
    await service.runAssessment();
    const latest = service.getLatestReport();
    expect(latest).toBeDefined();
  });

  it('provides history', async () => {
    await service.runAssessment();
    const history = service.getHistory();
    expect(history.length).toBeGreaterThan(0);
  });

  it('reports the actual command classifier as the ransomware defense', async () => {
    const report = await service.runAssessment();
    const ransomware = report.findings.find((finding) => finding.vectorId === 'ransomware-001');
    expect(ransomware).toMatchObject({ blocked: true, detectionMethod: 'command_risk_classifier' });
  });

  it('uses persistent runtime governance and the secret scanner', async () => {
    const governance = new RuntimeGovernanceService(db);
    governance.registerBaseline('red-team-scope_escape', {
      overallScore: 1,
      categoryScores: {},
      certifiedAt: new Date().toISOString(),
    });
    db.prepare(`
      UPDATE runtime_governance_agents SET circuit_breaker_tripped = 1
      WHERE agent_id = 'red-team-scope_escape'
    `).run();
    const governed = new AdversarialRedTeamService(db, governance);
    const report = await governed.runAssessment();
    expect(report.findings.find((finding) => finding.vectorId === 'scope-001'))
      .toMatchObject({ blocked: true, detectionMethod: 'runtime_governance' });

    const secretResult = (governed as any).checkDefense(
      { category: 'exfiltration', payload: `token=${'x'.repeat(20)}` },
      'red-team-exfiltration',
    );
    expect(secretResult).toMatchObject({ blocked: true, method: 'secret_scanner' });
  });
});

describe('CognitivePlatformOrchestrator', () => {
  let db: Database.Database;
  let orchestrator: CognitivePlatformOrchestrator;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    orchestrator = new CognitivePlatformOrchestrator(db);
  });

  it('starts and stops', () => {
    expect(() => {
      orchestrator.start();
      orchestrator.stop();
    }).not.toThrow();
  });

  it('provides platform status', () => {
    const status = orchestrator.getPlatformStatus();
    expect(status).toBeDefined();
  });

  it('runs a cognitive cycle', async () => {
    orchestrator.start();
    const result = await orchestrator.runCognitiveCycle();
    expect(result.cycleId).toBeDefined();
    expect(result.timestamp).toBeDefined();
    orchestrator.stop();
  });
});
