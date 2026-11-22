import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { LoopPersistenceService } from '../services/loop-persistence-service';
import { WorktreeManager } from '../services/worktree-manager';

/**
 * D3 (H4 2026-11-14): server-side git in a maker-controlled worktree must never execute repo-local config. Each case plants
 * a command that appends to a marker file and runs the server's own code path against the worktree.
 */
let dir: string; let repo: string; let marker: string;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const evil = (tag: string) => `sh -c 'echo ${tag} >> "${marker}"; exit 0'`;
const fired = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-git-'));
  repo = path.join(dir, 'repo'); marker = path.join(dir, 'marker');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  process.env.LOOP_WORKTREE_ROOT = path.join(dir, 'worktrees');
});
afterEach(() => { process.env = { ...saved }; fs.rmSync(dir, { recursive: true, force: true }); });

describe('repo-local config never runs a command', () => {
  it('core.fsmonitor in the maker repo config does not run on the gate git calls (status/diff)', () => {
    git(repo, 'config', 'core.fsmonitor', evil('fsmonitor'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    const persistence = new LoopPersistenceService(dir);
    expect(persistence.git(repo, ['status', '--porcelain'])).toContain('a.txt');
    expect(persistence.workingTreeDiff(repo)).toContain('+changed');
    expect(fired()).toBe('');
  });

  it('hooks (core.hooksPath and .git/hooks) do not run when the checker worktree is cut from a maker worktree', () => {
    const hooks = path.join(dir, 'evil-hooks'); fs.mkdirSync(hooks);
    for (const hook of ['post-checkout', 'pre-commit', 'reference-transaction', 'post-commit']) {
      for (const where of [hooks, path.join(repo, '.git', 'hooks')]) {
        fs.writeFileSync(path.join(where, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
      }
    }
    git(repo, 'config', 'core.hooksPath', hooks);
    git(repo, 'config', 'core.fsmonitor', evil('fsmonitor'));
    fs.writeFileSync(path.join(repo, 'maker-change.txt'), 'new\n'); // dirty maker tree: forces the snapshot commit
    const wt = new WorktreeManager(createTestDb()).createWorktree(repo, 'run1', 'checker-1', 'agent/loop/run1-checker', false);
    expect(fs.readFileSync(path.join(wt, 'maker-change.txt'), 'utf8')).toBe('new\n');
    expect(fired()).toBe('');
  });

  it('refuses a repo-local filter driver instead of running it', () => {
    git(repo, 'config', 'filter.x.clean', evil('clean'));
    git(repo, 'config', 'filter.x.process', evil('process'));
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=x\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    expect(() => new LoopPersistenceService(dir).git(repo, ['diff', '--', '.'])).toThrow(/SAFE_GIT_UNSAFE_CONFIG: local:filter\.x\.(clean|process)/);
    expect(fired()).toBe('');
  });

  it('refuses repo-local diff drivers and an external diff', () => {
    git(repo, 'config', 'diff.external', evil('external'));
    expect(() => new LoopPersistenceService(dir).git(repo, ['diff'])).toThrow(/SAFE_GIT_UNSAFE_CONFIG: local:diff\.external/);
    git(repo, 'config', '--unset', 'diff.external');
    git(repo, 'config', 'diff.y.textconv', evil('textconv'));
    expect(() => new LoopPersistenceService(dir).git(repo, ['log', '-p'])).toThrow(/SAFE_GIT_UNSAFE_CONFIG: local:diff\.y\.textconv/);
    expect(fired()).toBe('');
  });

  it('a repointed .git file (maker-made gitdir) is held to the same rules', () => {
    const wt = new WorktreeManager(createTestDb()).createWorktree(repo, 'run2', 'maker-1', 'agent/loop/run2-maker', false);
    const fake = path.join(wt, '.evil-gitdir');
    execFileSync('git', ['init', '-q', '--separate-git-dir', fake, path.join(dir, 'scratch')]);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${fake}\n`);
    git(wt, 'config', 'core.fsmonitor', evil('fsmonitor'));
    fs.writeFileSync(path.join(fake, 'hooks', 'post-index-change'), `#!/bin/sh\necho post-index-change >> "${marker}"\n`, { mode: 0o755 });
    new LoopPersistenceService(dir).git(wt, ['status', '--porcelain']);
    expect(fired()).toBe('');
  });
});
