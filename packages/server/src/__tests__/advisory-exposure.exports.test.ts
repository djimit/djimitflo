import { describe, expect, it, vi } from 'vitest';
import { ensureAdvisoryTables, advisoryGoalRefs } from '../services/advisory-exposure';

describe('ensureAdvisoryTables', () => {
  it('executes CREATE TABLE IF NOT EXISTS advisory_osv_cache', () => {
    const exec = vi.fn();
    const db = { exec } as unknown as Parameters<typeof ensureAdvisoryTables>[0];
    ensureAdvisoryTables(db);
    expect(exec).toHaveBeenCalledTimes(1);
    const [sql] = exec.mock.calls[0] as [string];
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS advisory_osv_cache');
    expect(sql).toContain('id TEXT PRIMARY KEY');
    expect(sql).toContain('fetched_at TEXT NOT NULL');
    expect(sql).toContain('status TEXT NOT NULL');
    expect(sql).toContain('affected_json TEXT');
    expect(sql).toContain('records_json TEXT');
    expect(sql).toContain('error TEXT');
  });

  it('is idempotent (safe to call twice)', () => {
    const exec = vi.fn();
    const db = { exec } as unknown as Parameters<typeof ensureAdvisoryTables>[0];
    ensureAdvisoryTables(db);
    ensureAdvisoryTables(db);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('advisoryGoalRefs', () => {
  const makeDb = (refs: string | null) => {
    const get = vi.fn(() => ({ refs }));
    const prepare = vi.fn(() => ({ get }));
    return { db: { prepare } as unknown as Parameters<typeof advisoryGoalRefs>[0], get, prepare };
  };

  it('returns null when goalId is null', () => {
    const { db } = makeDb(null);
    expect(advisoryGoalRefs(db, null)).toBeNull();
  });

  it('returns null when goalId is undefined', () => {
    const { db } = makeDb(null);
    expect(advisoryGoalRefs(db, undefined)).toBeNull();
  });

  it('returns null when goalId is empty string', () => {
    const { db } = makeDb(null);
    expect(advisoryGoalRefs(db, '')).toBeNull();
  });

  it('returns null when the DB query throws', () => {
    const prepare = vi.fn(() => { throw new Error('no table'); });
    const db = { prepare } as unknown as Parameters<typeof advisoryGoalRefs>[0];
    expect(advisoryGoalRefs(db, 'goal-1')).toBeNull();
  });

  it('returns null when refs JSON is not an array', () => {
    const { db } = makeDb(JSON.stringify({ foo: 'bar' }));
    expect(advisoryGoalRefs(db, 'goal-1')).toBeNull();
  });

  it('returns null when no advisory-exposure ref is present', () => {
    const { db } = makeDb(JSON.stringify(['advisory-pkg:left-pad', 'advisory-id:CVE-2024-1234']));
    expect(advisoryGoalRefs(db, 'goal-1')).toBeNull();
  });

  it('extracts pkg, fixed version and ids from a full ref set', () => {
    const refs = [
      'advisory-exposure:left-pad@1.3.0',
      'advisory-pkg:left-pad',
      'advisory-id:CVE-2018-16487',
      'advisory-id:GHSA-hj98-75hp-jg2v',
    ];
    const { db } = makeDb(JSON.stringify(refs));
    const result = advisoryGoalRefs(db, 'goal-1');
    expect(result).toEqual({
      pkg: 'left-pad',
      fixed: '1.3.0',
      ids: ['CVE-2018-16487', 'GHSA-hj98-75hp-jg2v'],
    });
  });

  it('defaults pkg to empty string when no advisory-pkg ref exists', () => {
    const refs = ['advisory-exposure:lodash@4.17.21', 'advisory-id:CVE-2021-23337'];
    const { db } = makeDb(JSON.stringify(refs));
    const result = advisoryGoalRefs(db, 'goal-1');
    expect(result?.pkg).toBe('');
    expect(result?.fixed).toBe('4.17.21');
    expect(result?.ids).toEqual(['CVE-2021-23337']);
  });

  it('returns null when the row is undefined (no matching goal)', () => {
    const get = vi.fn(() => undefined);
    const prepare = vi.fn(() => ({ get }));
    const db = { prepare } as unknown as Parameters<typeof advisoryGoalRefs>[0];
    expect(advisoryGoalRefs(db, 'nonexistent')).toBeNull();
  });
});
