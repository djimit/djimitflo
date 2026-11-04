import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

let db: Database.Database;
let loops: LoopService;
let worktree: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  loops = new LoopService(db);
  const goal = loops.createGoal({ objective: 'Fixture', acceptance_criteria: ['No execution after stop'] });
  db.prepare("UPDATE goals SET status='running' WHERE id=?").run(goal.id);
  db.prepare(`INSERT INTO loop_runs(id,goal_id,loop_name,mode,status,repository_path,findings_json,metadata)
    VALUES ('run',?,'doc-drift-and-small-fix-loop','closed','running','/isolated-fixture',?,'{}')`).run(goal.id, JSON.stringify([
    { id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Fix', evidence: 'Fixture', suggested_fix: 'Fix' },
    { id: 'new-finding', type: 'todo_marker', severity: 'low', file: 'other.md', message: 'Fix', evidence: 'Fixture', suggested_fix: 'Fix' },
  ]));
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'run', role: 'maker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null, metadata: {}, now: new Date().toISOString() });
  loops.updateWorkerLeaseStatus('maker', 'failed', {});
  vi.spyOn(loops, 'planLoopRun').mockReturnValue([]);
  worktree = vi.spyOn(loops, 'createWorktree').mockImplementation(() => { throw new Error('filesystem boundary reached'); });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
const invoke = (operation: string) => operation === 'retry'
  ? loops.retryLoopRun('run', { maker_lease_id: 'maker' })
  : loops.continueLoopRun('run', { finding_ids: ['new-finding'] });
const snapshot = () => JSON.stringify({ runs: db.prepare('SELECT * FROM loop_runs').all(), goals: db.prepare('SELECT * FROM goals').all(), leases: db.prepare('SELECT * FROM worker_leases').all() });

it.each(['retry', 'continue'])('%s cannot revive cancelled work or allocate a worktree', (operation) => {
  db.prepare("UPDATE loop_runs SET status='cancelled'").run();
  const before = snapshot();
  expect(() => invoke(operation)).toThrow('LOOP_RUN_NOT_CONTINUABLE');
  expect(worktree).not.toHaveBeenCalled();
  expect(snapshot()).toBe(before);
});

it.each(['retry', 'continue'])('%s respects a cancelled goal even while its run remains running', (operation) => {
  db.prepare("UPDATE goals SET status='cancelled'").run();
  const before = snapshot();
  expect(() => invoke(operation)).toThrow('LOOP_GOAL_NOT_CONTINUABLE');
  expect(worktree).not.toHaveBeenCalled();
  expect(snapshot()).toBe(before);
});

for (const operation of ['retry', 'continue']) {
  it.each(operation === 'retry' ? ['completed', 'ready_for_human_merge'] : ['completed', 'failed', 'interrupted', 'ready_for_human_merge'])(`${operation} leaves %s runs unchanged with HTTP 409`, (status) => {
    db.prepare('UPDATE loop_runs SET status=?').run(status);
    const before = snapshot();
    expect(() => invoke(operation)).toThrow(expect.objectContaining({ status: 409, code: 'LOOP_RUN_NOT_CONTINUABLE' }));
    expect(worktree).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
  });

  it.each(['completed', 'failed'])(`${operation} leaves %s goals unchanged`, (status) => {
    db.prepare('UPDATE goals SET status=?').run(status);
    const before = snapshot();
    expect(() => invoke(operation)).toThrow(expect.objectContaining({ status: 409, code: 'LOOP_GOAL_NOT_CONTINUABLE' }));
    expect(worktree).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
  });

  it.each(['run', 'goal'])(`${operation} re-reads a %s stop before creating the worktree`, (target) => {
    vi.spyOn(loops, 'assertRuntimeAvailable').mockImplementation(() => {
      db.prepare(`UPDATE ${target === 'run' ? 'loop_runs' : 'goals'} SET status='cancelled'`).run();
    });
    expect(() => invoke(operation)).toThrow(target === 'run' ? 'LOOP_RUN_NOT_CONTINUABLE' : 'LOOP_GOAL_NOT_CONTINUABLE');
    expect(worktree).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM worker_leases').get()).toEqual({ n: 1 });
  });

  it(`${operation} keeps blocked work eligible for the existing preparation path`, () => {
    db.prepare("UPDATE loop_runs SET status='blocked'").run(); db.prepare("UPDATE goals SET status='blocked'").run();
    expect(() => invoke(operation)).toThrow('filesystem boundary reached');
    expect(worktree).toHaveBeenCalledOnce();
  });

  it(`${operation} retains the existing operator pause gate`, () => {
    db.prepare("UPDATE goals SET metadata=json_set(metadata,'$.operator_paused',json('true'))").run();
    expect(() => invoke(operation)).toThrow('LOOP_OPERATOR_PAUSED'); expect(worktree).not.toHaveBeenCalled();
  });
}

it.each(['failed', 'interrupted'])('preserves explicit retry of %s work with a live goal', (status) => {
  db.prepare('UPDATE loop_runs SET status=?').run(status);
  expect(() => invoke('retry')).toThrow('filesystem boundary reached');
  expect(worktree).toHaveBeenCalledOnce();
});

it.each(['failed', 'interrupted'])('does not replenish retry budget for %s work after service recreation', (status) => {
  db.prepare('UPDATE loop_runs SET status=?').run(status);
  loops.insertWorkerLease({ id: 'prior-retry', loopRunId: 'run', role: 'maker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
    metadata: { retry_root_maker_lease_id: 'maker', retry_attempt: 1 }, now: new Date().toISOString() });
  loops = new LoopService(db);
  const nextWorktree = vi.spyOn(loops, 'createWorktree').mockImplementation(() => { throw new Error('filesystem boundary reached'); });
  const before = snapshot();
  expect(() => invoke('retry')).toThrow('LOOP_RETRY_BUDGET_EXHAUSTED');
  expect(nextWorktree).not.toHaveBeenCalled(); expect(snapshot()).toBe(before);
});

it.each(['retry', 'continue'])('%s cannot allocate leases or resurrect a run stopped during filesystem preparation', (operation) => {
  worktree.mockImplementation(() => {
    db.prepare("UPDATE loop_runs SET status='cancelled'").run();
    return '/prepared-orphan-fixture';
  });
  vi.spyOn(loops, 'ensureWorktreeControlIgnore').mockImplementation(() => {});
  vi.spyOn(loops, 'writeWorkAssignment').mockImplementation(() => {});
  vi.spyOn(loops, 'writeAssignmentPacket').mockReturnValue('/prepared-orphan-fixture/assignment.json');
  expect(() => invoke(operation)).toThrow(expect.objectContaining({ status: 409, code: 'LOOP_RUN_NOT_CONTINUABLE' }));
  expect(db.prepare('SELECT status FROM loop_runs').get()).toEqual({ status: 'cancelled' });
  expect(db.prepare('SELECT COUNT(*) n FROM worker_leases').get()).toEqual({ n: 1 });
});

it.each(['exhausted', 'superseded', 'limit-reduced'])('retry revalidates %s state inside final lease transaction', (reason) => {
  worktree.mockImplementation(() => {
    if (reason === 'limit-reduced') db.prepare("UPDATE goals SET budget_json='{\"max_retries\":0}'").run();
    else {
      loops.insertWorkerLease({ id: 'concurrent-retry', loopRunId: 'run', role: 'maker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
        metadata: { retry_root_maker_lease_id: 'maker', retry_attempt: 1 }, now: new Date().toISOString() });
      if (reason === 'superseded') loops.updateWorkerLeaseStatus('maker', 'failed', { superseded_by_maker_lease_id: 'concurrent-retry' });
    }
    return '/prepared-orphan-fixture';
  });
  vi.spyOn(loops, 'ensureWorktreeControlIgnore').mockImplementation(() => {});
  vi.spyOn(loops, 'writeWorkAssignment').mockImplementation(() => {});
  vi.spyOn(loops, 'writeAssignmentPacket').mockReturnValue('/prepared-orphan-fixture/assignment.json');
  expect(() => invoke('retry')).toThrow(expect.objectContaining({ status: 409, code: reason === 'superseded' ? 'LOOP_RETRY_NOT_ALLOWED' : 'LOOP_RETRY_BUDGET_EXHAUSTED' }));
  expect(db.prepare('SELECT COUNT(*) n FROM worker_leases').get()).toEqual({ n: reason === 'limit-reduced' ? 1 : 2 });
});

it('supersession preserves the current maker status read inside the final transaction', () => {
  loops.insertWorkerLease({ id: 'checker', loopRunId: 'run', role: 'checker', runtime: 'manual', findingId: 'finding', worktreePath: null, branchName: null,
    metadata: { maker_lease_id: 'maker', verdict: 'needs_revision' }, now: new Date().toISOString() });
  worktree.mockImplementation(() => {
    loops.updateWorkerLeaseStatus('maker', 'completed', {});
    return '/prepared-orphan-fixture';
  });
  vi.spyOn(loops, 'ensureWorktreeControlIgnore').mockImplementation(() => {});
  vi.spyOn(loops, 'writeWorkAssignment').mockImplementation(() => {});
  vi.spyOn(loops, 'writeAssignmentPacket').mockReturnValue('/prepared-orphan-fixture/assignment.json');
  const result = loops.retryLoopRun('run', { maker_lease_id: 'maker' });
  expect(loops.getWorkerLease('maker')).toMatchObject({ status: 'completed', metadata: { superseded_by_maker_lease_id: result.retry_maker.id } });
  expect(result.retry_maker.status).toBe('prepared');
});
