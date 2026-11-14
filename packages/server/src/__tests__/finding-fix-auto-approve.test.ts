import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { findingFixAutoApproveScope } from '../services/autonomy-shadow-service';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { REVIEWER_INHERITABLE_AUTONOMY_APPROVERS } from '../execution/execution-engine';
import type { LoopService } from '../services/loop-service';

/** FINDING_FIX_AUTO_APPROVE (operator 2026-11-14): a finding-fix lane maker is approved by autonomy:finding-fix-v1. */
const ENV = ['FINDING_FIX_AUTO_APPROVE', 'LOOP_AUTO_APPROVE_TEST_GAP', 'ORACLE_LANES_AUTO_APPROVE', 'AUTONOMY_SHADOW_ENABLED', 'SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE'];
const FILE = 'packages/server/src/services/ollama-outage-fallback.ts';
const REFS = JSON.stringify(['finding-fix:primary/0123456789abcdef', 'finding-rule:no-useless-assignment', `finding-file:${FILE}`, 'finding-occ:0', 'finding-pack:fedcba9876543210']);
let db: Database.Database;
let goalId: string;
const prev: Record<string, string | undefined> = {};

const proposal = (id: string, status: string, refs = REFS, artifact = FILE) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, grounding_json, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'refactor', 'Fix only finding no-useless-assignment', 'Fix only finding no-useless-assignment. Edit only the file.', 'r', 'gap_analysis', ?, 0.6, ?, ?, datetime('now'), datetime('now'))`)
    .run(id, status, JSON.stringify({ target: artifact, artifactPath: artifact }), refs);

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  for (const k of ENV) { prev[k] = process.env[k]; delete process.env[k]; }
  process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true';
  goalId = new GoalService(db).createGoal({ objective: 'Fix only finding no-useless-assignment', acceptance_criteria: ['pass'], risk_class: 'low', metadata: { source: 'self-improvement' } }).id;
  proposal('cur', 'executing');
  db.prepare("UPDATE goals SET status = 'decomposed', improvement_id = 'cur' WHERE id = ?").run(goalId);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { db.close(); vi.restoreAllMocks(); for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const tick = async () => {
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-a', ?, 'doc-drift-and-small-fix-loop', 'closed', 'running')").run(goalId);
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('lease-a', 'run-a', 'maker', 'opencode', 'prepared', '{\"approval_id\":\"appr-1\",\"diff_max_lines\":60}', datetime('now'), datetime('now'))").run();
  const decideWorkerApproval = vi.fn(async () => null);
  const loops = {
    pruneOrphanedWorktrees: vi.fn(), decideWorkerApproval,
    startObjectiveLoop: vi.fn(() => ({ id: 'run-a', findings: [{ id: 'f1' }] })),
    continueLoopRun: vi.fn(() => ({ run: { id: 'run-a' }, leases: [{ id: 'lease-a', role: 'maker', status: 'prepared', runtime: 'opencode' }] })),
    executeWorker: vi.fn(async () => { throw new Error('LOOP_WORKER_APPROVAL_REQUIRED'); }),
  };
  const d = new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await d.tick(); d.stop();
  return decideWorkerApproval;
};
const leaseMeta = () => JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'lease-a'").get() as { metadata: string }).metadata) as Record<string, unknown>;
const judgments = (name: string) => db.prepare('SELECT subject_id, decision, reason FROM judgments WHERE judgment = ?').all(name) as Array<{ subject_id: string; decision: string; reason: string }>;

/** An earlier finding-fix run whose maker approval autonomy:finding-fix-v1 decided, with the given proposal status / run metadata. */
const earlierAutoApprovedRun = (status: string, runMeta: Record<string, unknown> = {}) => {
  proposal('old', status, JSON.stringify(['finding-fix:primary/aaaaaaaaaaaaaaaa', `finding-file:${FILE}`]));
  const old = new GoalService(db).createGoal({ objective: 'old', acceptance_criteria: ['pass'], risk_class: 'high', metadata: {} }).id;
  db.prepare("UPDATE goals SET status = 'completed', improvement_id = 'old' WHERE id = ?").run(old);
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata) VALUES ('run-old', ?, 'doc-drift-and-small-fix-loop', 'closed', 'completed', ?)").run(old, JSON.stringify(runMeta));
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('lease-old', 'run-old', 'maker', 'opencode', 'completed', '{\"approval_id\":\"appr-old\"}', datetime('now'), datetime('now'))").run();
  db.prepare(`INSERT INTO approvals (id, task_id, status, risk_level, request_type, request_message, request_data, decided_by, decided_at)
    VALUES ('appr-old', 'task-old', 'approved', 'high', 'high_risk_action', 'm', '{}', 'autonomy:finding-fix-v1', datetime('now'))`).run();
};

describe('FINDING_FIX_AUTO_APPROVE', () => {
  it('off (default): the finding-fix maker approval stays pending for the human, nothing is pinned or recorded', async () => {
    expect(await tick()).not.toHaveBeenCalled();
    expect(leaseMeta()).toEqual({ approval_id: 'appr-1', diff_max_lines: 60 });
    expect(judgments('finding_fix_auto_approve')).toEqual([]);
    expect(findingFixAutoApproveScope(db, goalId)).toBeNull();
  });

  it('on: approved by autonomy:finding-fix-v1, scope pinned to the finding file with the 40-line cap, judgment + loop event', async () => {
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    const decide = await tick();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith('appr-1', true, 'autonomy:finding-fix-v1', expect.stringContaining(`finding-fix lane, scope ${FILE}`));
    expect(leaseMeta()).toMatchObject({ auto_approved_scope: FILE, auto_approved_max_lines: 40, diff_max_lines: 60 });
    expect(judgments('finding_fix_auto_approve')).toEqual([expect.objectContaining({ subject_id: 'appr-1', decision: 'approve' })]);
    expect(db.prepare("SELECT COUNT(*) n FROM loop_events WHERE event_type = 'goal_auto_approved'").get()).toEqual({ n: 1 });
  });

  it('on: the reviewer of an approved run inherits it like the oracle-lane approver', () => {
    expect(REVIEWER_INHERITABLE_AUTONOMY_APPROVERS).toContain('autonomy:finding-fix-v1');
  });

  it('on: a high-risk proposal that is not a finding-fix lane proposal stays pending', async () => {
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    db.prepare("UPDATE self_improvements SET evidence_refs_json = '[\"reflection:x\"]' WHERE id = 'cur'").run();
    expect(await tick()).not.toHaveBeenCalled();
    expect(leaseMeta().auto_approved_scope).toBeUndefined();
  });

  it.each([
    ['artifactPath not the finding file', REFS, 'packages/server/src/services/other.ts'],
    ['no finding-fix ref', JSON.stringify([`finding-file:${FILE}`]), FILE],
    ['no finding-file ref', JSON.stringify(['finding-fix:primary/0123456789abcdef']), FILE],
    ['a test file', JSON.stringify(['finding-fix:primary/x', 'finding-file:packages/server/src/__tests__/a.test.ts']), 'packages/server/src/__tests__/a.test.ts'],
    ['a manifest', JSON.stringify(['finding-fix:primary/x', 'finding-file:packages/server/package.json']), 'packages/server/package.json'],
    ['outside packages/server/src', JSON.stringify(['finding-fix:primary/x', 'finding-file:.github/workflows/ci.yml']), '.github/workflows/ci.yml'],
  ])('on: no scope when %s', (_label, refs, artifact) => {
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    db.prepare('UPDATE self_improvements SET evidence_refs_json = ?, grounding_json = ? WHERE id = ?').run(refs, JSON.stringify({ artifactPath: artifact }), 'cur');
    expect(findingFixAutoApproveScope(db, goalId)).toBeNull();
  });

  it.each([
    ['outcome regressed', 'regressed', {}],
    ['settlement regressed (merged, lines removed)', 'verified', { pr_outcome: { state: 'merged', survived: false } }],
    ['revert (auto-merge window revoked)', 'verified', { auto_merge: { decision: 'merged', revoked: 'PR #9: reverted on main by abcdef12' } }],
  ])('self-revocation: after a %s run approved by autonomy:finding-fix-v1, no further auto-approval', async (_label, status, runMeta) => {
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    earlierAutoApprovedRun(status, runMeta);
    expect(await tick()).not.toHaveBeenCalled();
    const revoked = judgments('finding_fix_auto_approve_revoked');
    expect(revoked).toEqual([expect.objectContaining({ subject_id: 'run-old', decision: 'revoked' })]);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'finding_fix_auto_approve_revoked'").get()).toEqual({ n: 1 });
    // the revoked state is read back from the judgments row: it holds even after the regression signal is gone
    db.prepare("UPDATE self_improvements SET status = 'verified' WHERE id = 'old'").run();
    db.prepare("UPDATE loop_runs SET metadata = '{}' WHERE id = 'run-old'").run();
    expect(findingFixAutoApproveScope(db, goalId)).toBeNull();
    expect(judgments('finding_fix_auto_approve_revoked')).toHaveLength(1);
  });

  it('self-revocation: a failed settlement of an auto-approved run revokes the lane', () => {
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    earlierAutoApprovedRun('verified', { pr_outcome: { state: 'merged', survived: true } });
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES ('s1', 'settlement_execution', 'loop_run', 'run-old', '', 'shadow', 'fail', 'tests failed at origin/main', '{}', datetime('now'))`).run();
    expect(findingFixAutoApproveScope(db, goalId)).toBeNull();
    expect(judgments('finding_fix_auto_approve_revoked')).toEqual([expect.objectContaining({ subject_id: 'run-old', reason: expect.stringContaining('settlement fail') })]);
  });

  it('a verified earlier auto-approved run does not revoke the lane', () => {
    process.env.FINDING_FIX_AUTO_APPROVE = 'on';
    earlierAutoApprovedRun('verified', { pr_outcome: { state: 'merged', survived: true } });
    expect(findingFixAutoApproveScope(db, goalId)).toBe(FILE);
    expect(judgments('finding_fix_auto_approve_revoked')).toEqual([]);
  });

  it('is registered as an acting evolution flag', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'FINDING_FIX_AUTO_APPROVE', acting: true });
  });
});
