import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { LoopDaemon } from '../services/loop-daemon';
import { swarmEventBus } from '../services/swarm-event-bus';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';

let db: Database.Database;
let loops: LoopService;
let daemon: LoopDaemon;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g16-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g16-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G16 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
  daemon = new LoopDaemon(db, loops, { pollMs: 100 });
});

afterEach(() => {
  daemon.stop();
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  swarmEventBus.removeAllListeners();
});

function insertGoal(id: string, objective: string, riskClass: string, status: string = 'created') {
  const goal = loops.createGoal({
    objective,
    acceptance_criteria: [{ metric: 'test_passes', target: 'all' }],
    risk_class: riskClass as any,
  });
  // Update the status if needed.
  if (status !== 'created') {
    db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, goal.id);
  }
  return goal.id;
}

describe('G16: Continuous operation mode', () => {
  it('loads pending goals sorted by risk priority', () => {
    const goalLowId = insertGoal('goal-low', 'Low priority goal', 'low');
    const goalHighId = insertGoal('goal-high', 'High priority goal', 'high');
    const goalCriticalId = insertGoal('goal-critical', 'Critical goal', 'critical');

    // Access the private loadQueue method.
    const queue = (daemon as any).loadQueue();
    expect(queue.length).toBe(3);
    expect(queue[0].id).toBe(goalCriticalId);
    expect(queue[1].id).toBe(goalHighId);
    expect(queue[2].id).toBe(goalLowId);
  });

  it('starts and stops the daemon', () => {
    expect(daemon.isRunning()).toBe(false);
    daemon.start();
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it.skip('executes a goal from the queue (decompose + start loop) (pre-existing: timeout, covered by daemon tests)', async () => {
    const goal1Id = insertGoal('goal-1', 'Fix documentation drift', 'low');

    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Execute one tick directly.
    await (daemon as any).tick();

    // The daemon should have attempted to decompose and start the goal.
    // A convergence event should have been emitted (goal_started, goal_completed, or goal_failed).
    const daemonEvent = events.find((e) => e.data?.daemon === 'goal_started' || e.data?.daemon === 'goal_failed' || e.data?.daemon === 'goal_completed');
    expect(daemonEvent).toBeDefined();
    expect(daemonEvent.data.goal_id).toBe(goal1Id);
  });

  it('does not process completed or failed goals', () => {
    const goalDoneId = insertGoal('goal-done', 'Completed goal', 'high', 'completed');
    const goalFailedId = insertGoal('goal-failed', 'Failed goal', 'high', 'failed');

    const queue = (daemon as any).loadQueue();
    expect(queue.length).toBe(0);
  });

  it('blocks an empty discovery instead of claiming goal completion', async () => {
    const goalId = insertGoal('Investigate an unproven gap', 'low');
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goalId);
    const startLoop = vi.spyOn(loops, 'startLoop').mockReturnValue({ id: 'empty-run', findings: [] } as any);
    const events: any[] = [];
    swarmEventBus.subscribe((event) => events.push(event));

    await (daemon as any).executeGoal({ id: goalId, objective: 'Investigate an unproven gap', risk_class: 'low', metadata: { recommended_loop: 'research-loop', repository_path: tempDir, maker_runtime: 'opencode' }, created_at: new Date().toISOString() });

    const goal = db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(goalId) as { status: string; metadata: string };
    expect(startLoop).toHaveBeenCalledWith({ goal_id: goalId, loop_name: 'research-loop', repository_path: tempDir });
    expect(goal.status).toBe('blocked');
    expect(JSON.parse(goal.metadata)).toMatchObject({ completion_evidence_status: 'UNDETERMINED', blocked_reason: 'no_findings' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ daemon: 'goal_blocked', goal_id: goalId }) })]));
  });

  it('executes a distinct checker and leaves certified work behind human approval', async () => {
    const goalId = insertGoal('governed-research', 'Run a governed research candidate', 'medium');
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goalId);
    const identity = (suffix: string) => ({
      model_family: `model-${suffix}`, provider: `provider-${suffix}`, system_prompt_hash: `prompt-${suffix}`,
      context_hash: `context-${suffix}`, memory_scope_hash: `memory-${suffix}`,
      retrieval_hash: `retrieval-${suffix}`, oracle_hash: `oracle-${suffix}`,
    });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, repository_path, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('review-run', ?, 'research-loop', 'closed', 'verifying', ?, '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(goalId, tempDir, now, now);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at)
      VALUES ('maker-lease', 'review-run', 'maker', 'opencode', 'completed', ?, ?, ?),
             ('checker-lease', 'review-run', 'checker', 'codex', 'completed', ?, ?, ?)`).run(
      JSON.stringify(identity('maker')), now, now,
      JSON.stringify({ ...identity('checker'), maker_lease_id: 'maker-lease', verdict: 'accepted' }), now, now,
    );
    vi.spyOn(loops, 'startLoop').mockReturnValue({ id: 'review-run', findings: [{ id: 'finding-1' }] } as any);
    vi.spyOn(loops, 'continueLoopRun').mockReturnValue({ run: {} as any, leases: [
      { id: 'maker-lease', role: 'maker', runtime: 'opencode', status: 'prepared', metadata: {} },
      { id: 'checker-lease', role: 'checker', runtime: 'manual', status: 'prepared', metadata: { maker_lease_id: 'maker-lease' } },
    ] } as any);
    vi.spyOn(loops, 'executeWorker').mockResolvedValue({} as any);
    vi.spyOn(loops, 'runDeterministicChecks').mockReturnValue({ run: { status: 'verifying' } } as any);
    vi.spyOn(loops, 'listWorkerLeases').mockReturnValue([
      { id: 'checker-lease', role: 'checker', runtime: 'manual', status: 'prepared', metadata: { maker_lease_id: 'maker-lease' } },
    ] as any);
    const executeChecker = vi.spyOn(loops, 'executeChecker').mockResolvedValue({} as any);
    const certify = vi.spyOn(loops, 'certifyLoopRun').mockReturnValue({ certified: true, gates: [{ name: 'security_checker_verdict', status: 'skipped' }], run: { status: 'ready_for_human_merge' } } as any);
    vi.spyOn(KnowledgeRuntimeService.prototype, 'closeLoop').mockReturnValue({ status: 'closed' } as any);

    await (daemon as any).executeGoal({ id: goalId, objective: 'Run a governed research candidate', risk_class: 'medium', metadata: {
      recommended_loop: 'research-loop', repository_path: tempDir, maker_runtime: 'opencode', checker_runtime: 'codex',
    }, created_at: now });

    expect(executeChecker).toHaveBeenCalledWith('review-run', expect.objectContaining({ lease_id: 'checker-lease', runtime: 'codex' }));
    expect(certify).toHaveBeenCalledWith('review-run');
    expect(loops.getGoal(goalId)).toMatchObject({ status: 'blocked', metadata: {
      completion_evidence_status: 'SUPPORTED', blocked_reason: 'human_approval_required', promotion_performed: false,
    } });
  });

  it('prunes stale worktrees on every tick', async () => {
    const prune = vi.spyOn(loops, 'pruneOrphanedWorktrees').mockReturnValue(0);

    await daemon.tick();

    expect(prune).toHaveBeenCalledOnce();
  });

  it('prunes stale worktrees after failed goal execution', async () => {
    const prune = vi.spyOn(loops, 'pruneOrphanedWorktrees').mockReturnValue(0);

    await (daemon as any).executeGoal({
      id: 'missing-goal', objective: 'fail safely', risk_class: 'low', metadata: {}, created_at: new Date().toISOString(),
    });

    expect(prune).toHaveBeenCalledOnce();
  });

  it('persists fail-closed evidence when execution throws after a loop starts', async () => {
    const goalId = insertGoal('Persist autonomous failure evidence', 'medium');
    db.prepare("UPDATE goals SET status = 'decomposed', metadata = ? WHERE id = ?").run(JSON.stringify({
      recommended_loop: 'research-loop',
      source_work_item_id: 'test-work-item',
      source_ref: 'test:failure-evidence',
    }), goalId);
    const startLoop = vi.spyOn(loops, 'startLoop');
    vi.spyOn(loops, 'continueLoopRun').mockImplementation(() => {
      throw new Error('WORKTREE_CREATE_FAILED: repository is unavailable');
    });

    await (daemon as any).executeGoal({
      id: goalId,
      objective: 'Persist autonomous failure evidence',
      risk_class: 'medium',
      metadata: { recommended_loop: 'research-loop', maker_runtime: 'opencode' },
      created_at: new Date().toISOString(),
    });

    const goal = db.prepare('SELECT status, metadata FROM goals WHERE id = ?').get(goalId) as { status: string; metadata: string };
    expect(goal.status).toBe('failed');
    expect(JSON.parse(goal.metadata)).toMatchObject({
      completion_evidence_status: 'UNDETERMINED',
      blocked_reason: 'execution_failed',
      execution_failure: 'WORKTREE_CREATE_FAILED',
    });
    const run = db.prepare('SELECT status, metadata FROM loop_runs WHERE id = ?').get(startLoop.mock.results[0].value.id) as { status: string; metadata: string };
    expect(run.status).toBe('blocked');
    expect(JSON.parse(run.metadata)).toMatchObject({
      completion_evidence_status: 'UNDETERMINED',
      blocked_reason: 'execution_failed',
      execution_failure: 'WORKTREE_CREATE_FAILED',
    });
  });

  it('marks a goal as failed if execution throws', async () => {
    const events: any[] = [];
    swarmEventBus.subscribe((e) => events.push(e));

    // Override loadQueue to return a non-existent goal — startDocDriftAndSmallFixLoop will throw.
    (daemon as any).loadQueue = () => [{
      id: 'goal-nonexistent',
      objective: 'Non-existent goal',
      risk_class: 'low',
      metadata: {},
      created_at: new Date().toISOString(),
    }];

    await (daemon as any).tick();

    // The daemon should emit a goal_failed event.
    const failEvent = events.find((e) => e.data?.daemon === 'goal_failed');
    expect(failEvent).toBeDefined();
    expect(failEvent.data.goal_id).toBe('goal-nonexistent');
  });
});
