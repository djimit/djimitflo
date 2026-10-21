import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  SETTLE_DAYS,
  defaultFalsifierDeps,
  startCommonsFalsifier,
  viewOf,
  type RunRow,
} from '../services/commons-falsifier';

const DAY = 86_400_000;
const sub = { message_id: 'm1', agent: 'agent-a', test_file: 'packages/server/src/__tests__/foo.test.ts' };

function row(over: Partial<RunRow>): RunRow {
  return {
    message_id: sub.message_id,
    agent: sub.agent,
    test_file: sub.test_file,
    kind: 'base',
    sha: 'sha1',
    verdict: 'red',
    reason: '1 failed',
    executed: 1,
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  };
}

describe('viewOf', () => {
  const now = Date.parse('2024-01-10T00:00:00Z');

  it('is new when there are no runs', () => {
    const v = viewOf(sub, [], now);
    expect(v).toMatchObject({ state: 'new', base_attempts: 0, red_at_base: null, base_sha: null });
  });

  it('is rejected when any run was rejected, carrying that reason', () => {
    const v = viewOf(sub, [row({ kind: 'rejected', verdict: 'rejected', reason: 'bad path', executed: 0 })], now);
    expect(v).toMatchObject({ state: 'rejected', reason: 'bad path' });
  });

  it('is unknown when base runs produced no red/green verdict', () => {
    const v = viewOf(sub, [row({ verdict: 'unknown', reason: 'infra: npm ci' })], now);
    expect(v).toMatchObject({ state: 'unknown', reason: 'infra: npm ci', base_attempts: 1 });
  });

  it('is green_at_base when the base run passed', () => {
    const v = viewOf(sub, [row({ verdict: 'green', reason: '1 passed' })], now);
    expect(v).toMatchObject({ state: 'green_at_base', red_at_base: false });
  });

  it('is red_at_base before settle, tracking the last executed sha', () => {
    const v = viewOf(sub, [row({ sha: 'sha1', verdict: 'red' }), row({ kind: 'recheck', sha: 'sha2', verdict: 'red' })], now);
    expect(v).toMatchObject({ state: 'red_at_base', red_at_base: true, base_sha: 'sha1', last_sha: 'sha2', last_red_sha: 'sha2' });
  });

  it('is settled_green when a recheck turns green', () => {
    const v = viewOf(sub, [row({ verdict: 'red' }), row({ kind: 'recheck', sha: 'sha9', verdict: 'green', reason: 'green at sha9' })], now);
    expect(v).toMatchObject({ state: 'settled_green', green_sha: 'sha9' });
  });

  it('is unrelated_green for a recheck green_unrelated verdict', () => {
    const v = viewOf(sub, [row({ verdict: 'red' }), row({ kind: 'recheck', sha: 'sha9', verdict: 'green_unrelated', reason: 'no imported module changed' })], now);
    expect(v).toMatchObject({ state: 'unrelated_green', green_sha: 'sha9' });
  });

  it('is expired past SETTLE_DAYS with no green recheck', () => {
    const baseAt = '2023-12-01T00:00:00Z';
    const v = viewOf(sub, [row({ verdict: 'red', created_at: baseAt })], Date.parse(baseAt) + (SETTLE_DAYS + 1) * DAY);
    expect(v.state).toBe('expired');
  });
});

describe('defaultFalsifierDeps', () => {
  let db: Database.Database;
  let nonGit: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
    nonGit = mkdtempSync(`${tmpdir()}/falsifier-`);
  });
  afterEach(() => db.close());

  it('returns the four FalsifierDeps members', () => {
    const deps = defaultFalsifierDeps(db, { prepareMakerWorktree: () => ({ install_failed: false, shared_failed: false, install_exit: 0, shared_exit: 0 }) });
    expect(typeof deps.mainSha).toBe('function');
    expect(typeof deps.exists).toBe('function');
    expect(typeof deps.changedBetween).toBe('function');
    expect(typeof deps.run).toBe('function');
  });

  it('mainSha returns null when the path is not a git repo', () => {
    const deps = defaultFalsifierDeps(db, { prepareMakerWorktree: () => ({ install_failed: false, shared_failed: false, install_exit: 0, shared_exit: 0 }) });
    expect(deps.mainSha(nonGit)).toBeNull();
  });

  it('exists returns false when git cat-file fails on a non-repo', () => {
    const deps = defaultFalsifierDeps(db, { prepareMakerWorktree: () => ({ install_failed: false, shared_failed: false, install_exit: 0, shared_exit: 0 }) });
    expect(deps.exists(nonGit, 'sha', 'packages/server/src/__tests__/foo.test.ts')).toBe(false);
  });

  it('changedBetween returns null when git diff fails on a non-repo', () => {
    const deps = defaultFalsifierDeps(db, { prepareMakerWorktree: () => ({ install_failed: false, shared_failed: false, install_exit: 0, shared_exit: 0 }) });
    expect(deps.changedBetween(nonGit, 'from', 'to')).toBeNull();
  });
});

describe('startCommonsFalsifier', () => {
  let db: Database.Database;
  const loops = { prepareMakerWorktree: () => ({ install_failed: false, shared_failed: false, install_exit: 0, shared_exit: 0 }) };
  const prev = process.env.COMMONS_FALSIFIER_MODE;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schema);
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
    if (prev === undefined) delete process.env.COMMONS_FALSIFIER_MODE;
    else process.env.COMMONS_FALSIFIER_MODE = prev;
  });

  it('returns null when COMMONS_FALSIFIER_MODE is off (default)', () => {
    delete process.env.COMMONS_FALSIFIER_MODE;
    expect(startCommonsFalsifier(db, loops)).toBeNull();
  });

  it('returns a stop function when COMMONS_FALSIFIER_MODE is shadow', () => {
    process.env.COMMONS_FALSIFIER_MODE = 'shadow';
    const stop = startCommonsFalsifier(db, loops);
    expect(typeof stop).toBe('function');
    expect(() => stop!()).not.toThrow();
  });
});