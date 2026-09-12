import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from './helpers/test-db';
import { schema } from '../database/schema';
import { EvidenceService } from '../services/evidence-service';
import { ExportService } from '../services/export-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { createEvidenceRoutes } from '../routes/evidence';
import { errorHandler } from '../middleware/error-handler';
import { AuditEventType, EvidenceSeverity, EvidenceType, ExportFormat } from '@djimitflo/shared';

let db: ReturnType<typeof createTestDb>;
let service: EvidenceService;
const user = { sub: 'fixture-admin', role: 'admin', email: 'fixture@example.test' } as any;
function app() {
  const instance = express();
  instance.use('/evidence', createEvidenceRoutes(db, { requireAuth: (req: any, _res: any, next: any) => { req.user = user; next(); } } as any));
  instance.use(errorHandler);
  return instance;
}
beforeEach(() => {
  db = createTestDb(); db.exec(schema); service = new EvidenceService(db);
  db.prepare("INSERT INTO users (id,email,password_hash,role) VALUES ('fixture-admin','fixture@example.test','fixture','admin')").run();
  db.prepare("INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,metadata) VALUES ('fixture','Fixture task','No provider execution','awaiting_approval','medium','medium','review_only',?)").run(JSON.stringify({ executorKind: 'codex' }));
});
afterEach(() => { db.close(); vi.useRealTimers(); });

it('reports a pending approval without inventing denial, start time, or policy allowance', async () => {
  const response = await request(app()).get('/evidence/summary/fixture');
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ task_id: 'fixture', final_status: 'awaiting_approval', started_at: null, completed_at: null, policy_decision: 'unknown', executor_kind: 'codex', approval_required: true, approval_granted: null });
  expect(response.body.metadata).toMatchObject({ executor_source: 'task_configuration', approval_status: 'pending' });
  expect(db.prepare('SELECT started_at FROM execution_summaries').get()).toEqual({ started_at: '' });
});

it('recalculates the HTTP review from persisted changes while retaining materialized identity', async () => {
  const initial = (await request(app()).get('/evidence/review/fixture')).body.summary;
  const started = '2026-09-09T10:00:00Z'; const completed = '2026-09-09T10:00:01Z';
  db.prepare("UPDATE tasks SET status='completed',started_at=?,completed_at=?,execution_time_ms=0,token_usage=0 WHERE id='fixture'").run(started, completed);
  db.prepare("INSERT INTO execution_events(id,task_id,event_type,level,message,metadata) VALUES ('event','fixture','tool.call','info','Fixture event',?)").run(JSON.stringify({ executorKind: 'mock' }));
  db.prepare("INSERT INTO file_changes(id,task_id,file_path,change_type,risk_level,detected_at) VALUES ('file','fixture','fixture.txt','modified','low',?)").run(completed);
  service.captureEvidence({ task_id: 'fixture', evidence_type: EvidenceType.EXECUTION_SUMMARY, severity: EvidenceSeverity.INFO, title: 'Policy result fixture', summary: 'No worker executed', source: 'system', details: { policyDecision: 'allow' } });
  const second = (await request(app()).get('/evidence/review/fixture')).body.summary;
  expect(second).toMatchObject({ id: initial.id, created_at: initial.created_at, final_status: 'completed', started_at: started, completed_at: completed, executor_kind: 'mock', policy_decision: 'allow', event_count: 1, evidence_count: 1, tool_call_count: 1, files_changed: ['fixture.txt'], duration_ms: 0, token_usage: 0 });
  expect(second.metadata).toMatchObject({ requested_executor_kind: 'codex', executor_source: 'execution_event' });
  expect(db.prepare('SELECT count(*) AS count FROM execution_summaries').get()).toEqual({ count: 1 });
  expect(db.prepare('SELECT final_status,completed_at FROM execution_summaries').get()).toEqual({ final_status: 'completed', completed_at: completed });
});

it('exports current completion even if the first summary was materialized during approval', () => {
  service.getExecutionSummary('fixture');
  db.prepare("UPDATE tasks SET status='completed',completed_at='2026-09-09T10:00:01Z' WHERE id='fixture'").run();
  const exported = JSON.parse(new ExportService(db).exportTask('fixture', user, { format: ExportFormat.JSON }).data);
  expect(exported.summary.final_status).toBe('completed');
  expect(exported.summary.completed_at).toBe('2026-09-09T10:00:01Z');
});

