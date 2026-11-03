import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../services/worktree-manager';

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repair-'));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin); git(origin, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(origin, 'a.txt'), 'a');
  git(origin, 'add', '.'); git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('re-registers a worktree whose runtime clone was replaced by a deploy, keeping its files', () => {
  const origin = path.join(root, 'origin');
  const oldClone = path.join(root, 'runtime-source-old');
  execFileSync('git', ['clone', '-q', origin, oldClone]);
  const worktree = path.join(root, 'worktrees', 'run', 'finding');
  process.env.LOOP_WORKTREE_ROOT = path.join(root, 'worktrees');
  const wm = new WorktreeManager(new Database(':memory:'));
  try {
    expect(wm.createWorktree(oldClone, 'run', 'finding', 'agent/loop/run-finding', false)).toBe(worktree);
    fs.mkdirSync(path.join(worktree, '.djimitflo')); fs.writeFileSync(path.join(worktree, '.djimitflo', 'LOOP_WORK.md'), 'assignment');
    // deploy: a fresh clone replaces the runtime repository
    fs.rmSync(oldClone, { recursive: true, force: true });
    const newClone = path.join(root, 'runtime-source-new');
    execFileSync('git', ['clone', '-q', origin, newClone]);
    expect(() => git(worktree, 'rev-parse', '--git-dir')).toThrow();

    expect(wm.repairWorktree(newClone, worktree, 'agent/loop/run-finding')).toBe(true);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent/loop/run-finding');
    expect(fs.readFileSync(path.join(worktree, '.djimitflo', 'LOOP_WORK.md'), 'utf8')).toBe('assignment');
    expect(fs.readFileSync(path.join(worktree, 'a.txt'), 'utf8')).toBe('a');
    expect(wm.repairWorktree(newClone, worktree, 'agent/loop/run-finding')).toBe(false); // healthy now
    expect(fs.readdirSync(path.dirname(worktree))).toEqual(['finding']); // nothing left aside
  } finally { delete process.env.LOOP_WORKTREE_ROOT; }
});
