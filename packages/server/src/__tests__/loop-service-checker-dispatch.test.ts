import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * Direct regression proof for the root cause found 2026-09-20/21: the daemon
 * created a checker lease but never dispatched it, so verifyLoopRun()'s
 * checker_verdict gate could never pass. This drives the exact sequence
 * LoopDaemon.executeGoal() now performs when LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED
 * is armed — continueLoopRun -> executeWorker -> runDeterministicChecks ->
 * executeChecker(runtime: <the maker's own runtime>) -> verifyLoopRun — for
 * real, against a real git worktree, and confirms the checker_verdict gate
 * can now actually report 'pass'. Passing an explicit runtime matters:
 * checker leases always default to runtime:'manual' regardless of the
 * maker's runtime, so auto-detection alone (no lease_id, no runtime) would
 * just throw CHECKER_RUNTIME_REQUIRED — confirmed by an earlier failed
 * version of this exact test.
 */
describe('LoopService: dispatching the checker enables the checker_verdict gate', () => {
  let db: Database.Database;
  let loops: LoopService;
  let tempDir: string;
  let evidenceRoot: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-dispatch-'));
    evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checker-dispatch-evidence-'));
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# fixture\n');
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
    loops = new LoopService(db, evidenceRoot);
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  });

  it('reaches a passing checker_verdict gate once the checker is actually dispatched (the fix)', async () => {
    const run = loops.startDocDriftAndSmallFixLoop({
      repository_path: tempDir,
      target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' },
    });

    const prepared = loops.continueLoopRun(run.id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 });
    const makerLease = prepared.leases.find((l) => l.role === 'maker' && l.status === 'prepared');
    expect(makerLease).toBeTruthy();

    await loops.executeWorker(run.id, { lease_id: makerLease!.id, timeout_ms: 10_000 });
    loops.runDeterministicChecks(run.id, { lease_id: makerLease!.id, timeout_ms: 10_000, scripts: [] });

    // Confirms the bug's precondition: with the maker completed but the
    // checker lease (prepared by continueLoopRun above) never dispatched —
    // exactly the state LoopDaemon.executeGoal() left every run in before
    // this fix — the checker_verdict gate is not passing.
    const beforeChecker = loops.verifyLoopRun(run.id);
    expect(beforeChecker.gates.find((g) => g.name === 'checker_verdict')?.status).not.toBe('pass');

    // This is the exact call LoopDaemon.executeGoal() now makes (when
    // LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED is armed) that it didn't before:
    // no lease_id (executeChecker auto-discovers the prepared checker
    // lease), but an explicit runtime — checker leases always default to
    // runtime:'manual' regardless of the maker's runtime, so the daemon
    // passes the maker's own runtime explicitly rather than relying on
    // auto-detection, which would just throw CHECKER_RUNTIME_REQUIRED.
    await loops.executeChecker(run.id, { runtime: 'mock', timeout_ms: 10_000 });

    const afterChecker = loops.verifyLoopRun(run.id);
    expect(afterChecker.gates.find((g) => g.name === 'checker_verdict')?.status).toBe('pass');
  });
});
