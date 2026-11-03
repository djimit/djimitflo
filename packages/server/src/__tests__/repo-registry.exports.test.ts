import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  repoRefOf,
  goalRepoSlug,
  repoSkillPrefix,
  type ExtraRepo,
} from '../services/repo-registry';

const makeDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE self_improvements (
    id TEXT PRIMARY KEY,
    evidence_refs_json TEXT
  )`);
  db.exec(`CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    improvement_id TEXT
  )`);
  return db;
};

const seedGoal = (db: Database.Database, goalId: string, improvementId: string, refs: string | null) => {
  db.prepare(`INSERT INTO self_improvements (id, evidence_refs_json) VALUES (?, ?)`).run(improvementId, refs);
  db.prepare(`INSERT INTO goals (id, improvement_id) VALUES (?, ?)`).run(goalId, improvementId);
};

describe('repo-registry exports — repoRefOf', () => {
  it('extracts the repo slug from an array of refs', () => {
    expect(repoRefOf(['repo:owner/repo', 'other:thing'])).toBe('owner/repo');
  });

  it('extracts the repo slug from a JSON string of refs', () => {
    expect(repoRefOf(JSON.stringify(['repo:foo/bar']))).toBe('foo/bar');
  });

  it('returns null when no repo: ref is present', () => {
    expect(repoRefOf(['other:thing', 'plain'])).toBe(null);
  });

  it('returns null for a malformed repo: ref (bad slug)', () => {
    expect(repoRefOf(['repo:not-a-slug'])).toBe(null);
  });

  it('returns null for an invalid JSON string', () => {
    expect(repoRefOf('{not json')).toBe(null);
  });

  it('returns null for non-array input', () => {
    expect(repoRefOf({ a: 1 })).toBe(null);
    expect(repoRefOf(null)).toBe(null);
    expect(repoRefOf(undefined)).toBe(null);
    expect(repoRefOf(42)).toBe(null);
    expect(repoRefOf('plain string')).toBe(null);
  });

  it('ignores non-string entries in the array', () => {
    expect(repoRefOf([123, { x: 1 }, 'repo:baz/qux'])).toBe('baz/qux');
  });
});

describe('repo-registry exports — goalRepoSlug', () => {
  it('returns the repo slug for a goal whose improvement carries a repo: ref', () => {
    const db = makeDb();
    seedGoal(db, 'g-1', 'si-1', JSON.stringify(['repo:owner/repo']));
    expect(goalRepoSlug(db, 'g-1')).toBe('owner/repo');
  });

  it('returns null when the improvement has no repo: ref', () => {
    const db = makeDb();
    seedGoal(db, 'g-2', 'si-2', JSON.stringify(['other:thing']));
    expect(goalRepoSlug(db, 'g-2')).toBe(null);
  });

  it('returns null when the improvement refs column is null', () => {
    const db = makeDb();
    seedGoal(db, 'g-3', 'si-3', null);
    expect(goalRepoSlug(db, 'g-3')).toBe(null);
  });

  it('returns null for a null or undefined goal id', () => {
    const db = makeDb();
    expect(goalRepoSlug(db, null)).toBe(null);
    expect(goalRepoSlug(db, undefined)).toBe(null);
  });

  it('returns null when the goal row does not exist', () => {
    const db = makeDb();
    expect(goalRepoSlug(db, 'missing')).toBe(null);
  });

  it('returns null on database error (fail-open)', () => {
    const db = makeDb();
    db.exec(`DROP TABLE goals`);
    expect(goalRepoSlug(db, 'g-x')).toBe(null);
  });
});

describe('repo-registry exports — repoSkillPrefix', () => {
  it('returns "repo:<slug>:" for an extra repo', () => {
    const repo: ExtraRepo = { slug: 'owner/repo', path: '/abs/path' };
    expect(repoSkillPrefix(repo)).toBe('repo:owner/repo:');
  });

  it('returns empty string for null repo (primary)', () => {
    expect(repoSkillPrefix(null)).toBe('');
  });
});