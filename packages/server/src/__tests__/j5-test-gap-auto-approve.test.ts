import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { testGapAutoApproveScope } from '../services/autonomy-shadow-service';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';

const ENV = ['LOOP_AUTO_APPROVE_MUTATION_GAP', 'LOOP_AUTO_APPROVE_TEST_GAP', 'AUTONOMY_SHADOW_ENABLED', 'SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED', 'AUTHORITY_GATE'];
const ARTIFACT = 'packages/server/src/__tests__/foo.test.ts';
let db: Database.Database;
let goalId: string;
const prev: Record<string, string | undefined> = {};

const si = (id: string, status: string, refs = '["test-gap:foo"]', artifact = ARTIFACT) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, grounding_json, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'feature', 't', 'Add a test. Test-only; no production code edits.', 'r', 'gap_analysis', ?, 0.6, ?, ?, datetime('now'), datetime('now'))`)
    .run(id, status, JSON.stringify({ artifactPath: artifact }), refs);

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  for (const k of ENV) { prev[k] = process.env[k]; delete process.env[k]; }
  process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED = 'true'; process.env.AUTONOMY_SHADOW_ENABLED = 'true';
  goalId = new GoalService(db).createGoal({ objective: 'Add a test', acceptance_criteria: ['pass'], risk_class: 'low', metadata: { source: 'self-improvement' } }).id;
  si('cur', 'executing'); for (const id of ['v1', 'v2', 'v3']) si(id, 'verified');
  db.prepare("UPDATE goals SET status = 'decomposed', improvement_id = 'cur' WHERE id = ?").run(goalId);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { db.close(); vi.restoreAllMocks(); for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

it('scope only for test-gap goals with a single new test file, and only with the flag', () => {
  expect(testGapAutoApproveScope(db, goalId)).toBeNull(); // default off
  process.env.LOOP_AUTO_APPROVE_TEST_GAP = 'true';
  expect(testGapAutoApproveScope(db, goalId)).toBe(ARTIFACT);
  db.prepare("UPDATE self_improvements SET evidence_refs_json = '[\"reflection:x\"]' WHERE id = 'cur'").run();
  expect(testGapAutoApproveScope(db, goalId)).toBeNull(); // not the test-gap lane
  db.prepare("UPDATE self_improvements SET evidence_refs_json = '[\"test-gap:foo\"]', grounding_json = '{\"artifactPath\":\"packages/server/src/services/foo.ts\"}' WHERE id = 'cur'").run();
  expect(testGapAutoApproveScope(db, goalId)).toBeNull(); // not a test file
});

const tick = async (flag: boolean) => {
  if (flag) process.env.LOOP_AUTO_APPROVE_TEST_GAP = 'true';
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-a', ?, 'doc-drift-and-small-fix-loop', 'closed', 'running')").run(goalId);
  db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('lease-a', 'run-a', 'maker', 'opencode', 'prepared', '{\"approval_id\":\"appr-1\"}', datetime('now'), datetime('now'))").run();
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
const leaseScope = () => JSON.parse((db.prepare("SELECT metadata FROM worker_leases WHERE id = 'lease-a'").get() as { metadata: string }).metadata).auto_approved_scope;

it('the daemon auto-approves a test-gap maker and pins its scope when the flag is on', async () => {
  const decide = await tick(true);
  expect(decide).toHaveBeenCalledWith('appr-1', true, 'autonomy:test-gap-rule-v1', expect.stringContaining('test-only'));
  expect(leaseScope()).toBe(ARTIFACT);
  expect(db.prepare("SELECT COUNT(*) n FROM loop_events WHERE event_type = 'goal_auto_approved'").get()).toEqual({ n: 1 });
});

it('the daemon only waits for the human when the flag is off', async () => {
  const decide = await tick(false);
  expect(decide).not.toHaveBeenCalled();
  expect(leaseScope()).toBeUndefined();
});

it('mutation-gap goals: only with their own flag and after the lane has one verified run', () => {
  process.env.LOOP_AUTO_APPROVE_TEST_GAP = 'true';
  db.prepare("UPDATE self_improvements SET evidence_refs_json = '[\"mutation-gap:foo\"]' WHERE id = 'cur'").run();
  expect(testGapAutoApproveScope(db, goalId)).toBeNull(); // flag off
  process.env.LOOP_AUTO_APPROVE_MUTATION_GAP = 'true';
  expect(testGapAutoApproveScope(db, goalId)).toBeNull(); // lane not proven yet
  si('mut-ok', 'verified', '["mutation-gap:bar"]');
  expect(testGapAutoApproveScope(db, goalId)).toBe(ARTIFACT);
});
