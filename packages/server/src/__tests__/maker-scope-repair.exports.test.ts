import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  makerScopeRepairOn,
  scopeRepairPlan,
  repairMakerScope,
} from '../services/maker-scope-repair';
import type { LoopRunRecord, WorkerLeaseRecord } from '../services/loop-types';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE goals (id TEXT PRIMARY KEY, improvement_id TEXT);
    CREATE TABLE self_improvements (id TEXT PRIMARY KEY, evidence_refs_json TEXT, grounding_json TEXT);
  `);
  return db;
}

function seedOracleLane(db: Database.Database, goalId: string, improvementId: string, lane: 'test-gap' | 'mutation'): void {
  db.prepare("INSERT INTO self_improvements (id, evidence_refs_json, grounding_json) VALUES (?, ?, '{}')").run(
    improvementId,
    lane === 'mutation' ? '{"mutation-gap:x"}' : '{"test-gap:x"}',
  );
  db.prepare('INSERT INTO goals (id, improvement_id) VALUES (?, ?)').run(goalId, improvementId);
}

function run(goalId: string | null, loopName = 'test-gap'): LoopRunRecord {
  return {
    id: 'run-1',
    goal_id: goalId,
    loop_name: loopName,
    mode: 'closed',
    status: 'running',
    repository_path: null,
    state_file: null,
    findings: [],
    plan: {},
    gates: [],
    next_actions: [],
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
  };
}

function lease(overrides: Partial<WorkerLeaseRecord> = {}): WorkerLeaseRecord {
  return {
    id: 'lease-1',
    loop_run_id: 'run-1',
    role: 'maker',
    runtime: 'opencode',
    status: 'completed',
    finding_id: null,
    worktree_path: '/tmp/worktree',
    branch_name: 'b',
    budget: {},
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    parent_lease_id: null,
    spawn_tree_id: null,
    depth: 0,
    spawned_by_agent_id: null,
    ...overrides,
  };
}

describe('makerScopeRepairOn', () => {
  it('returns false by default (process.env has no MAKER_SCOPE_REPAIR)', () => {
    expect(makerScopeRepairOn({})).toBe(false);
  });

  it('returns true only when MAKER_SCOPE_REPAIR is exactly "on"', () => {
    expect(makerScopeRepairOn({ MAKER_SCOPE_REPAIR: 'on' })).toBe(true);
    expect(makerScopeRepairOn({ MAKER_SCOPE_REPAIR: 'off' })).toBe(false);
    expect(makerScopeRepairOn({ MAKER_SCOPE_REPAIR: 'true' })).toBe(false);
  });
});

describe('scopeRepairPlan', () => {
  it('returns null when scope is null or empty', () => {
    expect(scopeRepairPlan(null, ['package.json'], [])).toBeNull();
    expect(scopeRepairPlan('', ['package.json'], [])).toBeNull();
  });

  it('returns null when the out-of-scope set is empty (only the scope file changed)', () => {
    expect(scopeRepairPlan('src/foo.ts', ['src/foo.ts'], [])).toBeNull();
  });

  it('ignores .djimitflo/ files as outside-scope', () => {
    expect(scopeRepairPlan('src/foo.ts', ['src/foo.ts', '.djimitflo/state.json'], [])).toBeNull();
  });

  it('returns null when any outside file is not a package.json / package-lock.json manifest', () => {
    expect(scopeRepairPlan('src/foo.ts', ['src/foo.ts', 'README.md'], [])).toBeNull();
  });

  it('returns null when an outside manifest is untracked (no base version to restore)', () => {
    expect(scopeRepairPlan('src/foo.ts', ['src/foo.ts'], ['package.json'])).toBeNull();
  });

  it('returns the deduped manifests to restore when all outside files are tracked manifests', () => {
    expect(scopeRepairPlan('src/foo.ts', ['src/foo.ts', 'package.json', 'packages/a/package-lock.json'], [])).toEqual([
      'package.json',
      'packages/a/package-lock.json',
    ]);
  });

  it('dedupes a manifest present in both tracked and untracked lists', () => {
    expect(scopeRepairPlan('src/foo.ts', ['src/foo.ts', 'package.json'], ['package.json'])).toBeNull();
  });
});

describe('repairMakerScope', () => {
  it('returns null when the lease is not a maker lease', () => {
    const db = makeDb();
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => '';
    expect(repairMakerScope(db, run('g1'), lease({ role: 'checker' }), git, fixed)).toBeNull();
    db.close();
  });

  it('returns null when the lease has no worktree_path', () => {
    const db = makeDb();
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => '';
    expect(repairMakerScope(db, run('g1'), lease({ worktree_path: null }), git, fixed)).toBeNull();
    db.close();
  });

  it('returns null for the tg-001 loop', () => {
    const db = makeDb();
    seedOracleLane(db, 'g1', 'imp-1', 'test-gap');
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => '';
    expect(repairMakerScope(db, run('g1', 'tg-001'), lease(), git, fixed)).toBeNull();
    db.close();
  });

  it('returns null for the evolution-gym loop', () => {
    const db = makeDb();
    seedOracleLane(db, 'g1', 'imp-1', 'test-gap');
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => '';
    expect(repairMakerScope(db, run('g1', 'evolution-gym'), lease(), git, fixed)).toBeNull();
    db.close();
  });

  it('returns null when the goal is not an oracle-lane goal (aceLane throws/returns null)', () => {
    const db = makeDb();
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => '';
    expect(repairMakerScope(db, run('nope'), lease(), git, fixed)).toBeNull();
    db.close();
  });

  it('restores out-of-scope manifests and reports the repair using auto_approved_scope', () => {
    const db = makeDb();
    seedOracleLane(db, 'g1', 'imp-1', 'test-gap');
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const calls: string[][] = [];
    const git = (_cwd: string, args: string[]): string => {
      calls.push(args);
      if (args[0] === 'diff') return 'src/foo.ts\npackage.json\npackages/a/package-lock.json\n';
      if (args[0] === 'ls-files') return '';
      if (args[0] === 'rev-parse') return 'deadbeef';
      if (args[0] === 'checkout') return '';
      return '';
    };
    const out = repairMakerScope(
      db,
      run('g1'),
      lease({ metadata: { auto_approved_scope: 'src/foo.ts' } }),
      git,
      fixed,
    );
    expect(out).toEqual({
      restored: ['package.json', 'packages/a/package-lock.json'],
      base: 'deadbeef',
      scope: 'src/foo.ts',
      lane: 'test-gap',
      at: fixed.toISOString(),
    });
    expect(calls.some((c) => c[0] === 'checkout' && c[1] === 'deadbeef')).toBe(true);
    db.close();
  });

  it('returns null when the only outside file is not a manifest (scopeRepairPlan yields null)', () => {
    const db = makeDb();
    seedOracleLane(db, 'g1', 'imp-1', 'test-gap');
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (_cwd: string, args: string[]): string => {
      if (args[0] === 'diff') return 'src/foo.ts\nREADME.md\n';
      if (args[0] === 'ls-files') return '';
      if (args[0] === 'rev-parse') return 'deadbeef';
      return '';
    };
    expect(
      repairMakerScope(db, run('g1'), lease({ metadata: { auto_approved_scope: 'src/foo.ts' } }), git, fixed),
    ).toBeNull();
    db.close();
  });

  it('returns null when the scope gate never set a scope (no auto_approved_scope, no finding, no artifact)', () => {
    const db = makeDb();
    seedOracleLane(db, 'g1', 'imp-1', 'test-gap');
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => '';
    expect(repairMakerScope(db, run('g1'), lease(), git, fixed)).toBeNull();
    db.close();
  });

  it('returns null when a git command throws (the tree is left untouched)', () => {
    const db = makeDb();
    seedOracleLane(db, 'g1', 'imp-1', 'test-gap');
    const fixed = new Date('2026-02-03T04:05:06.000Z');
    const git = (): string => {
      throw new Error('git blew up');
    };
    expect(
      repairMakerScope(db, run('g1'), lease({ metadata: { auto_approved_scope: 'src/foo.ts' } }), git, fixed),
    ).toBeNull();
    db.close();
  });
});
