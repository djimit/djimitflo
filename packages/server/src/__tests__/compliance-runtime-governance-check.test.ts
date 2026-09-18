import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ComplianceAuditService } from '../services/compliance-audit-service';

describe('ComplianceAuditService: runtime_governance check', () => {
  let db: Database.Database;
  let audit: ComplianceAuditService;
  const prevFlag = process.env.GOVERNANCE_GATE_ENABLED;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db); // seeds default approval_policies
    audit = new ComplianceAuditService(db);
  });

  afterEach(() => {
    db.close();
    if (prevFlag === undefined) delete process.env.GOVERNANCE_GATE_ENABLED;
    else process.env.GOVERNANCE_GATE_ENABLED = prevFlag;
  });

  function runtimeGovernanceFinding(type: 'nora' | 'soc2' | 'iso27001' | 'custom' = 'custom') {
    const report = audit.generateReport({ type });
    return report.findings.find((f) => f.control === 'runtime_governance')!;
  }

  it('reports inactive when the governance gate is off, even though approval_policies exist', () => {
    delete process.env.GOVERNANCE_GATE_ENABLED;
    const finding = runtimeGovernanceFinding();
    expect(finding.status).toBe('fail');
    expect(finding.description).toContain('inactive');
  });

  it('reports active once the governance gate is armed', () => {
    process.env.GOVERNANCE_GATE_ENABLED = 'true';
    const finding = runtimeGovernanceFinding();
    expect(finding.status).toBe('pass');
    expect(finding.description).toContain('active');
  });

  it('still reports inactive if the gate is on but no approval policies exist', () => {
    process.env.GOVERNANCE_GATE_ENABLED = 'true';
    db.prepare('DELETE FROM approval_policies').run();
    const finding = runtimeGovernanceFinding();
    expect(finding.status).toBe('fail');
  });
});
