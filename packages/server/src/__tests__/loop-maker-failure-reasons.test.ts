import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import { LoopService } from '../services/loop-service';

/**
 * Prod 2026-10-01..07, doc-drift lane: 21 failed makers carried 'unspecified: caller supplied no reason' (all failed their
 * deterministic checks), 27 failed reviewers carried their own verdict prose as the reason, and 47 checker_dispatch_failed
 * events were mostly reviewers dispatched after a maker that had already failed, or with the maker-only 'remote' runtime.
 */
const metaOf = (db: Database.Database, id: string) =>
  JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata) as Record<string, unknown>;

describe('failure reasons on failed leases', () => {
  let db: Database.Database; let loops: LoopService; let tmp: string;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-reasons-'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# fixture\n');
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });
    loops = new LoopService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'failure-reasons-ev-')));
  });
  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a maker that fails its deterministic checks names the failed checks', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('r', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at)
      VALUES ('m', 'r', 'maker', 'opencode', 'completed', ?, '{}', ?, ?)`).run(tmp, now, now);
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { 'test:changed': 'exit 3', lint: 'exit 0' } }));
    loops.runDeterministicChecks('r', { lease_id: 'm', scripts: ['test:changed', 'lint'] });
    expect(metaOf(db, 'm').failure_reason).toBe('deterministic_checks_failed:test:changed(exit=3)');
  });

  it('a reviewer whose runtime failed records why, not its verdict notes', async () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tmp, target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' } });
    const prepared = loops.continueLoopRun(run.id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 });
    const maker = prepared.leases.find((l) => l.role === 'maker')!;
    await loops.executeWorker(run.id, { lease_id: maker.id, timeout_ms: 10_000 });
    loops.runDeterministicChecks(run.id, { lease_id: maker.id, timeout_ms: 10_000, scripts: [] });
    vi.spyOn(loops.runtimeCommand, 'executeRuntimeCommand').mockResolvedValue({
      exitCode: 1, signal: null, timedOut: false,
      stdout: '{"verdict":"accepted","notes":"Test-only diff, looks fine"}',
      stderr: "remote maker needs model '<host>/<species>', got ''\n    at Socket.emit (node:events:519:28)\n",
    });
    await loops.executeChecker(run.id, { runtime: 'mock', timeout_ms: 10_000 });
    const checker = loops.listWorkerLeases(run.id).find((l) => l.role === 'checker')!;
    expect(checker.status).toBe('failed');
    expect(checker.metadata.failure_reason).toBe("checker_runtime_failed:exit=1,timed_out=false: remote maker needs model '<host>/<species>', got ''");
  });
});

describe('LoopDaemon reviewer dispatch after the maker', () => {
  let db: Database.Database; let goals: GoalService;
  const env = ['LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED', 'LOOP_DAEMON_MAKER_RUNTIME'];
  const prev: Record<string, string | undefined> = {};
  let stub: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); // the stubbed run has no loop_runs row
    goals = new GoalService(db);
    for (const k of env) prev[k] = process.env[k];
    Object.assign(process.env, { LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED: 'true', LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED: 'true', LOOP_DAEMON_MAKER_RUNTIME: 'opencode' });
    stub = {
      startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'f', type: 't', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
      continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'remote' }] })),
      executeWorker: vi.fn(async () => ({})),
      runDeterministicChecks: vi.fn(() => ({ run: { status: 'verifying' }, lease: {}, checks: [] })),
      retryLoopRun: vi.fn(),
      executeChecker: vi.fn(async () => ({})),
      verifyLoopRun: vi.fn(() => ({ gates: [] })),
      pruneOrphanedWorktrees: vi.fn(),
    };
    const goal = goals.createGoal({ objective: 'Fix a small doc drift issue', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: {} });
    db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
  });
  afterEach(() => {
    db.close();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const lease = (id: string, role: string, runtime: string, status: string, metadata: Record<string, unknown>, created: string) =>
    db.prepare('INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at) VALUES (?, \'run-1\', ?, ?, ?, ?, ?)')
      .run(id, role, runtime, status, JSON.stringify(metadata), created);
  const tick = async () => {
    const daemon = new LoopDaemon(db, stub as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
    await daemon.tick(); await new Promise((resolve) => setImmediate(resolve)); daemon.stop();
  };
  const events = (type: string) => (db.prepare('SELECT COUNT(*) AS n FROM loop_events WHERE loop_run_id = \'run-1\' AND event_type = ?').get(type) as { n: number }).n;

  it('a failed maker gets no reviewers and no checker_dispatch_failed, one skip event instead', async () => {
    lease('maker-1', 'maker', 'opencode', 'failed', { failure_reason: 'maker_gate_failed:maker_runtime_exit_zero' }, '2026-10-07T10:00:00Z');
    lease('checker-1', 'checker', 'manual', 'prepared', { maker_lease_id: 'maker-1' }, '2026-10-07T10:00:00Z');
    lease('security-1', 'security_checker', 'manual', 'prepared', { maker_lease_id: 'maker-1' }, '2026-10-07T10:00:00Z');
    await tick();
    expect(stub.executeChecker).not.toHaveBeenCalled();
    expect(events('checker_dispatch_failed')).toBe(0);
    expect(events('checker_dispatch_skipped')).toBe(1);
  });

  it('reviews the maker that goes on with its own reviewer leases, on a local runtime when that maker ran remote', async () => {
    // the first prepared checker belongs to another (failed) maker; a newer security checker too
    lease('maker-0', 'maker', 'opencode', 'failed', {}, '2026-10-07T09:00:00Z');
    lease('checker-0', 'checker', 'manual', 'prepared', { maker_lease_id: 'maker-0' }, '2026-10-07T09:00:00Z');
    lease('maker-1', 'maker', 'remote', 'completed', { model: 'workstation/atomic@llama-router' }, '2026-10-07T10:00:00Z');
    lease('checker-1', 'checker', 'manual', 'prepared', { maker_lease_id: 'maker-1' }, '2026-10-07T10:00:00Z');
    lease('security-1', 'security_checker', 'manual', 'prepared', { maker_lease_id: 'maker-1' }, '2026-10-07T10:00:00Z');
    lease('security-0', 'security_checker', 'manual', 'prepared', { maker_lease_id: 'maker-0' }, '2026-10-07T11:00:00Z');
    await tick();
    expect(stub.executeChecker).toHaveBeenNthCalledWith(1, 'run-1', expect.objectContaining({ lease_id: 'checker-1', runtime: 'opencode' }));
    expect(stub.executeChecker).toHaveBeenNthCalledWith(2, 'run-1', expect.objectContaining({ lease_id: 'security-1', runtime: 'opencode' }));
  });
});
