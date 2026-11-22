import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  autonomyShadowEnabled,
  FINDING_FIX_AUTO_APPROVER,
  FINDING_FIX_AUTO_APPROVE_MAX_LINES,
  FINDING_FIX_AUTO_APPROVE_REVOKED,
  findingFixAutoApproveOn,
  findingFixAutoApproveRevoked,
} from '../services/autonomy-shadow-service';

const APPROVER = 'autonomy:finding-fix-v1';
const FILE = 'packages/server/src/services/ollama-outage-fallback.ts';

describe('autonomyShadowEnabled', () => {
  const prev = process.env.AUTONOMY_SHADOW_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTONOMY_SHADOW_ENABLED;
    else process.env.AUTONOMY_SHADOW_ENABLED = prev;
  });

  it('returns false when AUTONOMY_SHADOW_ENABLED is unset', () => {
    delete process.env.AUTONOMY_SHADOW_ENABLED;
    expect(autonomyShadowEnabled()).toBe(false);
  });

  it('returns true only when AUTONOMY_SHADOW_ENABLED is "true"', () => {
    process.env.AUTONOMY_SHADOW_ENABLED = 'true';
    expect(autonomyShadowEnabled()).toBe(true);
  });

  it('returns false for any other value', () => {
    process.env.AUTONOMY_SHADOW_ENABLED = 'false';
    expect(autonomyShadowEnabled()).toBe(false);
    process.env.AUTONOMY_SHADOW_ENABLED = '1';
    expect(autonomyShadowEnabled()).toBe(false);
  });
});

