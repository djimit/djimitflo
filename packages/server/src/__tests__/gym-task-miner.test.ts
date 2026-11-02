import { expect, it } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { mineGymTasks, minedTaskAt, parseNumstat, selectGymTasks } from '../services/gym-task-miner';

const log = [
  '@aaa', '10\t2\tpackages/server/src/services/queue-hygiene-service.ts', '30\t0\tpackages/server/src/__tests__/queue-hygiene.test.ts',
  '@bbb', '5\t1\tpackages/server/src/services/a.ts', '5\t1\tpackages/server/src/services/b.ts', '9\t0\tpackages/server/src/__tests__/a.test.ts', // two sources
  '@ccc', '200\t50\tpackages/server/src/services/queue-hygiene-service.ts', '3\t0\tpackages/server/src/__tests__/q.test.ts', // too big
  '@ddd', '4\t1\tpackages/server/src/services/auth-service.ts', '3\t0\tpackages/server/src/__tests__/auth.test.ts', // sensitive
  '@eee', '4\t1\tpackages/server/src/services/orphan.ts', '3\t0\tpackages/server/src/__tests__/orphan.test.ts', // dead code
  '@fff', '4\t1\tpackages/server/src/services/queue-hygiene-service.ts', // no test
].join('\n');

it('selects commits that changed one small, live, non-sensitive service together with its tests', () => {
  const live = new Set(['queue-hygiene-service', 'a', 'b', 'auth-service']);
  expect(selectGymTasks(parseNumstat(log), live)).toEqual([
    { commit: 'aaa', source: 'packages/server/src/services/queue-hygiene-service.ts', tests: ['packages/server/src/__tests__/queue-hygiene.test.ts'], sourceLines: 12 },
  ]);
});

const repo = path.resolve(__dirname, '../../../..');
// CI checks out with depth 1: there is no history to mine there
const shallow = (() => { try { return execFileSync('git', ['-C', repo, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true'; } catch { return true; } })();

it.skipIf(shallow)('mines real replay tasks from this repository', () => {
  const tasks = mineGymTasks(repo, { sinceDays: 3650 });
  expect(tasks.length).toBeGreaterThan(20); // prod 2026-09-25: 151 candidates since June before the live/sensitive filters
  for (const t of tasks) expect(t.source).toMatch(/^packages\/server\/src\/services\//);
  // the parent must have the source to restore (prod 2026-09-27: 584cbadb added agent-liveness.ts; every attempt failed)
  for (const t of tasks) expect(() => execFileSync('git', ['-C', repo, 'cat-file', '-e', `${t.commit}^:${t.source}`], { stdio: 'ignore' })).not.toThrow();
});

it('minedTaskAt rebuilds a frozen task from its own commit, outside the mining window and the live-service check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-task-at-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const write = (file: string, text: string) => { fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  try {
    git('init', '-q'); git('config', 'user.email', 'gym@example.invalid'); git('config', 'user.name', 'Gym Test');
    const src = 'packages/server/src/services/widget.ts'; const test = 'packages/server/src/__tests__/widget.test.ts';
    write(src, 'export const w = 1;\n'); write(test, 'it.todo("w");\n'); git('add', '.'); git('commit', '-qm', 'add widget');
    const added = git('rev-parse', 'HEAD');
    write(src, 'export const w = 2;\n'); write(test, 'it.todo("w = 2");\n'); git('add', '.'); git('commit', '-qm', 'fix widget');
    const fix = git('rev-parse', 'HEAD');
    // imported nowhere (not live): the miner drops it, the frozen task is still rebuilt as it was mined
    expect(mineGymTasks(dir)).toEqual([]);
    expect(minedTaskAt(dir, fix)).toEqual({ commit: fix, source: src, tests: [test], sourceLines: 2 });
    expect(minedTaskAt(dir, added)).toBeNull(); // the commit added its source: no parent version to restore
    expect(minedTaskAt(dir, 'f'.repeat(40))).toBeNull(); // not in this checkout
    expect(minedTaskAt(dir, '--all')).toBeNull(); // never an option
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
