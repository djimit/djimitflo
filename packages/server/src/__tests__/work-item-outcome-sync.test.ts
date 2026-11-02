import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { WorkItemService } from '../services/work-item-service';
import { issueRefsLine, syncWorkItemOutcome } from '../services/work-item-outcome-sync';
import { LoopDaemon } from '../services/loop-daemon';
import type { LoopService } from '../services/loop-service';

// PRC-3: a goal that came from a work item reports its terminal outcome back to that item (WORK_ITEM_OUTCOME_SYNC).
let db: Database.Database; let itemId: string; let goalId: string;
const ON = { WORK_ITEM_OUTCOME_SYNC: 'on' };
const item = () => new WorkItemService(db).get(itemId);
const outbox = () => (db.prepare("SELECT payload_json FROM event_outbox WHERE event_type = 'djimitflo.work_item.updated'").all() as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json));
const events = (type: string) => (db.prepare('SELECT COUNT(*) AS n FROM loop_events WHERE event_type = ?').get(type) as { n: number }).n;
const run = (id: string, prUrl: string | null) => db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata, created_at, updated_at) VALUES (?, ?, 'l', 'closed', 'completed', ?, datetime('now'), datetime('now'))`)
  .run(id, goalId, JSON.stringify(prUrl ? { pr_url: prUrl } : {}));

beforeEach(() => {
  process.env.EVENT_PUBLISH_ENABLED = 'true';
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const svc = new WorkItemService(db);
  itemId = svc.create({ title: 'Fix flaky retry', description: 'd', source: 'github_issue', source_ref: 'o/r#12', status: 'triaged' }).id;
  goalId = svc.convertToGoal(itemId).goal_id;
  run('run-1', 'https://github.com/o/r/pull/9');
});
afterEach(() => { delete process.env.EVENT_PUBLISH_ENABLED; delete process.env.WORK_ITEM_OUTCOME_SYNC; db.close(); vi.restoreAllMocks(); });

it('PRC-3: flag off (default) leaves the work item and the outbox unchanged', () => {
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', {})).toBe('skipped');
  expect(item().status).toBe('planned');
  expect(item().metadata.loop_outcome).toBeUndefined();
  expect(outbox()).toEqual([]);
});

it('PRC-3: a completed goal sets its work item done with outcome, pr_url and run_id, plus one required work_item.updated event', () => {
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('updated');
  expect(item().status).toBe('done');
  expect(item().metadata.loop_outcome).toMatchObject({ outcome: 'completed', run_id: 'run-1', pr_url: 'https://github.com/o/r/pull/9' });
  expect(outbox()).toEqual([expect.objectContaining({ work_item_id: itemId, status: 'done', goal_id: goalId, outcome: 'completed', run_id: 'run-1', pr_url: 'https://github.com/o/r/pull/9' })]);
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('skipped'); // a second daemon pass writes nothing
  expect(outbox()).toHaveLength(1);
});

it('PRC-3: a failed goal blocks the item (pr_url null when there is none); a later completed run closes it; done is never reopened', () => {
  run('run-0', null);
  expect(syncWorkItemOutcome(db, goalId, 'failed', 'run-0', ON)).toBe('updated');
  expect(item().status).toBe('blocked');
  expect(item().metadata.loop_outcome).toMatchObject({ outcome: 'failed', run_id: 'run-0', pr_url: null });
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('updated');
  expect(item().status).toBe('done');
  expect(syncWorkItemOutcome(db, goalId, 'failed', 'run-1', ON)).toBe('skipped');
  expect(item().status).toBe('done');
  expect(outbox().map((p) => p.status)).toEqual(['blocked', 'done']);
});

it('PRC-3: shadow records what it would write and changes nothing', () => {
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', { WORK_ITEM_OUTCOME_SYNC: 'shadow' })).toBe('shadow');
  expect(item().status).toBe('planned'); expect(outbox()).toEqual([]);
  expect(events('work_item_outcome_shadow')).toBe(1);
});

it('PRC-3: an outbox failure rolls the work item back and is recorded, never thrown', () => {
  db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox fault'); END`);
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('failed');
  expect(item().status).toBe('planned');
  expect(events('work_item_outcome_failed')).toBe(1);
});

it('PRC-3: a goal without a source work item is skipped', () => {
  db.prepare(`INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, metadata, created_at, updated_at)
    VALUES ('g-plain', 'o', '[]', '[]', 'low', '{}', 'completed', '{}', datetime('now'), datetime('now'))`).run();
  expect(syncWorkItemOutcome(db, 'g-plain', 'completed', null, ON)).toBe('skipped');
});