describe('findingFixAutoApproveOn', () => {
  it('returns false when FINDING_FIX_AUTO_APPROVE is unset', () => {
    expect(findingFixAutoApproveOn({})).toBe(false);
  });

  it('returns true only when FINDING_FIX_AUTO_APPROVE is "on"', () => {
    expect(findingFixAutoApproveOn({ FINDING_FIX_AUTO_APPROVE: 'on' })).toBe(true);
  });

  it('returns false for any other value', () => {
    expect(findingFixAutoApproveOn({ FINDING_FIX_AUTO_APPROVE: 'off' })).toBe(false);
    expect(findingFixAutoApproveOn({ FINDING_FIX_AUTO_APPROVE: 'true' })).toBe(false);
    expect(findingFixAutoApproveOn({ FINDING_FIX_AUTO_APPROVE: '1' })).toBe(false);
  });

  it('reads process.env by default', () => {
    const prev = process.env.FINDING_FIX_AUTO_APPROVE;
    try {
      delete process.env.FINDING_FIX_AUTO_APPROVE;
      expect(findingFixAutoApproveOn()).toBe(false);
      process.env.FINDING_FIX_AUTO_APPROVE = 'on';
      expect(findingFixAutoApproveOn()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FINDING_FIX_AUTO_APPROVE;
      else process.env.FINDING_FIX_AUTO_APPROVE = prev;
    }
  });
});

describe('exported constants', () => {
  it('FINDING_FIX_AUTO_APPROVER is the autonomy:finding-fix-v1 approver id', () => {
    expect(FINDING_FIX_AUTO_APPROVER).toBe(APPROVER);
  });

  it('FINDING_FIX_AUTO_APPROVE_MAX_LINES is 40', () => {
    expect(FINDING_FIX_AUTO_APPROVE_MAX_LINES).toBe(40);
  });

  it('FINDING_FIX_AUTO_APPROVE_REVOKED is the revocation judgment name', () => {
    expect(FINDING_FIX_AUTO_APPROVE_REVOKED).toBe('finding_fix_auto_approve_revoked');
  });
});

describe('findingFixAutoApproveRevoked', () => {
  let db: Database.Database;
  const prev: Record<string, string | undefined> = { FINDING_FIX_AUTO_APPROVE: process.env.FINDING_FIX_AUTO_APPROVE };

  const proposal = (id: string, status: string) =>
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, grounding_json, evidence_refs_json, created_at, updated_at)
      VALUES (?, 'refactor', 'Fix only finding', 'Fix only finding.', 'r', 'gap_analysis', ?, 0.6, '{}', '[]', datetime('now'), datetime('now'))`).run(id, status);

  /** An earlier run whose maker approval autonomy:finding-fix-v1 decided, with the given proposal status / run metadata. */
  const earlierAutoApprovedRun = (status: string, runMeta: Record<string, unknown> = {}) => {
    proposal('old', status);
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('goal-old', 'old', 'high', 'completed', 'old')").run();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata) VALUES ('run-old', 'goal-old', 'doc-drift-and-small-fix-loop', 'closed', 'completed', ?)").run(JSON.stringify(runMeta));
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES ('lease-old', 'run-old', 'maker', 'opencode', 'completed', '{"approval_id":"appr-old"}', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, decided_at)
      VALUES ('appr-old', 'task-old', 'approved', 'high', 'high_risk_action', 'm', '{}', ?, datetime('now'))`).run(FINDING_FIX_AUTO_APPROVER);
  };

  const revokedJudgments = () =>
    db.prepare('SELECT subject_id, decision, reason FROM judgments WHERE judgment = ?').all(FINDING_FIX_AUTO_APPROVE_REVOKED) as Array<{ subject_id: string; decision: string; reason: string }>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(schema);
    runMigrations(db);
    prev.FINDING_FIX_AUTO_APPROVE = process.env.FINDING_FIX_AUTO_APPROVE;
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    if (prev.FINDING_FIX_AUTO_APPROVE === undefined) delete process.env.FINDING_FIX_AUTO_APPROVE;
    else process.env.FINDING_FIX_AUTO_APPROVE = prev.FINDING_FIX_AUTO_APPROVE;
  });

  it('returns null when there is no prior revocation and no regressed auto-approved run', () => {
    expect(findingFixAutoApproveRevoked(db)).toBeNull();
    expect(revokedJudgments()).toEqual([]);
  });

  it('returns null for a verified auto-approved run that survived merge', () => {
    earlierAutoApprovedRun('verified', { pr_outcome: { state: 'merged', survived: true } });
    expect(findingFixAutoApproveRevoked(db)).toBeNull();
    expect(revokedJudgments()).toEqual([]);
  });

  it('records and returns the revocation when the proposal outcome regressed', () => {
    earlierAutoApprovedRun('regressed', {});
    const result = findingFixAutoApproveRevoked(db);
    expect(result).toEqual({ run_id: 'run-old', reason: expect.stringContaining('outcome regressed') });
    expect(revokedJudgments()).toEqual([
      expect.objectContaining({ subject_id: 'run-old', decision: 'revoked', reason: result!.reason }),
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = ?").get(FINDING_FIX_AUTO_APPROVE_REVOKED)).toEqual({ n: 1 });
  });

  it('records revocation when merge survival settled regressed', () => {
    earlierAutoApprovedRun('verified', { pr_outcome: { state: 'merged', survived: false } });
    const result = findingFixAutoApproveRevoked(db);
    expect(result).toEqual({ run_id: 'run-old', reason: expect.stringContaining('merge survival settled regressed') });
    expect(revokedJudgments()).toHaveLength(1);
  });

  it('records revocation when a settlement judgment failed', () => {
    earlierAutoApprovedRun('verified', { pr_outcome: { state: 'merged', survived: true } });
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES ('s1', 'settlement_execution', 'loop_run', 'run-old', '', 'shadow', 'fail', 'tests failed at origin/main', '{}', datetime('now'))`).run();
    const result = findingFixAutoApproveRevoked(db);
    expect(result).toEqual({ run_id: 'run-old', reason: expect.stringContaining('settlement fail') });
  });

  it('records revocation when a settlement was removed', () => {
    earlierAutoApprovedRun('verified', { pr_outcome: { state: 'merged', survived: true } });
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES ('s1', 'settlement_execution', 'loop_run', 'run-old', '', 'shadow', 'removed', 'settlement removed', '{}', datetime('now'))`).run();
    const result = findingFixAutoApproveRevoked(db);
    expect(result).toEqual({ run_id: 'run-old', reason: expect.stringContaining('settlement removed') });
  });

  it('records revocation when the auto-merge window was revoked (revert on main)', () => {
    earlierAutoApprovedRun('verified', { auto_merge: { decision: 'merged', revoked: 'PR #9: reverted on main by abcdef12' } });
    const result = findingFixAutoApproveRevoked(db);
    expect(result).toEqual({ run_id: 'run-old', reason: expect.stringContaining('auto-merge window revoked') });
  });

  it('reads back the prior revocation judgment without re-recording or re-auditing', () => {
    earlierAutoApprovedRun('regressed', {});
    const first = findingFixAutoApproveRevoked(db);
    expect(first).not.toBeNull();
    const second = findingFixAutoApproveRevoked(db);
    expect(second).toEqual(first);
    expect(revokedJudgments()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = ?").get(FINDING_FIX_AUTO_APPROVE_REVOKED)).toEqual({ n: 1 });
  });

  it('returns the prior revocation even after the regression signal is cleared', () => {
    earlierAutoApprovedRun('regressed', {});
    findingFixAutoApproveRevoked(db);
    db.prepare("UPDATE self_improvements SET status = 'verified' WHERE id = 'old'").run();
    db.prepare("UPDATE loop_runs SET metadata = '{}' WHERE id = 'run-old'").run();
    const result = findingFixAutoApproveRevoked(db);
    expect(result).toEqual({ run_id: 'run-old', reason: expect.stringContaining('outcome regressed') });
    expect(revokedJudgments()).toHaveLength(1);
  });

  it('ignores approvals decided by a different approver', () => {
    proposal('old', 'regressed');
    db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('goal-old', 'old', 'high', 'completed', 'old')").run();
    db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-old', 'goal-old', 'doc-drift-and-small-fix-loop', 'closed', 'completed')").run();
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES ('lease-old', 'run-old', 'maker', 'opencode', 'completed', '{"approval_id":"appr-old"}', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, decided_at)
      VALUES ('appr-old', 'task-old', 'approved', 'high', 'high_risk_action', 'm', '{}', 'human:operator', datetime('now'))`).run();
    expect(findingFixAutoApproveRevoked(db)).toBeNull();
    expect(revokedJudgments()).toEqual([]);
  });
});
