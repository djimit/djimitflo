/**
 * WorktreeManager — git worktree creation, management, and cleanup.
 *
 * Extracted from LoopService (Phase B1 decomposition).
 * Handles: worktree creation with retry, untracked file snapshotting,
 * orphaned worktree pruning, branch name generation.
 */

import { execFileSync } from 'child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, readdirSync, rmSync, symlinkSync, lstatSync, copyFileSync, writeFileSync, type Stats } from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { safeGit, safeGitBuffer } from './safe-git';
import { isAgentConfigPath } from './diff-capture';

/**
 * D4 (H4 2026-11-14): a checker worktree is cut from the maker's, so the maker would write the opencode.json(c),
 * .opencode/, AGENTS.md, CLAUDE.md, .claude/, .codex/ and .mcp.json its reviewer runs under. This puts back exactly the
 * agent-config files of `trustedRepository`'s HEAD (the loop's runtime repository, never the maker's git metadata): an
 * edited one gets the base content, an added one is removed, a deleted one comes back. The change is committed, so the
 * checker's read-only contract still measures the checker alone. Returns the paths it changed.
 */
export function restoreAgentConfig(trustedRepository: string, worktreePath: string): string[] {
  const root = realpathSync(worktreePath);
  const trusted = new Map<string, { mode: string; sha: string }>();
  for (const record of safeGit(trustedRepository, ['ls-tree', '-r', '-z', 'HEAD']).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (type === 'blob' && isAgentConfigPath(file)) trusted.set(file, { mode, sha });
  }
  const present: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file); // a symlink (e.g. a symlinked .opencode/) is never followed: it is an entry below
      else if (isAgentConfigPath(file)) present.push(file);
    }
  };
  walk('');
  const changed = new Set<string>();
  for (const file of present) {
    if (!trusted.has(file)) { rmSync(path.join(root, file), { recursive: true, force: true }); changed.add(file); }
  }
  for (const [file, { mode, sha }] of trusted) {
    const full = path.join(root, file);
    const content = safeGitBuffer(trustedRepository, ['cat-file', 'blob', sha]);
    const current = lstatSync(full, { throwIfNoEntry: false });
    if (mode === '120000') {
      if (current?.isSymbolicLink() && readlinkSync(full) === content.toString()) continue;
    } else if (current?.isFile() && readFileSync(full).equals(content) && Boolean(current.mode & 0o100) === (mode === '100755')) continue;
    mkdirSync(path.dirname(full), { recursive: true });
    // a maker-made symlinked parent directory would send the write outside the worktree
    if (!(realpathSync(path.dirname(full)) + path.sep).startsWith(root + path.sep)) throw new Error(`CHECKER_AGENT_CONFIG_UNSAFE_PATH: ${file}`);
    if (current) rmSync(full, { recursive: true, force: true });
    if (mode === '120000') symlinkSync(content.toString(), full);
    else { writeFileSync(full, content); chmodSync(full, mode === '100755' ? 0o755 : 0o644); }
    changed.add(file);
  }
  if (changed.size === 0) return [];
  const files = [...changed].sort();
  safeGit(root, ['--literal-pathspecs', 'add', '-A', '-f', '--', ...files]);
  safeGit(root, ['commit', '-q', '--no-verify', '-m', 'Restore agent config from the base commit (checker independence)'],
    { config: ['user.name=djimitflo', 'user.email=djimitflo@localhost'] });
  return files;
}

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
  createWorktree(repositoryPath: string, runId: string, findingId: string, branchName: string, linkDependencies = true): string {
    const repositoryRoot = this.git(repositoryPath, ['rev-parse', '--show-toplevel']).trim();
    const sourceHead = this.git(repositoryPath, ['rev-parse', 'HEAD']).trim();
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT || path.resolve(repositoryRoot, '..', '.djimitflo-loop-worktrees');
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
        this.git(repositoryRoot, ['worktree', 'add', '-b', branchName, worktreePath, sourceHead]);
        this.applySourceWorkingTreeDiff(repositoryPath, worktreePath);
        if (linkDependencies) {
          const sourceNodeModules = path.join(repositoryRoot, 'node_modules');
          const worktreeNodeModules = path.join(worktreePath, 'node_modules');
          if (existsSync(sourceNodeModules) && !existsSync(worktreeNodeModules)) {
            symlinkSync(sourceNodeModules, worktreeNodeModules, 'dir');
          }
          const sourcePackages = path.join(repositoryRoot, 'packages');
          if (existsSync(sourcePackages)) {
            for (const workspace of readdirSync(sourcePackages)) {
              const sourceWorkspaceModules = path.join(sourcePackages, workspace, 'node_modules');
              const worktreeWorkspaceModules = path.join(worktreePath, 'packages', workspace, 'node_modules');
              if (existsSync(sourceWorkspaceModules) && !existsSync(worktreeWorkspaceModules)) {
                mkdirSync(path.dirname(worktreeWorkspaceModules), { recursive: true });
                symlinkSync(sourceWorkspaceModules, worktreeWorkspaceModules, 'dir');
              }
            }
          }
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
   * Each deploy mounts a fresh clone as the runtime repository, so a worktree prepared before a deploy (a maker that
   * waited hours for its approval) points at git metadata that no longer exists (prod 2026-09-25: "the repo exists but
   * doesn't have the worktrees directory"). Re-register it in the current repository on the same branch and put its
   * untracked files back (the assignment, prepared node_modules, new files). Tracked files come from the current HEAD: copying
   * the old versions back reverted every change main made since (prod 2026-11-08: 3 makers failed diff_under_threshold on
   * #1192's files). ponytail: edits to tracked files made before the deploy are dropped; repair only runs for makers that waited
   * across a deploy, which have not run yet. Returns true when a repair was needed.
   */
  repairWorktree(repositoryPath: string, worktreePath: string, branchName: string): boolean {
    if (!existsSync(worktreePath)) return false;
    try { this.git(worktreePath, ['rev-parse', '--git-dir']); return false; } catch { /* broken link: repair below */ }
    const repositoryRoot = this.git(repositoryPath, ['rev-parse', '--show-toplevel']).trim();
    const aside = `${worktreePath}.broken-${Date.now()}`;
    renameSync(worktreePath, aside);
    try {
      this.git(repositoryRoot, ['worktree', 'prune']);
      this.git(repositoryRoot, ['worktree', 'add', '-B', branchName, worktreePath, 'HEAD']);
      // skipping tracked paths also skips tracked symlinks (prod: `knowledge` dangles in the container; cpSync throws ENOENT on it)
      const tracked = new Set(this.git(worktreePath, ['ls-files', '-z']).split('\0').filter(Boolean));
      cpSync(aside, worktreePath, {
        recursive: true, force: true, verbatimSymlinks: true,
        filter: (src) => path.basename(src) !== '.git' && !tracked.has(path.relative(aside, src).split(path.sep).join('/')),
      });
    } finally {
      rmSync(aside, { recursive: true, force: true });
    }
    return true;
  }

  /**
   * Snapshot untracked source files into a worker worktree.
   * Includes path traversal guards to prevent writes outside the worktree.
   */
  applySourceWorkingTreeDiff(repositoryPath: string, worktreePath: string): void {
    const trackedDiff = safeGitBuffer(repositoryPath, ['diff', '--binary', 'HEAD']);
    if (trackedDiff.length > 0) safeGit(worktreePath, ['apply', '--binary', '-'], { input: trackedDiff });
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

    if (trackedDiff.length === 0 && copied === 0) return;
    this.git(worktreePath, ['add', '.']);
    // Explicit identity: production containers have no global git identity, and the checker worktree (cut from the
    // maker's dirty worktree) died here with "Author identity unknown" (2026-09-21 loop proof).
    this.git(worktreePath, ['-c', 'user.name=djimitflo', '-c', 'user.email=djimitflo@localhost', 'commit', '-m', 'Snapshot source working tree into worker worktree', '--no-verify']);
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
      .prepare('SELECT wl.worktree_path, wl.status, lr.repository_path FROM worker_leases wl LEFT JOIN loop_runs lr ON lr.id = wl.loop_run_id WHERE wl.worktree_path IS NOT NULL')
      .all() as Array<{ worktree_path: string; status: string; repository_path: string | null }>;
    const leaseByPath = new Map(rows.map(row => [row.worktree_path, row]));
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

        const lease = leaseByPath.get(wtPath);
        if (lease && ACTIVE_LEASE.has(lease.status)) continue;

        const ageMs = nowMs - stat.mtimeMs;
        if (ageMs < maxAgeMs) continue;

        if (!dryRun) {
          try {
            if (lease?.repository_path) this.git(lease.repository_path, ['worktree', 'remove', '--force', wtPath]);
            else rmSync(wtPath, { recursive: true, force: true });
          } catch { /* best-effort */ }
          finally {
            if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
            if (lease?.repository_path) {
              try { this.git(lease.repository_path, ['worktree', 'prune']); } catch { /* best-effort */ }
            }
          }
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
      return safeGit(repositoryPath, args).trim();
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

  /**
   * SECURITY: Verify a worktree path is within the allowed worktree root.
   * Prevents path traversal attacks via crafted finding IDs.
   */
  isPathAllowed(worktreePath: string): boolean {
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT || path.resolve(process.cwd(), '.djimitflo-loop-worktrees');
    const resolved = path.resolve(worktreePath);
    const resolvedRoot = path.resolve(worktreeRoot);
    return resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot;
  }

  /**
   * SECURITY: Sanitize a finding ID for use in branch names and paths.
   * Prevents injection of path traversal or shell metacharacters.
   */
  sanitizeFindingId(findingId: string): string {
    return findingId
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/\.{2,}/g, '-')
      .slice(0, 64);
  }

  /**
   * SECURITY: Validate that a worktree operation is safe to perform.
   * Checks path safety, git state, and resource limits.
   */
  validateWorktreeSafety(repositoryPath: string, worktreePath: string): { safe: boolean; reason?: string } {
    if (!this.isPathAllowed(worktreePath)) {
      return { safe: false, reason: 'Worktree path outside allowed root' };
    }

    if (!existsSync(repositoryPath)) {
      return { safe: false, reason: 'Repository path does not exist' };
    }

    try {
      this.git(repositoryPath, ['rev-parse', '--show-toplevel']);
    } catch {
      return { safe: false, reason: 'Not a valid git repository' };
    }

    return { safe: true };
  }
}