it('PRC-3: Refs line only for a GitHub-issue work item with the flag on', () => {
  expect(issueRefsLine(db, goalId, ON)).toBe('\n\nRefs o/r#12');
  expect(issueRefsLine(db, goalId, {})).toBe('');
  expect(issueRefsLine(db, goalId, { WORK_ITEM_OUTCOME_SYNC: 'shadow' })).toBe('');
  db.prepare(`UPDATE goals SET metadata = json_set(metadata, '$.source', 'manual') WHERE id = ?`).run(goalId);
  expect(issueRefsLine(db, goalId, ON)).toBe('');
});

it('PRC-3: a goal whose work item belongs to a different goal is skipped', () => {
  db.prepare(`INSERT INTO goals (id, objective, constraints_json, acceptance_criteria_json, risk_class, budget_json, status, metadata, created_at, updated_at)
    VALUES ('other-goal', 'o', '[]', '[]', 'low', '{}', 'created', '{}', datetime('now'), datetime('now'))`).run();
  db.prepare("UPDATE work_items SET parent_goal_id = 'other-goal' WHERE id = ?").run(itemId);
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('skipped');
  expect(item().status).toBe('planned');
  expect(outbox()).toEqual([]);
});

it('PRC-3: a discarded work item is never reopened', () => {
  new WorkItemService(db).update(itemId, { status: 'discarded' });
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('skipped');
  expect(item().status).toBe('discarded');
  expect(outbox()).toEqual([]);
});

it('PRC-3: an empty or non-string source_work_item_id is skipped, not treated as a missing item failure', () => {
  db.prepare("UPDATE goals SET metadata = json_set(metadata, '$.source_work_item_id', '') WHERE id = ?").run(goalId);
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('skipped');
  db.prepare("UPDATE goals SET metadata = json_set(metadata, '$.source_work_item_id', 123) WHERE id = ?").run(goalId);
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('skipped');
  expect(outbox()).toEqual([]);
});

it('PRC-3: unparseable goal metadata is treated as no source work item (skipped, never thrown)', () => {
  db.prepare("UPDATE goals SET metadata = 'not-json' WHERE id = ?").run(goalId);
  expect(syncWorkItemOutcome(db, goalId, 'completed', 'run-1', ON)).toBe('skipped');
  expect(issueRefsLine(db, goalId, ON)).toBe('');
});

it('PRC-3: same status but a different run rewrites the outcome (write-once is per-run, not per-status)', () => {
  run('run-0', null);
  expect(syncWorkItemOutcome(db, goalId, 'failed', 'run-0', ON)).toBe('updated');
  expect(syncWorkItemOutcome(db, goalId, 'failed', 'run-1', ON)).toBe('updated');
  expect(item().metadata.loop_outcome).toMatchObject({ outcome: 'failed', run_id: 'run-1', pr_url: 'https://github.com/o/r/pull/9' });
  expect(outbox().map((p) => p.status)).toEqual(['blocked', 'blocked']);
});

it('PRC-3: a null runId records no loop_outcome event on failure (note is best-effort and run-scoped)', () => {
  db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox fault'); END`);
  expect(syncWorkItemOutcome(db, goalId, 'completed', null, ON)).toBe('failed');
  expect(item().status).toBe('planned');
  expect(events('work_item_outcome_failed')).toBe(0);
});

it('PRC-3: issueRefsLine with a null goal, a malformed ref and a non-issue source is empty', () => {
  expect(issueRefsLine(db, null, ON)).toBe('');
  db.prepare("UPDATE goals SET metadata = json_set(metadata, '$.source_ref', 'o/r#12extra') WHERE id = ?").run(goalId);
  expect(issueRefsLine(db, goalId, ON)).toBe('');
  db.prepare("UPDATE goals SET metadata = json_set(metadata, '$.source_ref', 'x o/r#12') WHERE id = ?").run(goalId);
  expect(issueRefsLine(db, goalId, ON)).toBe('');
});

it('PRC-3: the daemon failure path blocks the source work item', async () => {
  process.env.WORK_ITEM_OUTCOME_SYNC = 'on';
  db.prepare("UPDATE goals SET status = 'decomposed', metadata = json_remove(metadata, '$.recommended_loop') WHERE id = ?").run(goalId);
  const stubLoops = {
    pruneOrphanedWorktrees: vi.fn(),
    startDocDriftAndSmallFixLoop: vi.fn(() => {
      db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status) VALUES ('run-d', ?, 'doc-drift', 'closed', 'planning')").run(goalId);
      return { id: 'run-d', findings: [{ id: 'f1' }] };
    }),
    startObjectiveLoop: vi.fn(() => { throw new Error('objective path not expected'); }),
    continueLoopRun: vi.fn(() => { throw new Error('boom: planning exploded'); }),
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const daemon = new LoopDaemon(db, stubLoops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await daemon.tick(); daemon.stop();
  expect((db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string }).status).toBe('failed');
  expect(item().status).toBe('blocked');
  expect(item().metadata.loop_outcome).toMatchObject({ outcome: 'failed', run_id: 'run-d', pr_url: null });
  expect(outbox().map((p) => p.status)).toEqual(['blocked']);
});
