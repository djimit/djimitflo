import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { AuditService } from '../services/audit-service';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';

/**
 * The audit_events hash chain (ComplianceAuditService.verifyChain, GET /api/compliance/audit/verify) must report the
 * first broken link when a row is forged or edited behind the append-only triggers, and must stay valid for every
 * shape a real writer appends (an empty resource included).
 */
describe('audit_events hash-chain verify', () => {
  let db: Database.Database;
  let service: ComplianceAuditService;

  beforeEach(() => {
    db = new Database(':memory:');
    service = new ComplianceAuditService(db);
  });

  const appendThree = () => [1, 2, 3].map((n) => service.appendEntry({ actor: `a${n}`, action: `act${n}`, resource: `r${n}`, outcome: 'success', evidence: { n } }));

  it('an untouched chain verifies, including an entry with an empty resource and one written through AuditService', () => {
    appendThree();
    service.appendEntry({ actor: 'operator', action: 'manual_note', resource: '', outcome: 'success' });
    new AuditService(db).record({ event_type: AuditEventType.POLICY_VIOLATION, action: 'policy_violation_detected', resource_type: 'task', task_id: 't1', risk_level: RiskLevel.HIGH, metadata: { b: 2, a: 1 } });
    expect(service.verifyChain()).toEqual({ valid: true, entriesChecked: 5 });
  });

  it('an edited row (triggers bypassed) is reported as the first broken link', () => {
    const [, second] = appendThree();
    db.exec('DROP TRIGGER audit_events_no_update');
    db.prepare('UPDATE audit_events SET metadata = ? WHERE id = ?').run(JSON.stringify({ n: 99 }), second.id);
    expect(service.verifyChain()).toMatchObject({ valid: false, firstInvalidId: second.id });
  });

  it('a forged row whose hash does not match its content is the first broken link', () => {
    const [, , third] = appendThree();
    db.prepare(`INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, evidence_json, previous_hash, hash)
      VALUES ('forged', ?, 'mallory', 'approve', 'x', 'success', '{}', ?, ?)`).run(new Date().toISOString(), third.hash, 'f'.repeat(64));
    expect(service.verifyChain()).toMatchObject({ valid: false, firstInvalidId: 'forged' });
  });

  it('a deleted middle row (triggers bypassed) breaks the link of its successor', () => {
    const [, second, third] = appendThree();
    db.exec('DROP TRIGGER audit_events_no_delete');
    db.prepare('DELETE FROM audit_events WHERE id = ?').run(second.id);
    expect(service.verifyChain()).toMatchObject({ valid: false, firstInvalidId: third.id });
  });
});
