import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDb } from './helpers/test-db';
import { WorktreeManager } from '../services/worktree-manager';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

it('snapshots a dirty source worktree without any global git identity (production containers have none)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-id-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  git(repo, 'init', '-q'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x'); git(repo, 'add', 'dirty.txt'); // uncommitted change to snapshot
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LOOP_WORKTREE_ROOT: path.join(dir, 'wt') });
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
  const wm = new WorktreeManager(createTestDb());
  const wt = wm.createWorktree(repo, 'run1', 'f1', 'branch-f1', false);
  expect(fs.readFileSync(path.join(wt, 'dirty.txt'), 'utf8')).toBe('x');
});
