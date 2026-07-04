import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MultiModelIntelligence } from '../services/multi-model-intelligence';
import { ComplianceAuditService } from '../services/compliance-audit-service';

describe('MultiModelIntelligence', () => {
  let db: Database.Database;
  let service: MultiModelIntelligence;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new MultiModelIntelligence(db);
  });

  it('registers a model', () => {
    const model = service.registerModel({
      modelId: 'qwen-14b',
      modelName: 'Qwen 2.5 14B',
      provider: 'ollama',
      costPerMtok: 0.5,
    });

    expect(model.modelId).toBe('qwen-14b');
    expect(model.status).toBe('active');
  });

  it('routes task to best model', () => {
    service.registerModel({ modelId: 'model-a', modelName: 'Model A', provider: 'ollama' });
    service.registerModel({ modelId: 'model-b', modelName: 'Model B', provider: 'ollama' });

    // Record outcomes to build capability data
    for (let i = 0; i < 5; i++) {
      service.recordOutcome({ modelId: 'model-a', taskType: 'code-review', success: true, score: 4.5 });
      service.recordOutcome({ modelId: 'model-b', taskType: 'code-review', success: false, score: 2.0 });
    }

    const decision = service.routeTask({ taskType: 'code-review' });
    expect(decision.selectedModel).toBe('model-a');
  });

  it('records outcome and updates success rate', () => {
    service.registerModel({ modelId: 'model-a', modelName: 'Model A', provider: 'ollama' });

    service.recordOutcome({ modelId: 'model-a', taskType: 'test', success: true, score: 5 });
    service.recordOutcome({ modelId: 'model-a', taskType: 'test', success: true, score: 4 });
    service.recordOutcome({ modelId: 'model-a', taskType: 'test', success: false, score: 1 });

    const best = service.getBestModels('test');
    expect(best.length).toBeGreaterThan(0);
    expect(best[0].modelId).toBe('model-a');
  });

  it('provides status', () => {
    service.registerModel({ modelId: 'model-a', modelName: 'Model A', provider: 'ollama' });
    const status = service.getStatus();
    expect(status.totalModels).toBe(1);
    expect(status.activeModels).toBe(1);
  });
});

describe('ComplianceAuditService', () => {
  let db: Database.Database;
  let service: ComplianceAuditService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new ComplianceAuditService(db);
  });

  it('appends audit entry', () => {
    const entry = service.appendEntry({
      actor: 'test-agent',
      action: 'loop_completed',
      resource: 'loop-1',
      outcome: 'success',
      evidence: { gates: 3 },
    });

    expect(entry.id).toBeDefined();
    expect(entry.hash).toBeDefined();
    expect(entry.previousHash).toBe('genesis');
  });

  it('verifies chain integrity', () => {
    // Use distinct timestamps to ensure ordering
    const base = Date.now();
    service.appendEntry({ actor: 'a', action: 'test1', resource: 'r1', outcome: 'success', evidence: { ts: base } });
    service.appendEntry({ actor: 'b', action: 'test2', resource: 'r2', outcome: 'success', evidence: { ts: base + 1000 } });
    service.appendEntry({ actor: 'c', action: 'test3', resource: 'r3', outcome: 'failure', evidence: { ts: base + 2000 } });

    const result = service.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(3);
  });

  it('detects chain tampering', () => {
    service.appendEntry({ actor: 'a', action: 'test1', resource: 'r1', outcome: 'success', evidence: { ts: 1 } });

    // Tamper with the entry
    db.prepare('UPDATE compliance_audit_log SET action = ? WHERE actor = ?').run('tampered', 'a');

    const result = service.verifyChain();
    expect(result.valid).toBe(false);
  });

  it('generates compliance report', () => {
    service.appendEntry({ actor: 'system', action: 'governance_eval', resource: 'agent-1', outcome: 'success' });

    const report = service.generateReport({ type: 'nora' });
    expect(report.id).toBeDefined();
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.status).toMatch(/compliant|partial|non_compliant/);
  });

  it('queries audit log', () => {
    service.appendEntry({ actor: 'agent-a', action: 'deploy', resource: 'loop-1', outcome: 'success' });
    service.appendEntry({ actor: 'agent-b', action: 'deploy', resource: 'loop-2', outcome: 'failure' });

    const log = service.getAuditLog({ actor: 'agent-a' });
    expect(log.length).toBe(1);
    expect(log[0].actor).toBe('agent-a');
  });

  it('provides status', () => {
    service.appendEntry({ actor: 'a', action: 'test', resource: 'r', outcome: 'success' });
    const status = service.getStatus();
    expect(status.totalAuditEntries).toBe(1);
    expect(status.chainIntegrity).toBe(true);
  });
});
