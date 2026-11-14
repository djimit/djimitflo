import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeGit, safeGitEnv, safeGitSpawn } from '../services/safe-git';

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
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\necho pre-receive >> "${marker}"\n`, { mode: 0o755 });
    git(repo, 'config', 'protocol.file.allow', 'always');
    expect(safeGitSpawn(repo, ['push', '-q', remote, 'HEAD:refs/heads/x']).stderr).toMatch(/transport 'file' not allowed/);
    expect(safeGitSpawn(repo, ['push', '-q', remote, 'HEAD:refs/heads/x'], { protocols: 'file' }).status).toBe(0);
    expect(git(remote, 'rev-parse', 'x')).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(fired()).toBe(''); // the local receive-pack inherits core.hooksPath=/dev/null
  });
});
