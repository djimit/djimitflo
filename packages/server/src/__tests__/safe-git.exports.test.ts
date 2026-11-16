import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeGitBuffer, unsafeRepoConfig } from '../services/safe-git';

/**
 * B? exports: unsafeRepoConfig finds repo-local config that `-c` cannot neutralise, and safeGitBuffer is the
 * binary variant of safeGit. These exported helpers had no test naming them; this test-only file covers them.
 */
let dir: string; let repo: string;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-git-exports-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('unsafeRepoConfig', () => {
  it('returns null for a clean repository', () => {
    expect(unsafeRepoConfig(repo)).toBeNull();
  });

  it('returns null for a path that is not a repository', () => {
    const elsewhere = path.join(dir, 'not-a-repo');
    fs.mkdirSync(elsewhere);
    expect(unsafeRepoConfig(elsewhere)).toBeNull();
  });

  it('returns "local:<key>" for a local-scope filter.clean driver', () => {
    git(repo, 'config', 'filter.bad.clean', 'evil-program');
    expect(unsafeRepoConfig(repo)).toBe('local:filter.bad.clean');
  });

  it('matches diff.external in local scope', () => {
    git(repo, 'config', 'diff.external', 'evil-diff');
    expect(unsafeRepoConfig(repo)).toBe('local:diff.external');
  });

  it('matches merge.<x>.driver in local scope', () => {
    git(repo, 'config', 'merge.bad.driver', 'evil-merge');
    expect(unsafeRepoConfig(repo)).toBe('local:merge.bad.driver');
  });

  it('ignores safe keys and global-scope unsafe keys', () => {
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', '--global', 'filter.global.clean', 'evil');
    expect(unsafeRepoConfig(repo)).toBeNull();
  });
});

describe('safeGitBuffer', () => {
  it('returns a Buffer of binary git output (cat-file blob)', () => {
    const sha = git(repo, 'rev-parse', 'HEAD:a.txt');
    const buf = safeGitBuffer(repo, ['cat-file', 'blob', sha]);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString('utf8')).toBe('a\n');
  });

  it('returns a Buffer containing binary diff output', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    git(repo, 'add', '.');
    const buf = safeGitBuffer(repo, ['diff', '--binary', 'HEAD']);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString('utf8')).toContain('a.txt');
  });

  it('throws SAFE_GIT_UNSAFE_CONFIG when the repo defines an unsafe local config', () => {
    git(repo, 'config', 'filter.bad.clean', 'evil-program');
    expect(() => safeGitBuffer(repo, ['rev-parse', 'HEAD'])).toThrow(/SAFE_GIT_UNSAFE_CONFIG/);
  });

  it('honours secretConfig without putting the value in argv', () => {
    const out = safeGitBuffer(repo, ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/o/r.git'], {
      secretConfig: { 'http.https://github.com/.extraheader': 'AUTHORIZATION: basic c2VjcmV0' },
    });
    expect(out.toString('utf8').trim()).toBe('AUTHORIZATION: basic c2VjcmV0');
  });
});
