import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ComplianceAuditService } from '../services/compliance-audit-service';

describe('ComplianceAuditService: governance_certification_coverage check', () => {
  let db: Database.Database;
  let audit: ComplianceAuditService;
  const prevFloor = process.env.GOVERNANCE_GATE_FLOOR;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    audit = new ComplianceAuditService(db);
    process.env.GOVERNANCE_GATE_FLOOR = '30';
  });

  afterEach(() => {
    db.close();
    if (prevFloor === undefined) delete process.env.GOVERNANCE_GATE_FLOOR;
    else process.env.GOVERNANCE_GATE_FLOOR = prevFloor;
  });

  function insertAgent(id: string, model: string | null) {
    db.prepare(`
      INSERT INTO agents (id, name, description, status, capabilities, model)
      VALUES (?, ?, '', 'idle', '[]', ?)
    `).run(id, id, model);
  }

  function insertEvalRun(agentId: string, score: number, finishedAt = new Date().toISOString()) {
    db.prepare(`
      INSERT INTO openmythos_eval_runs (id, agent_id, status, overall_score, finished_at)
      VALUES (?, ?, 'completed', ?, ?)
    `).run(randomUUID(), agentId, score, finishedAt);
  }

  function coverageFinding() {
    const report = audit.generateReport({ type: 'custom' });
    return report.findings.find((f) => f.control === 'governance_certification_coverage')!;
  }

  it('does not count an eval run belonging to an unrelated agent_id namespace', () => {
    insertAgent('deerflow', 'latest');
    insertEvalRun('some-other-projects-experiment-name', 95);

    const finding = coverageFinding();
    expect(finding.evidence[0]).toBe('0 certified out of 1 agents');
  });

  it('certifies an agent via a direct agent_id match at or above the governance floor', () => {
    insertAgent('claude-macbook', null);
    insertEvalRun('claude-macbook', 30);

    const finding = coverageFinding();
    expect(finding.evidence[0]).toBe('1 certified out of 1 agents');
  });

  it('certifies an agent via the nightly:<model> proxy, normalizing the provider prefix', () => {
    insertAgent('commons-scout', 'ollama/qwen2.5:3b');
    insertEvalRun('nightly:qwen2.5:3b', 45);

    const finding = coverageFinding();
    expect(finding.evidence[0]).toBe('1 certified out of 1 agents');
  });

  it('does not certify below the governance floor', () => {
    insertAgent('commons-scout', 'ollama/qwen2.5:3b');
    insertEvalRun('nightly:qwen2.5:3b', 10);

    const finding = coverageFinding();
    expect(finding.evidence[0]).toBe('0 certified out of 1 agents');
  });

  it('does not crash and leaves an agent without a model uncertified with no matching run', () => {
    insertAgent('pi-workstation', null);

    const finding = coverageFinding();
    expect(finding.evidence[0]).toBe('0 certified out of 1 agents');
  });
});
