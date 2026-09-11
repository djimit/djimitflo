import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalRequestType, type Task, type RiskAssessment } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';

let db: Database.Database;
let audit: AuditService;
let service: ApprovalService;
const publish = vi.fn();
let task: Task;
const assessment = { action_type: 'shell_command', risk_level: 'high', matched_rules: [], explanation: 'Fixture review', recommended_decision: 'require_approval', metadata: {} } as RiskAssessment;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(schema); runMigrations(db);
  db.prepare('INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode) VALUES (?,?,?,?,?,?,?)')
    .run('approval-task', 'Fixture', 'Review', 'awaiting_approval', 'low', 'high', 'local');
  task = db.prepare('SELECT * FROM tasks WHERE id=?').get('approval-task') as Task;
  audit = new AuditService(db); publish.mockReset();
  service = new ApprovalService(db, { broadcastTaskEventById: publish }, audit);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

function create() {
  return service.createApproval({ task, assessment, requestType: ApprovalRequestType.HIGH_RISK_ACTION, title: 'Fixture review', description: 'Fixture', requestedBy: 'maker', metadata: { executorKind: 'mock' } });
}
function failAudit() {
  db.exec("CREATE TRIGGER reject_approval_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'fixture audit insertion failed'); END");
}
function auditCount() { return db.prepare('SELECT count(*) n FROM audit_events').get(); }

it('rolls back approval creation when the real canonical audit insert fails', () => {
  failAudit();
  expect(() => create()).toThrow(/fixture audit insertion failed/);
  expect(service.listApprovals()).toEqual([]);
  expect(auditCount()).toEqual({ n: 0 });
  expect(publish).not.toHaveBeenCalled();
});

it.each([true, false])('rolls back decision %s when its canonical audit insert fails, then allows retry', approved => {
  const pending = create(); publish.mockClear(); const before = auditCount();
  failAudit();
  expect(() => service.decideApproval(pending.id, approved, 'independent')).toThrow(/fixture audit insertion failed/);
  expect(service.getApproval(pending.id)?.status).toBe('pending');
  expect(auditCount()).toEqual(before); expect(publish).not.toHaveBeenCalled();
  db.exec('DROP TRIGGER reject_approval_audit');
  expect(service.decideApproval(pending.id, approved, 'independent').status).toBe(approved ? 'approved' : 'denied');
});

it.each(['read', 'decide'])('rolls back lazy expiry via %s when audit fails', path => {
  const pending = create(); publish.mockClear(); const before = auditCount();
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), pending.id);
  failAudit();
  const action = () => path === 'read' ? service.getLatestPendingForTask(task.id) : service.decideApproval(pending.id, true, 'independent');
  expect(action).toThrow(/fixture audit insertion failed/);
  expect(service.getApproval(pending.id)?.status).toBe('pending');
  expect(auditCount()).toEqual(before); expect(publish).not.toHaveBeenCalled();
});

it('persists expired decision refusal and its audit once, outside the throwing transaction', () => {
  const pending = create(); publish.mockClear();
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run('invalid-expiry', pending.id);
  expect(() => service.decideApproval(pending.id, true, 'independent')).toThrow(/APPROVAL_EXPIRED/);
  expect(service.getApproval(pending.id)?.status).toBe('expired');
  expect(service.getLatestPendingForTask(task.id)).toBeNull();
  expect(() => service.decideApproval(pending.id, true, 'independent')).toThrow(/APPROVAL_EXPIRED/);
  expect(db.prepare("SELECT count(*) n FROM audit_events WHERE action='approval_expired'").get()).toEqual({ n: 1 });
  expect(publish).toHaveBeenCalledTimes(1);
});

it('publishes create, decision and expiry only after their transactions commit', () => {
  const observations: { transaction: boolean; auditRows: unknown }[] = [];
  publish.mockImplementation(() => observations.push({ transaction: db.inTransaction, auditRows: auditCount() }));
  const first = create(); service.decideApproval(first.id, true, 'independent');
  const expired = create();
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run('invalid-expiry', expired.id);
  service.getLatestPendingForTask(task.id);
  expect(observations.map(row => row.transaction)).toEqual([false, false, false, false]);
  expect(observations.map(row => row.auditRows)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
});

it.each(['create', 'decide', 'expire'])('post-commit notification failure does not undo or obscure %s', operation => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const pending = operation === 'create' ? undefined : create();
  publish.mockImplementation(() => { throw new Error('fixture socket failed'); });
  if (operation === 'create') expect(create().status).toBe('pending');
  if (operation === 'decide') expect(service.decideApproval(pending!.id, true, 'independent').status).toBe('approved');
  if (operation === 'expire') {
    db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run('invalid-expiry', pending!.id);
    expect(service.getLatestPendingForTask(task.id)).toBeNull();
    expect(service.getApproval(pending!.id)?.status).toBe('expired');
  }
});

it('retains self-approval rejection and rejects a second competing service decision without a second audit', () => {
  const pending = create(); publish.mockClear();
  expect(() => service.decideApproval(pending.id, true, 'maker')).toThrow(/SELF_APPROVAL_FORBIDDEN/);
  expect(() => service.decideApproval(pending.id, 'false' as unknown as boolean, 'independent')).toThrow(/INVALID_APPROVAL_DECISION/);
  service.decideApproval(pending.id, false, 'independent');
  const competing = new ApprovalService(db, { broadcastTaskEventById: publish }, new AuditService(db));
  expect(() => competing.decideApproval(pending.id, true, 'other-approver')).toThrow(/already processed/);
  expect(auditCount()).toEqual({ n: 2 }); expect(publish).toHaveBeenCalledTimes(1);
});

it('holds the write lock through audit and exposes only committed decisions to another SQLite connection', async () => {
  const pending = create();
  const directory = mkdtempSync(join(tmpdir(), 'djimitflo-approval-atomicity-'));
  const path = join(directory, 'fixture.sqlite');
  await db.backup(path);
  const writer = new Database(path, { timeout: 0 });
  const observer = new Database(path, { timeout: 0 });
  try {
    const writerAudit = new AuditService(writer);
    const competing = new ApprovalService(observer, { broadcastTaskEventById: publish }, new AuditService(observer));
    const record = writerAudit.record.bind(writerAudit);
    vi.spyOn(writerAudit, 'record').mockImplementation(input => {
      expect(competing.getApproval(pending.id)?.status).toBe('pending');
      expect(() => competing.decideApproval(pending.id, false, 'other')).toThrow(/database is locked/);
      return record(input);
    });
    const primary = new ApprovalService(writer, { broadcastTaskEventById: publish }, writerAudit);
    expect(primary.decideApproval(pending.id, true, 'independent').status).toBe('approved');
    expect(competing.getApproval(pending.id)?.status).toBe('approved');
    expect(() => competing.decideApproval(pending.id, false, 'other')).toThrow(/already processed/);
    expect(observer.prepare('SELECT count(*) n FROM audit_events').get()).toEqual({ n: 2 });
  } finally {
    writer.close(); observer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
