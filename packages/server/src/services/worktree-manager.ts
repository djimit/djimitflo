/**
 * WorktreeManager — git worktree creation, management, and cleanup.
 *
 * Extracted from LoopService (Phase B1 decomposition).
 * Handles: worktree creation with retry, untracked file snapshotting,
 * orphaned worktree pruning, branch name generation.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, statSync, readdirSync, rmSync, symlinkSync, lstatSync, copyFileSync, type Stats } from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';

export class WorktreeManager {
  constructor(private db: Database) {}

  /**
   * Generate a unique branch name for a finding within a loop run.
   */
  branchNameFor(runId: string, findingId: string, retryAttempt?: number): string {
    const sanitizedFindingId = findingId.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const suffix = retryAttempt ? `-r${retryAttempt}` : '';
    return `agent/loop/${runId}-${sanitizedFindingId}${suffix}`;
  }

  /**
   * Create a git worktree for a finding, with retry on lock contention.
   */
  createWorktree(repositoryPath: string, runId: string, findingId: string, branchName: string): string {
    this.git(repositoryPath, ['rev-parse', '--show-toplevel']);
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT || path.resolve(repositoryPath, '..', '.djimitflo-loop-worktrees');
    const sanitizedFindingId = findingId.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const worktreePath = path.join(worktreeRoot, runId, sanitizedFindingId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    if (existsSync(worktreePath)) {
      return worktreePath;
    }

    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        this.git(repositoryPath, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
        this.applySourceWorkingTreeDiff(repositoryPath, worktreePath);
        const sourceNodeModules = path.join(repositoryPath, 'node_modules');
        const worktreeNodeModules = path.join(worktreePath, 'node_modules');
        if (existsSync(sourceNodeModules) && !existsSync(worktreeNodeModules)) {
          symlinkSync(sourceNodeModules, worktreeNodeModules, 'dir');
        }
        return worktreePath;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_ATTEMPTS && WorktreeManager.isGitLockError(lastError)) {
          this.sleepSync(250 * attempt);
          continue;
        }
        throw new Error(`WORKTREE_CREATE_FAILED: ${lastError.message}`);
      }
    }
    throw new Error(`WORKTREE_CREATE_FAILED: ${lastError?.message ?? 'unknown'}`);
  }

  /**
   * Snapshot untracked source files into a worker worktree.
   * Includes path traversal guards to prevent writes outside the worktree.
   */
  applySourceWorkingTreeDiff(repositoryPath: string, worktreePath: string): void {
    const status = this.git(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']);
    const untracked = status.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim())
      .filter((relativePath) => {
        const normalized = relativePath.replace(/\\/g, '/');
        return !normalized.startsWith('.git/') && normalized !== '.git' &&
          !normalized.startsWith('node_modules/') && normalized !== 'node_modules';
      });

    if (untracked.length === 0) return;

    const resolvedWorktreePath = path.resolve(worktreePath);
    const resolvedRepositoryPath = path.resolve(repositoryPath);
    let copied = 0;

    for (const relativePath of untracked) {
      if (relativePath.includes('..')) continue;
      const sourceFile = path.join(resolvedRepositoryPath, relativePath);
      const targetFile = path.join(resolvedWorktreePath, relativePath);
      if (!sourceFile.startsWith(resolvedRepositoryPath + path.sep) && sourceFile !== resolvedRepositoryPath) continue;
      if (!targetFile.startsWith(resolvedWorktreePath + path.sep) && targetFile !== resolvedWorktreePath) continue;
      if (!existsSync(sourceFile)) continue;
      const stat = lstatSync(sourceFile);
      if (!stat.isFile()) continue;
      mkdirSync(path.dirname(targetFile), { recursive: true });
      copyFileSync(sourceFile, targetFile);
      copied += 1;
    }

    if (copied === 0) return;
    this.git(worktreePath, ['add', '.']);
    this.git(worktreePath, ['commit', '-m', 'Snapshot untracked source files into worker worktree', '--no-verify']);
  }

  /**
   * Prune orphaned worktrees that are older than maxAgeHours and not in active leases.
   */
  pruneOrphanedWorktrees(options?: { maxAgeHours?: number; dryRun?: boolean }): number {
    const maxAgeHours = options?.maxAgeHours ?? Number(process.env.LOOP_WORKTREE_MAX_AGE_HOURS ?? 24);
    const dryRun = options?.dryRun ?? false;
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    if (!worktreeRoot || !existsSync(worktreeRoot)) return 0;

    const rows = this.db
      .prepare('SELECT worktree_path, status FROM worker_leases WHERE worktree_path IS NOT NULL')
      .all() as Array<{ worktree_path: string; status: string }>;
    const statusByPath = new Map<string, string>();
    for (const row of rows) statusByPath.set(row.worktree_path, row.status);
    const ACTIVE_LEASE = new Set(['prepared', 'running']);

    const maxAgeMs = Math.max(0, maxAgeHours) * 3_600_000;
    const nowMs = Date.now();
    let pruned = 0;

    let runDirs: string[];
    try {
      runDirs = readdirSync(worktreeRoot);
    } catch {
      return 0;
    }

    for (const runDirName of runDirs) {
      const runDir = path.join(worktreeRoot, runDirName);
      let stat: Stats;
      try {
        stat = statSync(runDir);
      } catch { continue; }
      if (!stat.isDirectory()) continue;

      let findingDirs: string[];
      try {
        findingDirs = readdirSync(runDir);
      } catch { continue; }

      for (const findingDirName of findingDirs) {
        const wtPath = path.join(runDir, findingDirName);
        try {
          stat = statSync(wtPath);
        } catch { continue; }
        if (!stat.isDirectory()) continue;

        const leaseStatus = statusByPath.get(wtPath);
        if (leaseStatus && ACTIVE_LEASE.has(leaseStatus)) continue;

        const ageMs = nowMs - stat.mtimeMs;
        if (ageMs < maxAgeMs) continue;

        if (!dryRun) {
          try {
            rmSync(wtPath, { recursive: true, force: true });
          } catch { /* best-effort */ }
        }
        pruned++;
      }
    }

    return pruned;
  }

  static isGitLockError(error: Error): boolean {
    const m = error.message.toLowerCase();
    return m.includes('worktree.lock') || m.includes('index.lock') || m.includes('another git process') || m.includes('file exists');
  }

  private git(repositoryPath: string, args: string[]): string {
    try {
      return execFileSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() || '';
      throw new Error(stderr.trim() || `git ${args.join(' ')} failed`);
    }
  }

  private sleepSync(ms: number): void {
    try {
      execFileSync('sleep', [(ms / 1000).toFixed(2)]);
    } catch {
      const start = Date.now();
      while (Date.now() - start < ms) { /* busy wait */ }
    }
  }
}
