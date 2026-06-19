import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

let db: Database.Database;
let tempDir: string;
let worktreeRoot: string;
let previousWorktreeRoot: string | undefined;
let previousMaxAge: string | undefined;

function staleDir(p: string, hoursOld: number) {
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'marker'), 'x');
  const oldSec = Math.floor(Date.now() / 1000) - hoursOld * 3600;
  fs.utimesSync(p, oldSec, oldSec);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-recover-'));
  worktreeRoot = path.join(os.tmpdir(), `.djimitflo-loop-worktrees-recover-${path.basename(tempDir)}`);
  fs.mkdirSync(worktreeRoot, { recursive: true });
  previousWorktreeRoot = process.env.LOOP_WORKTREE_ROOT;
  previousMaxAge = process.env.LOOP_WORKTREE_MAX_AGE_HOURS;
  process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
  if (previousWorktreeRoot) process.env.LOOP_WORKTREE_ROOT = previousWorktreeRoot;
  else delete process.env.LOOP_WORKTREE_ROOT;
  if (previousMaxAge) process.env.LOOP_WORKTREE_MAX_AGE_HOURS = previousMaxAge;
  else delete process.env.LOOP_WORKTREE_MAX_AGE_HOURS;
});

function insertRun(id: string, status: string) {
  db.prepare(
    `INSERT INTO loop_runs (id, loop_name, mode, status) VALUES (?, 'doc-drift-and-small-fix-loop', 'closed', ?)`,
  ).run(id, status);
}

function insertLease(id: string, runId: string, status: string, worktreePath: string | null) {
  db.prepare(
    `INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path) VALUES (?, ?, 'maker', 'mock', ?, ?)`,
  ).run(id, runId, status, worktreePath);
}

describe('loop recovery on restart', () => {
  it('accepts the interrupted status after migration', () => {
    insertRun('run-z', 'interrupted');
    const row = db.prepare('SELECT status FROM loop_runs WHERE id = ?').get('run-z') as { status: string };
    expect(row.status).toBe('interrupted');
  });

  it('marks orphaned active runs and running leases after a restart and prunes stale worktrees', () => {
    const runId = 'run-orphan';
    const leaseId = 'lease-orphan';
    const wtPath = path.join(worktreeRoot, runId, 'finding-1');
    staleDir(wtPath, 48); // older than the 24h grace window

    insertRun(runId, 'running');
    insertLease(leaseId, runId, 'running', wtPath);

    const service = new LoopService(db, path.join(tempDir, 'agent-evidence'));
    const result = service.recoverInterruptedRuns();

    expect(result.interruptedRuns).toBe(1);
    expect(result.failedLeases).toBe(1);
    expect(result.prunedWorktrees).toBe(1);

    const run = db.prepare('SELECT status, metadata FROM loop_runs WHERE id = ?').get(runId) as { status: string; metadata: string };
    expect(run.status).toBe('interrupted');
    expect(JSON.parse(run.metadata).interrupted_reason).toBe('server_restart');

    const lease = db.prepare('SELECT status, metadata FROM worker_leases WHERE id = ?').get(leaseId) as { status: string; metadata: string };
    expect(lease.status).toBe('failed');
    expect(JSON.parse(lease.metadata).failed_reason).toBe('server_restart');

    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('is a no-op on a clean database', () => {
    insertRun('run-done', 'completed');
    insertLease('lease-done', 'run-done', 'completed', null);
    const service = new LoopService(db, path.join(tempDir, 'agent-evidence'));
    const result = service.recoverInterruptedRuns();
    expect(result).toEqual({ interruptedRuns: 0, failedLeases: 0, prunedWorktrees: 0 });
  });
});

describe('worktree janitor', () => {
  it('keeps worktrees for in-flight leases', () => {
    const wtPath = path.join(worktreeRoot, 'run-active', 'finding-1');
    staleDir(wtPath, 48);
    insertRun('run-active', 'running');
    insertLease('lease-active', 'run-active', 'prepared', wtPath);

    const service = new LoopService(db, path.join(tempDir, 'agent-evidence'));
    const pruned = service.pruneOrphanedWorktrees({ maxAgeHours: 24 });
    expect(pruned).toBe(0);
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  it('keeps terminal-lease worktrees within the grace window and reaps them once old', () => {
    const wtPath = path.join(worktreeRoot, 'run-term', 'finding-1');
    // Aged 2 hours — inside a 24h grace window but outside a 1h one.
    staleDir(wtPath, 2);
    insertRun('run-term', 'completed');
    insertLease('lease-term', 'run-term', 'completed', wtPath);

    const service = new LoopService(db, path.join(tempDir, 'agent-evidence'));
    expect(service.pruneOrphanedWorktrees({ maxAgeHours: 24 })).toBe(0);
    expect(fs.existsSync(wtPath)).toBe(true);

    // Now lower the grace window below the worktree's age so it is reaped.
    expect(service.pruneOrphanedWorktrees({ maxAgeHours: 1 })).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it('reaps unreferenced orphan directories and supports dry-run', () => {
    const wtPath = path.join(worktreeRoot, 'run-ghost', 'finding-1');
    staleDir(wtPath, 48);
    // no lease references this worktree

    const service = new LoopService(db, path.join(tempDir, 'agent-evidence'));
    expect(service.pruneOrphanedWorktrees({ maxAgeHours: 24, dryRun: true })).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(true); // dry-run does not delete

    expect(service.pruneOrphanedWorktrees({ maxAgeHours: 24 })).toBe(1);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});