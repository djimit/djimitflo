import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { frozenHoldout, mergeLadder, rowOutcome } from '../services/training-dataset';
import type { OutcomeLadder } from '../services/training-dataset';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('frozenHoldout', () => {
  it('returns empty keys and files when no holdout tables have rows', () => {
    const h = frozenHoldout(db);
    expect(h.keys).toEqual(new Set());
    expect(h.files).toEqual(new Set());
  });

  it('collects commit SHAs from gym_holdout and task keys from tg_attempts', () => {
    db.prepare('INSERT INTO gym_holdout (commit_sha, created_at) VALUES (?, ?)').run('sha1', '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO tg_attempts (id, experiment_id, task_key, arm, seq, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('a1', 'exp1', 'tgkey1', 'control', 0, 'done', '2024-01-01T00:00:00Z');
    const h = frozenHoldout(db);
    expect(h.keys.has('sha1')).toBe(true);
    expect(h.keys.has('tgkey1')).toBe(true);
    expect(h.files).toEqual(new Set());
  });

  it('collects keys and source/target files from gym_mutant_holdout and gym_write_test_holdout task_json', () => {
    const mutantJson = JSON.stringify({ source: 'src/a.ts', target: 'src/b.ts' });
    const writeJson = JSON.stringify({ source: 'src/c.ts', target: 'src/d.ts' });
    db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run('mut1', mutantJson, '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO gym_write_test_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run('wt1', writeJson, '2024-01-01T00:00:00Z');
    const h = frozenHoldout(db);
    expect(h.keys.has('mut1')).toBe(true);
    expect(h.keys.has('wt1')).toBe(true);
    expect(h.files).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']));
  });

  it('ignores malformed task_json and empty/missing source/target fields', () => {
    db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run('bad1', 'not-json', '2024-01-01T00:00:00Z');
    db.prepare('INSERT INTO gym_mutant_holdout (key, task_json, created_at) VALUES (?, ?, ?)').run('bad2', JSON.stringify({ source: '', target: null }), '2024-01-01T00:00:00Z');
    const h = frozenHoldout(db);
    expect(h.keys.has('bad1')).toBe(true);
    expect(h.keys.has('bad2')).toBe(true);
    expect(h.files).toEqual(new Set());
  });
});

describe('mergeLadder', () => {
  const createdAt = '2024-01-01T00:00:00Z';
  const day = 86_400_000;

  it('returns null merged and survived_14d when there is no PR url', () => {
    expect(mergeLadder(null, null, createdAt, Date.now())).toEqual({ merged: null, survived_14d: null });
    expect(mergeLadder('', null, createdAt, Date.now())).toEqual({ merged: null, survived_14d: null });
    expect(mergeLadder(undefined, undefined, createdAt, Date.now())).toEqual({ merged: null, survived_14d: null });
  });

  it('reports SETTLED_SURVIVED for a merged PR that survived 14d', () => {
    const mergedAt = '2024-01-01T00:00:00Z';
    const settledAt = '2024-01-20T00:00:00Z';
    const now = Date.parse(settledAt) + day;
    const r = mergeLadder('https://github.com/x/y/pull/1', { state: 'merged', merged_at: mergedAt, settled_at: settledAt, survived: true }, createdAt, now);
    expect(r).toEqual({ merged: true, survived_14d: true });
  });

  it('reports SETTLED_REGRESSED for a merged PR that did not survive', () => {
    const mergedAt = '2024-01-01T00:00:00Z';
    const settledAt = '2024-01-20T00:00:00Z';
    const now = Date.parse(settledAt) + day;
    const r = mergeLadder('https://github.com/x/y/pull/1', { state: 'merged', merged_at: mergedAt, settled_at: settledAt, survived: false }, createdAt, now);
    expect(r).toEqual({ merged: true, survived_14d: false });
  });

  it('reports MERGED_SURVIVAL_PENDING when merged but the 14d window has not elapsed', () => {
    const mergedAt = '2024-01-01T00:00:00Z';
    const now = Date.parse(mergedAt) + 5 * day;
    const r = mergeLadder('https://github.com/x/y/pull/1', { state: 'merged', merged_at: mergedAt, checked_at: new Date(now).toISOString() }, createdAt, now);
    expect(r).toEqual({ merged: true, survived_14d: null });
  });

  it('reports OPEN_BLOCKED non-terminal for an open PR', () => {
    const r = mergeLadder('https://github.com/x/y/pull/1', { state: 'open', checked_at: '2024-01-02T00:00:00Z' }, createdAt, Date.parse('2024-01-02T00:00:00Z'));
    expect(r).toEqual({ merged: null, survived_14d: null });
  });

  it('reports OPEN_BLOCKED terminal (merged false) for a closed-unmerged PR with a settled_at', () => {
    const settledAt = '2024-01-10T00:00:00Z';
    const r = mergeLadder('https://github.com/x/y/pull/1', { state: 'closed_unmerged', settled_at: settledAt, checked_at: settledAt }, createdAt, Date.parse(settledAt));
    expect(r).toEqual({ merged: false, survived_14d: null });
  });

  it('falls back to merged true only when outcome.state is merged for a non-anomalous default path', () => {
    const mergedAt = '2024-01-01T00:00:00Z';
    const now = Date.parse(mergedAt) + day;
    const r = mergeLadder('https://github.com/x/y/pull/1', { state: 'merged', merged_at: mergedAt, settled_at: '2024-01-02T00:00:00Z' }, createdAt, now);
    expect(r.merged).toBe(true);
    expect(r.survived_14d).toBe(null);
  });
});

describe('rowOutcome', () => {
  const O = (o: Partial<OutcomeLadder>): OutcomeLadder => ({
    executed_ok: null, prod_gates_pass: null, verified: null, merged: null, survived_14d: null, ...o,
  });

  it('returns unknown when every rung is null', () => {
    expect(rowOutcome(O({}))).toBe('unknown');
  });

  it('returns success when at least one rung is true and none are false', () => {
    expect(rowOutcome(O({ executed_ok: true }))).toBe('success');
    expect(rowOutcome(O({ merged: true, verified: true }))).toBe('success');
  });

  it('returns failure when any rung is false, even with other true rungs', () => {
    expect(rowOutcome(O({ executed_ok: false }))).toBe('failure');
    expect(rowOutcome(O({ executed_ok: true, prod_gates_pass: false, merged: true }))).toBe('failure');
  });

  it('prioritises failure over success (any false wins)', () => {
    expect(rowOutcome(O({ survived_14d: true, verified: false, merged: true }))).toBe('failure');
  });
});