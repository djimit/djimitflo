/**
 * RemoteGitService — shallow, deterministic Git clones for the explainer pipeline.
 *
 * Cache layout:
 *   $DJIMITFLO_EXPLAINER_CACHE/repos/:owner/:repo/:commit/
 *
 * Uses `git ls-remote` preflight to resolve HEAD and `git clone --depth 1 --single-branch`
 * for shallow clones. Lockfiles prevent concurrent clones of the same commit.
 */

import { execFile, execFileSync } from 'child_process';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

export interface CloneOptions {
  branch?: string;
  tag?: string;
  /** GitHub owner/repo shorthand, e.g. "djimit/juraregel". */
  ownerRepo?: string;
  /** Full remote URL. If omitted, ownerRepo is required and GitHub is assumed. */
  remoteUrl?: string;
  /** Timeout in ms for git commands. */
  timeoutMs?: number;
}

export interface CloneResult {
  path: string;
  commit: string;
  branch: string;
  clonedAt: string;
  fromCache: boolean;
}

export interface RemoteHead {
  commit: string;
  ref: string;
}

export class RemoteGitService {
  private cacheRoot: string;
  private gitTimeout: number;

  constructor(cacheRoot?: string, gitTimeout = 60_000) {
    this.cacheRoot = cacheRoot ?? join(tmpdir(), 'djimitflo-explainer-cache');
    this.gitTimeout = gitTimeout;
    mkdirSync(join(this.cacheRoot, 'repos'), { recursive: true });
  }

  private buildUrl(ownerRepo?: string, remoteUrl?: string): string {
    if (remoteUrl) return remoteUrl;
    if (!ownerRepo) throw new Error('ownerRepo or remoteUrl is required');
    return `https://github.com/${ownerRepo}.git`;
  }

  private parseOwnerRepo(ownerRepo?: string): { owner: string; repo: string } {
    if (!ownerRepo) throw new Error('ownerRepo is required');
    const [owner, repo, ...rest] = ownerRepo.split('/');
    if (!owner || !repo || rest.length > 0) {
      throw new Error(`Invalid ownerRepo format: ${ownerRepo}`);
    }
    return { owner, repo };
  }

  private lockPath(targetPath: string): string {
    return `${targetPath}.lock`;
  }

  private acquireLock(lockPath: string): void {
    if (existsSync(lockPath)) {
      throw new Error(`Clone lock exists: ${lockPath}`);
    }
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid));
  }

  private releaseLock(lockPath: string): void {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }

  private execFileSyncSafe(cmd: string, args: string[], cwd?: string): string {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout: this.gitTimeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  resolveRemoteHead(ownerRepo?: string, remoteUrl?: string, branch?: string): RemoteHead {
    const url = this.buildUrl(ownerRepo, remoteUrl);
    const ref = branch ? `refs/heads/${branch}` : 'HEAD';
    const output = this.execFileSyncSafe('git', ['ls-remote', url, ref]).trim();
    if (!output) {
      throw new Error(`Could not resolve remote HEAD for ${url} ${ref}`);
    }
    const [commit, resolvedRef] = output.split(/\s+/);
    return { commit, ref: resolvedRef ?? ref };
  }

  async cloneRepository(ownerRepo: string, options: CloneOptions = {}): Promise<CloneResult> {
    const { owner, repo } = this.parseOwnerRepo(ownerRepo);
    const remoteUrl = options.remoteUrl ?? this.buildUrl(ownerRepo);

    const head = this.resolveRemoteHead(ownerRepo, options.remoteUrl, options.branch);
    const effectiveBranch = head.ref.replace(/^refs\/heads\//, '');
    const commit = head.commit;

    const targetPath = join(this.cacheRoot, 'repos', owner, repo, commit);
    const lockPath = this.lockPath(targetPath);

    if (existsSync(targetPath)) {
      return {
        path: targetPath,
        commit,
        branch: effectiveBranch,
        clonedAt: new Date().toISOString(),
        fromCache: true,
      };
    }

    this.acquireLock(lockPath);
    try {
      // Double-check after lock acquisition
      if (existsSync(targetPath)) {
        return {
          path: targetPath,
          commit,
          branch: effectiveBranch,
          clonedAt: new Date().toISOString(),
          fromCache: true,
        };
      }

      mkdirSync(dirname(targetPath), { recursive: true });

      const args = [
        'clone',
        '--depth',
        '1',
        '--single-branch',
      ];
      if (options.branch) {
        args.push('--branch', options.branch);
      }
      args.push(remoteUrl, targetPath);

      await new Promise<void>((resolve, reject) => {
        const child = execFile('git', args, {
          timeout: this.gitTimeout,
          maxBuffer: 32 * 1024 * 1024,
        }, (error) => {
          if (error) reject(error);
          else resolve();
        });
        child.stderr?.on('data', () => {
          // swallow verbose git stderr
        });
      });

      return {
        path: targetPath,
        commit,
        branch: effectiveBranch,
        clonedAt: new Date().toISOString(),
        fromCache: false,
      };
    } catch (error) {
      // Clean up partial clone
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw error;
    } finally {
      this.releaseLock(lockPath);
    }
  }

  getCacheRoot(): string {
    return this.cacheRoot;
  }
}