it('does not let an older grant hide a currently pending or denied approval', () => {
  db.prepare("INSERT INTO approvals(id,task_id,status) VALUES ('old','fixture','approved'),('current','fixture','pending')").run();
  expect(service.getExecutionSummary('fixture')).toMatchObject({ approval_granted: null, metadata: { approval_status: 'pending' } });
  db.prepare("UPDATE tasks SET status='cancelled' WHERE id='fixture'").run();
  db.prepare("UPDATE approvals SET status='denied' WHERE id='current'").run();
  expect(service.getExecutionSummary('fixture')).toMatchObject({ final_status: 'cancelled', approval_granted: false, metadata: { approval_status: 'denied' } });
});

it('reads malformed historical metadata as unknown instead of crashing or inventing an executor', () => {
  db.prepare("UPDATE tasks SET metadata='not-json' WHERE id='fixture'").run();
  expect(service.getExecutionSummary('fixture')).toMatchObject({ executor_kind: 'unknown', policy_decision: 'unknown' });
});

it('reads the actual engine approval-hold evidence shape without treating the assessment recommendation as a decision', () => {
  service.captureEvidence({ task_id: 'fixture', evidence_type: EvidenceType.RISK_ASSESSMENT, severity: EvidenceSeverity.WARNING, title: 'Execution requires approval', summary: 'Synthetic copy of engine capture contract', source: 'policy', details: { assessment: { recommended_decision: 'allow' }, matchingPolicies: [], decision: 'require_approval' } });
  expect(service.getExecutionSummary('fixture')).toMatchObject({ policy_decision: 'require_approval', started_at: null, final_status: 'awaiting_approval' });
  service.captureEvidence({ task_id: 'fixture', evidence_type: EvidenceType.POLICY_DECISION, severity: EvidenceSeverity.CRITICAL, title: 'Execution denied by policy', summary: 'Synthetic decision transition', source: 'policy', details: { decision: 'deny' } });
  db.prepare("UPDATE tasks SET status='cancelled' WHERE id='fixture'").run();
  expect(service.getExecutionSummary('fixture')).toMatchObject({ policy_decision: 'deny', final_status: 'cancelled' });
});

it('preserves task access masking before materializing a summary', async () => {
  const instance = express();
  instance.use('/evidence', createEvidenceRoutes(db, { requireAuth: (req: any, _res: any, next: any) => { req.user = { sub: 'other', role: 'maker' }; next(); } } as any));
  expect((await request(instance).get('/evidence/summary/fixture')).status).toBe(404);
  expect(db.prepare('SELECT count(*) AS count FROM execution_summaries').get()).toEqual({ count: 0 });
});

it('reports a fresh matching execution grant without losing older denials or unrelated manual history', () => {
  db.prepare("UPDATE tasks SET status='completed' WHERE id='fixture'").run();
  const insert = db.prepare('INSERT INTO approvals(id,task_id,status,metadata,created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('old-denial', 'fixture', 'denied', JSON.stringify({ executorKind: 'codex' }), '2026-09-09T10:00:00Z');
  insert.run('current-grant', 'fixture', 'approved', JSON.stringify({ executorKind: 'codex' }), '2026-09-09T11:00:00Z');
  insert.run('manual-denial', 'fixture', 'denied', JSON.stringify({ manual_action: true }), '2026-09-09T12:00:00Z');
  insert.run('other-runtime-denial', 'fixture', 'denied', JSON.stringify({ executorKind: 'opencode' }), '2026-09-09T13:00:00Z');
  const summary = service.getExecutionSummary('fixture')!;
  expect(summary).toMatchObject({ final_status: 'completed', approval_granted: true, metadata: { approval_status: 'approved', approval_id: 'current-grant', approval_scope: 'recorded_execution_approval' } });
  expect(summary.metadata.approval_history).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'old-denial', status: 'denied', manual_action: false }),
    expect.objectContaining({ id: 'manual-denial', status: 'denied', manual_action: true }),
    expect.objectContaining({ id: 'other-runtime-denial', executor_kind: 'opencode' }),
  ]));
  db.prepare("UPDATE approvals SET status='pending' WHERE id='manual-denial'").run();
  expect(service.getExecutionSummary('fixture')).toMatchObject({ approval_granted: true, metadata: { approval_status: 'approved' } });
  db.prepare("UPDATE approvals SET status='pending' WHERE id='old-denial'").run();
  expect(service.getExecutionSummary('fixture')).toMatchObject({ approval_granted: null, metadata: { approval_status: 'pending', approval_id: 'old-denial' } });
});

