import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { RsiSafetyGuard } from '../services/rsi-safety-guard';
import { decisionsInbox } from '../services/decisions-inbox';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

it('memory review: waiting candidates appear in the inbox; reject records who and why and cannot be promoted afterwards', () => {
  const svc = new MemoryCandidateService(db);
  const c = svc.create({ title: 'djimit-unguarded-json-extract', content: 'Never JSON.parse model output without a guard.', memory_type: 'engineering_rule', source_ref: 'test' } as never);
  expect(decisionsInbox(db).memory.map((m) => m.id)).toContain(c.id);
  const r = svc.reject(c.id, 'dennis', 'duplicate of an existing rule');
  expect(r.status).toBe('rejected');
  expect(r.metadata).toMatchObject({ rejected_by: 'dennis', rejected_reason: 'duplicate of an existing rule' });
  expect(decisionsInbox(db).memory.map((m) => m.id)).not.toContain(c.id);
  expect(() => svc.promote(c.id, { approved_by: 'dennis', human_approved: true })).toThrow('MEMORY_PROMOTION_REJECTED_CANDIDATE');
  expect(() => svc.reject(c.id, ' ')).toThrow('MEMORY_REJECT_ACTOR_REQUIRED');
});

it('mutation gate: the audit row names the operator who switched it', () => {
  const guard = new RsiSafetyGuard(db);
  guard.setEnabled(false, 'dennis');
  expect(db.prepare("SELECT actor, details_json FROM rsi_audit_log WHERE action = 'kill_switch' ORDER BY created_at DESC LIMIT 1").get())
    .toEqual({ actor: 'dennis', details_json: '{"enabled":false}' });
});

it('P0-9: a human_required rule is not promoted by an approved_by string without an authenticated user id', () => {
  const svc = new MemoryCandidateService(db);
  const c = svc.create({ title: 'policy', content: 'Never auto-merge without a green check.', memory_type: 'policy_rule', source_ref: 'test' } as never);
  expect(c.human_required).toBeTruthy();
  expect(() => svc.promote(c.id, { approved_by: 'proof-run-service' })).toThrow('MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  expect(() => svc.promote(c.id, { approved_by: 'dennis', human_approved: true })).toThrow('MEMORY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
  expect(svc.get(c.id).status).toBe('review_required');
  const out = svc.promote(c.id, { approved_by: 'dennis@example.test', human_approved: true, approver_user_id: 'user-1' });
  expect(out.candidate.status).toBe('promoted');
  expect(out.candidate.metadata).toMatchObject({ approver_type: 'human', approver_user_id: 'user-1' });
});

it('P0-9: a machine approver keeps promoting non-human rules, recorded as approver_type machine', () => {
  const svc = new MemoryCandidateService(db);
  const c = svc.create({ title: 'rule', content: 'Guard JSON.parse on model output.', memory_type: 'engineering_rule', source_ref: 'test' } as never);
  const out = svc.promote(c.id, { approved_by: 'proof-run-service' });
  expect(out.candidate.status).toBe('promoted');
  expect(out.candidate.metadata).toMatchObject({ approver_type: 'machine', promoted_by: 'proof-run-service' });
  expect(out.candidate.metadata).not.toHaveProperty('approver_user_id');
});
