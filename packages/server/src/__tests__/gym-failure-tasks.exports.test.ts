import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitLookup } from '../services/gym-failure-tasks';

let repo: string;
const git = (args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-fail-git-'));
  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const commit = (msg: string, iso: string) => {
  git(['add', '-A']);
  execFileSync(
    'git',
    ['-C', repo, 'commit', '--quiet', '--allow-empty', '-m', msg, `--date=${iso}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: iso } },
  );
};

it('gitLookup.baseAt returns the newest first-parent commit at or before the given time', () => {
  commit('first', '2026-01-01T00:00:00');
  const first = git(['rev-parse', 'HEAD']);
  // backdate the second commit so HEAD time > query time but first commit <= query time
  commit('second', '2026-02-01T00:00:00');
  const before = git(['rev-parse', 'HEAD']);

  const lookup = gitLookup(repo);
  expect(lookup.baseAt('2026-01-15T00:00:00')).toBe(first);
  // a time after the last commit resolves to the last (first-parent) commit
  expect(lookup.baseAt('2026-03-01T00:00:00')).toBe(before);
});

it('gitLookup.baseAt returns null when no commit exists at or before the time', () => {
  const lookup = gitLookup(repo);
  expect(lookup.baseAt('2025-01-01T00:00:00')).toBe(null);
});

it('gitLookup.exists reports whether a path exists at a commit', () => {
  fs.mkdirSync(path.join(repo, 'packages/server/src/services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages/server/src/services/widget.ts'), 'export const w = 1;\n');
  commit('add widget', '2026-01-01T00:00:00');
  const head = git(['rev-parse', 'HEAD']);

  const lookup = gitLookup(repo);
  expect(lookup.exists(head, 'packages/server/src/services/widget.ts')).toBe(true);
  expect(lookup.exists(head, 'packages/server/src/services/missing.ts')).toBe(false);
});

it('gitLookup.show returns the file contents at a commit, or null when absent', () => {
  fs.mkdirSync(path.join(repo, 'packages/server/src/services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages/server/src/services/widget.ts'), 'export const w = 1;\n');
  commit('add widget', '2026-01-01T00:00:00');
  const head = git(['rev-parse', 'HEAD']);

  const lookup = gitLookup(repo);
  expect(lookup.show(head, 'packages/server/src/services/widget.ts')).toBe('export const w = 1;\n');
  expect(lookup.show(head, 'packages/server/src/services/missing.ts')).toBe(null);
});

it('gitLookup methods return null/false for an unknown commit without throwing', () => {
  const lookup = gitLookup(repo);
  expect(lookup.baseAt('2026-01-01T00:00:00')).toBe(null);
  expect(lookup.exists('0'.repeat(40), 'any.ts')).toBe(false);
  expect(lookup.show('0'.repeat(40), 'any.ts')).toBe(null);
});