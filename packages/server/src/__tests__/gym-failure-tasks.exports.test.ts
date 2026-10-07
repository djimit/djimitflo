import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAILURE_TASK_CAPABILITY,
  failureDerivedTasks,
  failureRows,
  failureTaskEvidence,
  gitLookup,
  gymFailureTasksEnabled,
  qualifyingFailures,
  type FailureRow,
  type GitLookup,
} from '../services/gym-failure-tasks';
import type { Database } from 'better-sqlite3';

let repo: string;

const git = (args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-fail-'));
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'target.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'base']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('gym-failure-tasks exports', () => {
  it('gymFailureTasksEnabled reads GYM_FAILURE_TASKS_ENABLED', () => {
    expect(gymFailureTasksEnabled({})).toBe(false);
    expect(gymFailureTasksEnabled({ GYM_FAILURE_TASKS_ENABLED: 'true' })).toBe(true);
    expect(gymFailureTasksEnabled({ GYM_FAILURE_TASKS_ENABLED: 'false' })).toBe(false);
  });

  it('FAILURE_TASK_CAPABILITY is the write_test literal', () => {
    expect(FAILURE_TASK_CAPABILITY).toBe('write_test');
  });

  describe('gitLookup', () => {
    let lookup: GitLookup;
    let baseCommit: string;

    beforeEach(() => {
      lookup = gitLookup(repo);
      baseCommit = git(['rev-parse', 'HEAD']).trim();
    });

    it('baseAt returns the newest main commit at or before the given time, null for far future in pre-history', () => {
      const iso = new Date().toISOString();
      const got = lookup.baseAt(iso);
      expect(got).toBe(baseCommit);
      // a time before any commit returns an empty rev-list -> null (git prints nothing)
      expect(lookup.baseAt('1970-01-01T00:00:00Z')).toBe(null);
    });

    it('exists reports whether a path exists at a commit', () => {
      expect(lookup.exists(baseCommit, 'target.ts')).toBe(true);
      expect(lookup.exists(baseCommit, 'missing.ts')).toBe(false);
    });

    it('lines counts the lines of a file at a commit, 0 when absent', () => {
      expect(lookup.lines(baseCommit, 'target.ts')).toBe(2);
      expect(lookup.lines(baseCommit, 'missing.ts')).toBe(0);
    });
  });

  describe('qualifyingFailures', () => {
    const ok: FailureRow = {
      proposal_id: 'p1',
      evidence: 'test-gap:some#exports',
      artifact: 'packages/server/src/__tests__/foo.test.ts',
      target: 'packages/server/src/services/foo.ts',
      command: 'npx vitest run src/__tests__/foo.test.ts',
      run_id: 'r1',
      run_created_at: '2025-01-01T00:00:00Z',
      changed_files: null,
    };

    it('keeps a well-formed exports-lane row', () => {
      const out = qualifyingFailures([ok]);
      expect(out).toHaveLength(1);
      expect(out[0].lane).toBe('exports');
    });

    it('drops mutation-lane rows (laneOf returns null)', () => {
      const out = qualifyingFailures([{ ...ok, evidence: 'mutation-gap:foo' }]);
      expect(out).toHaveLength(0);
    });

    it('drops rows missing run metadata', () => {
      expect(qualifyingFailures([{ ...ok, run_id: null }])).toHaveLength(0);
      expect(qualifyingFailures([{ ...ok, run_created_at: null }])).toHaveLength(0);
    });

    it('drops rows whose artifact/target/command do not match the regexes', () => {
      expect(qualifyingFailures([{ ...ok, artifact: 'bad/path.test.ts' }])).toHaveLength(0);
      expect(qualifyingFailures([{ ...ok, target: 'packages/server/src/x.ts' }])).toHaveLength(0);
      expect(qualifyingFailures([{ ...ok, command: 'npm test' }])).toHaveLength(0);
    });

    it('deduplicates by target+artifact', () => {
      const out = qualifyingFailures([ok, { ...ok, proposal_id: 'p2' }]);
      expect(out).toHaveLength(1);
    });
  });

  describe('db-backed helpers with a stub database', () => {
    const stub = (rows: any[]): Database => ({ prepare: () => ({ all: () => rows, get: () => ({ n: 7 }) }) } as unknown as Database);

    it('failureRows swallows db errors and returns []', () => {
      const bad = { prepare: () => { throw new Error('no such table'); } } as unknown as Database;
      expect(failureRows(bad)).toEqual([]);
    });

    it('failureRows maps the selected columns into FailureRow[]', () => {
      const row = { proposal_id: 'p', evidence: 'e', artifact: 'a', target: 't', command: 'c', run_id: 'r', run_created_at: 'x', changed_files: null };
      expect(failureRows(stub([row]))).toEqual([row]);
    });

    it('failureDerivedTasks yields a write_test task when the target exists at base and the artifact does not', () => {
      const baseCommit = git(['rev-parse', 'HEAD']).trim();
      const lookup = gitLookup(repo);
      const row: FailureRow = {
        proposal_id: 'p1',
        evidence: 'test-gap:some#exports',
        artifact: 'packages/server/src/__tests__/new.test.ts',
        target: 'packages/server/src/services/foo.ts',
        command: 'npx vitest run src/__tests__/new.test.ts',
        run_id: 'r1',
        run_created_at: new Date().toISOString(),
        changed_files: null,
      };
      // the target must live at packages/server/src/services/foo.ts for lookup.exists to find it
      fs.mkdirSync(path.join(repo, 'packages/server/src/services'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'packages/server/src/services/foo.ts'), 'export const f = 1;\n');
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'svc']);
      const base = git(['rev-parse', 'HEAD']).trim();

      const db = stub([row]);
      const tasks = failureDerivedTasks(db, lookup);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: 'write_test',
        base,
        source: row.artifact,
        target: row.target,
        run_id: 'r1',
        lane: 'exports',
      });
      expect(tasks[0].commit).toBe('fail:r1');
    });

    it('failureDerivedTasks is empty when the target does not exist at the base', () => {
      const lookup = gitLookup(repo);
      const baseCommit = git(['rev-parse', 'HEAD']).trim();
      const row: FailureRow = {
        proposal_id: 'p1',
        evidence: 'test-gap:some#exports',
        artifact: 'packages/server/src/__tests__/new.test.ts',
        target: 'packages/server/src/services/missing.ts',
        command: 'npx vitest run src/__tests__/new.test.ts',
        run_id: 'r1',
        run_created_at: new Date().toISOString(),
        changed_files: null,
      };
      expect(failureDerivedTasks(stub([row]), lookup)).toHaveLength(0);
    });

    it('failureTaskEvidence reports enabled flag and counts without a lookup', () => {
      const row: FailureRow = {
        proposal_id: 'p1',
        evidence: 'test-gap:some#exports',
        artifact: 'packages/server/src/__tests__/foo.test.ts',
        target: 'packages/server/src/services/foo.ts',
        command: 'npx vitest run src/__tests__/foo.test.ts',
        run_id: 'r1',
        run_created_at: '2025-01-01T00:00:00Z',
        changed_files: null,
      };
      const ev = failureTaskEvidence(stub([row]), null, { GYM_FAILURE_TASKS_ENABLED: 'true' });
      expect(ev.enabled).toBe(true);
      expect(ev.qualifying_failures).toBe(1);
      expect(ev.available).toBe(null);
      expect(ev.attempted).toBe(7);
      expect(ev.solved).toBe(7);
      expect(ev.note).toContain('write_test');
    });
  });
});