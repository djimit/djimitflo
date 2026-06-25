import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * Item A: the `createWorktree` bounded retry on git lock errors. The retry loop
 * itself is exercised by spying on the private `git` method so we can make the
 * first `worktree add` fail with a lock-class error and the next succeed,
 * deterministically (orchestrating a real concurrent git lock would be
 * non-deterministic). The `isGitLockError` classifier is tested directly.
 */
describe('createWorktree git-lock retry', () => {
  let db: Database.Database;
  let worktreeRoot: string;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-wt-retry-'));
    process.env.LOOP_WORKTREE_ROOT = worktreeRoot;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    delete process.env.LOOP_WORKTREE_ROOT;
    for (const k of Object.keys(process.env)) {
      if (!(k in previousEnv)) delete (process.env as any)[k];
    }
    Object.assign(process.env, previousEnv);
  });

  it('isGitLockError classifies lock vs non-lock git errors', () => {
    const classify = (LoopService as any).isGitLockError.bind(LoopService) as (e: Error) => boolean;
    expect(classify(new Error("fatal: Unable to create '/repo/.git/worktree.lock': File exists."))).toBe(true);
    expect(classify(new Error("fatal: Unable to create '/repo/.git/index.lock': File exists. Another git process seems to be running in this repo."))).toBe(true);
    expect(classify(new Error('fatal: not a git repository'))).toBe(false);
    expect(classify(new Error('fatal: invalid reference: bad-branch'))).toBe(false);
  });

  it('retries worktree add on a lock error then succeeds', () => {
    const loops = new LoopService(db);
    const repoPath = path.join(worktreeRoot, 'fake-repo');
    // Neutralise the sync sleep so the test does not wait on backoff.
    vi.spyOn(loops as any, 'sleepSync').mockImplementation(() => {});
    vi.spyOn(loops as any, 'applySourceWorkingTreeDiff').mockImplementation(() => {});
    let worktreeAddCalls = 0;
    vi.spyOn(loops as any, 'git').mockImplementation((_repo: string, args: string[]) => {
      if (args[0] === 'rev-parse') return repoPath;
      if (args[0] === 'diff') return '';
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktreeAddCalls += 1;
        if (worktreeAddCalls === 1) {
          throw new Error("fatal: Unable to create '/repo/.git/worktree.lock': File exists. Another git process seems to be running.");
        }
        return '';
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    const result = (loops as any).createWorktree(repoPath, 'run-1', 'find-1', 'branch-1') as string;
    expect(result).toBe(path.join(worktreeRoot, 'run-1', 'find-1'));
    expect(worktreeAddCalls).toBe(2); // first failed (lock), second succeeded
  });

  it('sanitizes finding ids before using them as worktree path segments', () => {
    const loops = new LoopService(db);
    const repoPath = path.join(worktreeRoot, 'fake-repo');
    let worktreePathArg = '';
    vi.spyOn(loops as any, 'applySourceWorkingTreeDiff').mockImplementation(() => {});
    vi.spyOn(loops as any, 'git').mockImplementation((_repo: string, args: string[]) => {
      if (args[0] === 'rev-parse') return repoPath;
      if (args[0] === 'diff') return '';
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktreePathArg = args[4];
        return '';
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    const result = (loops as any).createWorktree(repoPath, 'run-3', 'proof-finding:proof-123', 'branch-3') as string;
    expect(result).toBe(path.join(worktreeRoot, 'run-3', 'proof-finding-proof-123'));
    expect(worktreePathArg).toBe(result);
  });

  it('keeps proof-run branch names unique beyond short common prefixes', () => {
    const loops = new LoopService(db);
    const first = (loops as any).branchNameFor('loop-73511111-aaaa', 'proof-finding:proof-11111111') as string;
    const second = (loops as any).branchNameFor('loop-73522222-bbbb', 'proof-finding:proof-22222222') as string;

    expect(first).not.toBe(second);
    expect(first).not.toContain(':');
    expect(second).not.toContain(':');
  });

  it('does not retry on a non-lock error and throws WORKTREE_CREATE_FAILED', () => {
    const loops = new LoopService(db);
    const repoPath = path.join(worktreeRoot, 'fake-repo');
    vi.spyOn(loops as any, 'sleepSync').mockImplementation(() => {});
    let worktreeAddCalls = 0;
    vi.spyOn(loops as any, 'git').mockImplementation((_repo: string, args: string[]) => {
      if (args[0] === 'rev-parse') return repoPath;
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktreeAddCalls += 1;
        throw new Error('fatal: invalid reference: bad-branch');
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    });

    expect(() => (loops as any).createWorktree(repoPath, 'run-2', 'find-2', 'bad-branch')).toThrow(/WORKTREE_CREATE_FAILED/);
    expect(worktreeAddCalls).toBe(1); // no retry for a non-lock error
  });
});
