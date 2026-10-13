import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalRequestType, type RiskAssessment, type Task } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { approvalOutcomes } from '../services/intelligence-metrics';

/** §16 step 2 (ADQ blocker): an approval created for a loop worker task carries its loop run, goal and proposal. */
let db: Database.Database;
let service: ApprovalService;
const assessment = { action_type: 'shell_command', risk_level: 'high', matched_rules: [], explanation: 'x', recommended_decision: 'require_approval', metadata: {} } as RiskAssessment;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.TELEGRAM_PUSH_DELAY_MS = '0';
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES ('imp1', 'feature', 't', 'd', 'r', 'test-gap', 'verified', datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id, created_at, updated_at) VALUES ('g1', 'o', 'low', 'running', 'imp1', datetime('now'), datetime('now'))").run();
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run1', 'g1', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))`).run();
  const meta = JSON.stringify({ loop_run_id: 'run1', lease_id: 'lease1' });
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('loop-worker-lease1-ab', 'maker', 'p', 'pending', 'low', 'low', 'local', ?)").run(meta);
  db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode) VALUES ('plain', 'plain', 'p', 'pending', 'low', 'low', 'local')").run();
  service = new ApprovalService(db, { broadcastTaskEventById: vi.fn() }, new AuditService(db));
});
afterEach(() => { db.close(); vi.restoreAllMocks(); delete process.env.TELEGRAM_PUSH_DELAY_MS; });

const create = (taskId: string, metadata: Record<string, unknown> = { executorKind: 'opencode' }) => service.createApproval({
  task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task, assessment, requestType: ApprovalRequestType.HIGH_RISK_ACTION,
  title: 'Approval required before task execution', description: 'x', requestedBy: 'dispatcher', metadata });

it('§16 step 2: a loop worker approval stores loop_run_id, lease_id, goal_id and improvement_id next to the caller metadata', () => {
  const a = create('loop-worker-lease1-ab');
  const stored = JSON.parse((db.prepare('SELECT metadata FROM approvals WHERE id = ?').get(a.id) as { metadata: string }).metadata);
  expect(stored).toEqual({ executorKind: 'opencode', loop_run_id: 'run1', lease_id: 'lease1', goal_id: 'g1', improvement_id: 'imp1' });
});

it('§16 step 2: caller metadata wins over the derived link, and a non-loop task gets no link', () => {
  const a = create('loop-worker-lease1-ab', { executorKind: 'opencode', goal_id: 'explicit' });
  expect(JSON.parse((db.prepare('SELECT metadata FROM approvals WHERE id = ?').get(a.id) as { metadata: string }).metadata).goal_id).toBe('explicit');
  const b = create('plain');
  expect(JSON.parse((db.prepare('SELECT metadata FROM approvals WHERE id = ?').get(b.id) as { metadata: string }).metadata)).toEqual({ executorKind: 'opencode' });
});

it('§16 step 2: the ADQ join reads the stored link and the autonomy decider is recorded as service (guards #725)', () => {
  const a = create('loop-worker-lease1-ab');
  service.decideApproval(a.id, true, 'autonomy:oracle-lane-v1', 'oracle lane');
  // the task row going away (pruned) no longer breaks the join: the link lives on the approval
  db.prepare("UPDATE tasks SET metadata = '{}' WHERE id = 'loop-worker-lease1-ab'").run();
  const rows = approvalOutcomes(db, '2000-01-01');
  expect(rows).toEqual([expect.objectContaining({ id: a.id, status: 'approved', decided_by: 'autonomy:oracle-lane-v1', stored_goal: 'g1', lane: 'doc-drift-and-small-fix-loop', outcome: 'verified' })]);
  const actor = db.prepare("SELECT actor_type FROM authority_events WHERE artifact_id = ? AND actor_subject = 'autonomy:oracle-lane-v1'").get(a.id) as { actor_type: string } | undefined;
  expect(actor?.actor_type).toBe('service');
});
