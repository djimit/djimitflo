import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SAFE_GIT_CONFIG,
  UNSAFE_REPO_CONFIG_KEY,
  safeGit,
  safeGitBuffer,
  safeGitEnv,
  safeGitSpawn,
  unsafeRepoConfig,
} from '../services/safe-git';

/** D3 (H4 2026-11-14): the safe-git helper's env and transport rules (the marker cases are in server-git-hardening.test.ts). */
let dir: string; let repo: string; let marker: string;
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const fired = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-git-'));
  repo = path.join(dir, 'repo'); marker = path.join(dir, 'marker');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
});
afterEach(() => { process.env = { ...saved }; fs.rmSync(dir, { recursive: true, force: true }); });

describe('environment and transports', () => {
  it('passes no server secret to git', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret'; process.env.JWT_SECRET = 'jwt'; process.env.DJIMITFLO_SPAWN_TOKEN_SECRET = 'spawn';
    process.env.GIT_DIR = '/elsewhere'; process.env.GIT_SSH_COMMAND = 'evil';
    const env = safeGitEnv();
    for (const k of ['GITHUB_TOKEN', 'JWT_SECRET', 'DJIMITFLO_SPAWN_TOKEN_SECRET', 'GIT_DIR', 'GIT_SSH_COMMAND']) expect(env[k]).toBeUndefined();
    expect(env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' });
    expect(env.PATH).toBe(process.env.PATH);
    expect(safeGit(repo, ['rev-parse', '--show-toplevel']).trim()).toBe(fs.realpathSync(repo)); // GIT_DIR did not leak in
  });

  it('a secret config value reaches git without being an argument, and only for the URL it is scoped to', () => {
    const header = { 'http.https://github.com/.extraheader': 'AUTHORIZATION: basic c2VjcmV0' };
    expect(safeGit(repo, ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/o/r.git'], { secretConfig: header }).trim()).toBe('AUTHORIZATION: basic c2VjcmV0');
    expect(safeGitSpawn(repo, ['config', '--get-urlmatch', 'http.extraheader', 'https://evil.example/o/r.git'], { secretConfig: header }).status).toBe(1);
  });

  it('allows no transport unless the call names it (protocol config of the repo cannot re-enable one)', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret';
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\necho "token=$GITHUB_TOKEN" >> "${marker}"\n`, { mode: 0o755 });
    git(repo, 'config', 'protocol.file.allow', 'always');
    expect(safeGitSpawn(repo, ['push', '-q', remote, 'HEAD:refs/heads/x']).stderr).toMatch(/transport 'file' not allowed/);
    expect(safeGitSpawn(repo, ['push', '-q', remote, 'HEAD:refs/heads/x'], { protocols: 'file' }).status).toBe(0);
    expect(git(remote, 'rev-parse', 'x')).toBe(git(repo, 'rev-parse', 'HEAD'));
    // a local remote's own hooks may run (git-version dependent: file is a test-only transport), but never with a server secret
    expect(fired()).not.toContain('ghp_secret');
  });
});

describe('SAFE_GIT_CONFIG', () => {
  it('lists every neutralising config entry', () => {
    for (const entry of [
      'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false',
      'credential.helper=', 'core.askPass=', 'core.editor=false', 'sequence.editor=false',
      'commit.gpgSign=false', 'tag.gpgSign=false', 'push.gpgSign=false', 'log.showSignature=false',
      'gc.auto=0', 'maintenance.auto=false',
    ]) expect(SAFE_GIT_CONFIG).toContain(entry);
    expect(SAFE_GIT_CONFIG.length).toBeGreaterThanOrEqual(13);
  });

  it('applies the neutralising -c entries on every call (baseArgs is not emptied)', () => {
    expect(safeGit(repo, ['config', '--get', 'core.hooksPath']).trim()).toBe('/dev/null');
    expect(safeGit(repo, ['config', '--get', 'core.fsmonitor']).trim()).toBe('false');
    expect(safeGit(repo, ['config', '--get', 'core.untrackedCache']).trim()).toBe('false');
    expect(safeGit(repo, ['config', '--get', 'credential.helper']).trim()).toBe('');
    expect(safeGit(repo, ['config', '--get', 'gc.auto']).trim()).toBe('0');
    expect(safeGit(repo, ['config', '--get', 'maintenance.auto']).trim()).toBe('false');
    expect(safeGit(repo, ['config', '--get', 'commit.gpgSign']).trim()).toBe('false');
  });

  it('forwards extra trusted config entries (and drops none)', () => {
    expect(safeGit(repo, ['config', '--get', 'user.name'], { config: ['user.name=loop', 'user.email=loop@djimitflo'] }).trim()).toBe('loop');
    expect(safeGit(repo, ['config', '--get', 'user.email'], { config: ['user.name=loop', 'user.email=loop@djimitflo'] }).trim()).toBe('loop@djimitflo');
    // a config entry that is not forwarded would make git exit 1 instead of returning the value
    expect(() => safeGit(repo, ['config', '--get', 'user.name'], { config: [] })).toThrow();
  });
});

describe('UNSAFE_REPO_CONFIG_KEY', () => {
  it('matches every command-defining key, case-insensitively', () => {
    for (const k of [
      'filter.foo.clean', 'filter.foo.smudge', 'filter.foo.process',
      'diff.foo.command', 'diff.foo.textconv', 'diff.external',
      'merge.foo.driver', 'remote.foo.uploadpack', 'remote.foo.receivepack',
      'core.alternateRefsCommand',
    ]) expect(UNSAFE_REPO_CONFIG_KEY.test(k)).toBe(true);
    expect(UNSAFE_REPO_CONFIG_KEY.test('core.ALTERNATEREFSCOMMAND')).toBe(true);
    expect(UNSAFE_REPO_CONFIG_KEY.test('FILTER.x.PROCESS')).toBe(true);
  });

  it('does not match safe keys', () => {
    for (const k of [
      'core.hooksPath', 'user.name', 'user.email', 'remote.foo.url',
      'core.fsmonitor', 'protocol.file.allow', 'gc.auto',
    ]) expect(UNSAFE_REPO_CONFIG_KEY.test(k)).toBe(false);
  });

  it('is anchored at both ends (^ and $)', () => {
    expect(UNSAFE_REPO_CONFIG_KEY.test('xcore.alternaterefscommand')).toBe(false);
    expect(UNSAFE_REPO_CONFIG_KEY.test('core.alternaterefscommandx')).toBe(false);
    expect(UNSAFE_REPO_CONFIG_KEY.test('xdiff.external')).toBe(false);
    expect(UNSAFE_REPO_CONFIG_KEY.test('diff.externalx')).toBe(false);
  });

  it('requires a non-empty segment between the outer dots (+, not a single char)', () => {
    expect(UNSAFE_REPO_CONFIG_KEY.test('filter.aa.clean')).toBe(true);
    expect(UNSAFE_REPO_CONFIG_KEY.test('diff.aa.command')).toBe(true);
    expect(UNSAFE_REPO_CONFIG_KEY.test('merge.aa.driver')).toBe(true);
    expect(UNSAFE_REPO_CONFIG_KEY.test('remote.aa.uploadpack')).toBe(true);
    expect(UNSAFE_REPO_CONFIG_KEY.test('remote.aa.receivepack')).toBe(true);
  });
});

describe('unsafeRepoConfig', () => {
  it('returns null (not undefined) for a clean repo', () => {
    expect(unsafeRepoConfig(repo)).toBe(null);
  });

  it('returns null outside a repository', () => {
    expect(unsafeRepoConfig(path.join(dir, 'no-such-repo'))).toBe(null);
  });

  it('detects a command-defining key in local scope as scope:key', () => {
    git(repo, 'config', 'filter.bad.clean', 'echo pwned');
    expect(unsafeRepoConfig(repo)).toBe('local:filter.bad.clean');
  });

  it('detects a command-defining key in worktree scope', () => {
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    git(wt, 'config', '--worktree', 'merge.bad.driver', 'echo pwned');
    expect(unsafeRepoConfig(wt)).toBe('worktree:merge.bad.driver');
  });

  it('ignores command-defining keys in global scope', () => {
    const home = path.join(dir, 'home'); fs.mkdirSync(home);
    process.env.HOME = home;
    git(repo, 'config', '--global', 'diff.bad.command', 'echo pwned');
    expect(unsafeRepoConfig(repo)).toBe(null);
  });

  it('ignores safe keys in local scope', () => {
    git(repo, 'config', 'user.name', 'safe');
    git(repo, 'config', 'remote.origin.url', 'https://example/o/r.git');
    git(repo, 'config', 'core.fsmonitor', 'false');
    expect(unsafeRepoConfig(repo)).toBe(null);
  });

  it('returns the first unsafe key when several are present', () => {
    git(repo, 'config', 'filter.first.clean', 'echo one');
    git(repo, 'config', 'merge.second.driver', 'echo two');
    const r = unsafeRepoConfig(repo);
    expect(r).not.toBeNull();
    expect(r).toMatch(/^local:(filter\.first\.clean|merge\.second\.driver)$/);
  });
});

describe('refusal on unsafe repo config', () => {
  it('safeGit throws SAFE_GIT_UNSAFE_CONFIG and runs no git', () => {
    git(repo, 'config', 'filter.bad.clean', 'echo pwned');
    expect(() => safeGit(repo, ['rev-parse', 'HEAD'])).toThrow(/SAFE_GIT_UNSAFE_CONFIG/);
  });

  it('safeGitSpawn returns status null with the reason in stderr and error', () => {
    git(repo, 'config', 'filter.bad.clean', 'echo pwned');
    const r = safeGitSpawn(repo, ['rev-parse', 'HEAD']);
    expect(r.status).toBe(null);
    expect(r.signal).toBe(null);
    expect(r.stderr).toMatch(/SAFE_GIT_UNSAFE_CONFIG/);
    expect(r.error).toBeInstanceOf(Error);
    expect(r.stdout).toBe('');
  });
});

describe('safeGitEnv pass-through env', () => {
  it('omits PASS_ENV keys that are absent from process.env', () => {
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    delete process.env.TMPDIR;
    const env = safeGitEnv();
    expect('LC_ALL' in env).toBe(false);
    expect('LC_CTYPE' in env).toBe(false);
    expect('TMPDIR' in env).toBe(false);
  });

  it('merges extra env and protocols over the base', () => {
    const env = safeGitEnv({ GIT_AUTHOR_NAME: 'loop' }, 'https');
    expect(env.GIT_AUTHOR_NAME).toBe('loop');
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });
});

describe('maxBuffer', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(200_000));
    git(repo, 'add', 'big.txt'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'big');
  });

  it('safeGit honours a small maxBuffer', () => {
    expect(() => safeGit(repo, ['cat-file', 'blob', 'HEAD:big.txt'], { maxBuffer: 1024 })).toThrow(/maxBuffer|ENOBUFS/i);
  });

  it('safeGit default maxBuffer fits a 200KB blob', () => {
    expect(safeGit(repo, ['cat-file', 'blob', 'HEAD:big.txt']).length).toBe(200_000);
  });

  it('safeGitBuffer honours a small maxBuffer and its default fits a 200KB blob', () => {
    expect(() => safeGitBuffer(repo, ['cat-file', 'blob', 'HEAD:big.txt'], { maxBuffer: 1024 })).toThrow(/maxBuffer|ENOBUFS/i);
    expect(safeGitBuffer(repo, ['cat-file', 'blob', 'HEAD:big.txt']).length).toBe(200_000);
  });

  it('safeGitSpawn honours a small maxBuffer and its default fits a 200KB blob', () => {
    const small = safeGitSpawn(repo, ['cat-file', 'blob', 'HEAD:big.txt'], { maxBuffer: 1024 });
    expect(small.status).not.toBe(0);
    expect(small.error).toBeInstanceOf(Error);
    expect(safeGitSpawn(repo, ['cat-file', 'blob', 'HEAD:big.txt']).status).toBe(0);
  });
});