it('does not turn unrelated manual-only decisions into an execution approval requirement', () => {
  db.prepare("UPDATE tasks SET status='pending' WHERE id='fixture'").run();
  db.prepare("INSERT INTO approvals(id,task_id,status,metadata) VALUES ('manual','fixture','denied',?)").run(JSON.stringify({ manual_action: true }));
  expect(service.getExecutionSummary('fixture')).toMatchObject({ approval_required: false, approval_granted: null, metadata: { approval_status: 'not_recorded', approval_id: null } });
});

it('uses the actual queue-admission policy decision after an earlier allow', () => {
  service.captureEvidence({ task_id: 'fixture', evidence_type: EvidenceType.EXECUTION_SUMMARY, severity: EvidenceSeverity.INFO, title: 'Initial decision', summary: 'Synthetic admitted queue', source: 'system', details: { policyDecision: 'allow' } });
  service.captureEvidence({ task_id: 'fixture', evidence_type: EvidenceType.POLICY_DECISION, severity: EvidenceSeverity.CRITICAL, title: 'Admission changed', summary: 'Synthetic post-capacity denial', source: 'queue-admission', details: { previousDecision: 'allow', decision: 'deny', executorKind: 'codex' } });
  expect(service.getExecutionSummary('fixture')).toMatchObject({ policy_decision: 'deny', started_at: null });
});

it('keeps canonical request history stable and records a later actual approval decision only once', () => {
  const requestedAt = '2026-09-09T10:00:00.000Z';
  const decidedAt = '2026-09-09T10:01:00.000Z';
  vi.useFakeTimers(); vi.setSystemTime(new Date(requestedAt));
  db.prepare('INSERT INTO approvals(id,task_id,status,requested_by,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run('timeline', 'fixture', 'pending', 'maker', requestedAt, '2026-09-09T11:00:00.000Z');
  const audit = new AuditService(db);
  audit.record({ event_type: AuditEventType.APPROVAL_REQUESTED, action: 'approval_requested', resource_type: 'approval', resource_id: 'timeline', task_id: 'fixture' });
  const before = service.getAuditTrail('fixture').filter(entry => entry.resource_id === 'timeline');
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ timestamp: requestedAt, event_type: 'approval.requested' });
  vi.setSystemTime(new Date(decidedAt));
  new ApprovalService(db, { broadcastTaskEventById: () => {} }, audit).decideApproval('timeline', true, 'fixture-admin');
  const after = service.getAuditTrail('fixture').filter(entry => entry.resource_id === 'timeline');
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]).toMatchObject({ timestamp: decidedAt, event_type: 'approval.granted' });
});

it('labels legacy projections and uses actual decision timestamps without rewriting the request', () => {
  const requestedAt = '2026-09-09T10:00:00Z';
  const decidedAt = '2026-09-09T10:02:00Z';
  db.prepare('INSERT INTO approvals(id,task_id,status,requested_by,created_at) VALUES (?,?,?,?,?)').run('legacy', 'fixture', 'pending', 'legacy-maker', requestedAt);
  const before = service.getAuditTrail('fixture');
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ event_type: 'approval.requested', actor: 'legacy-maker', timestamp: requestedAt, metadata: { source: 'legacy_approval_projection', timestamp_source: 'created_at' } });
  db.prepare('UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=?').run('approved', decidedAt, 'fixture-admin', 'legacy');
  const after = service.getAuditTrail('fixture');
  expect(after).toHaveLength(2);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]).toMatchObject({ event_type: 'approval.granted', timestamp: decidedAt, actor: 'fixture-admin', metadata: { source: 'legacy_approval_projection', timestamp_source: 'decided_at' } });
  db.prepare("UPDATE approvals SET decided_at=NULL WHERE id='legacy'").run();
  expect(service.getAuditTrail('fixture')).toEqual(before);
});
