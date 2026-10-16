import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  recordNegativeEvidenceMatches,
  type NeEntry,
} from '../services/negative-evidence-check';

const makeDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE judgments (
    id TEXT PRIMARY KEY,
    judgment TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  return db;
};

const shadowEnv = { NE_GENERATOR_CHECK_MODE: 'shadow' } as NodeJS.ProcessEnv;
const offEnv = {} as NodeJS.ProcessEnv;

const entry: NeEntry = {
  id: 'ne-001',
  verdict: 'falsified',
  reopen_condition: 'new evidence of X',
  forbidden_code_patterns: ['badPattern'],
  match_terms: ['SomeLib'],
};

describe('negative-evidence-check exports — recordNegativeEvidenceMatches', () => {
  it('returns [] immediately when mode is off, without touching the database', () => {
    const db = makeDb();
    const result = recordNegativeEvidenceMatches(
      db,
      { type: 'self_improvement', id: 'si-1' },
      'text with badPattern here',
      'proposal',
      offEnv,
      [entry],
    );
    expect(result).toEqual([]);
    // No rows should have been inserted
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM judgments`).get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('records a judgment and returns matches for an exact_pattern hit in shadow mode', () => {
    const db = makeDb();
    const result = recordNegativeEvidenceMatches(
      db,
      { type: 'self_improvement', id: 'si-2' },
      'this contains badPattern inside',
      'dream_mutant',
      shadowEnv,
      [entry],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ entry_id: 'ne-001', matched: 'badPattern', confidence: 'exact_pattern' });

    const row = db.prepare(`SELECT * FROM judgments WHERE subject_id = ?`).get('si-2') as Record<string, unknown>;
    expect(row.judgment).toBe('negative_evidence_match');
    expect(row.mode).toBe('shadow');
    expect(row.decision).toBe('match');
    expect(row.subject_type).toBe('self_improvement');
  });

  it('records a keyword-confidence match when only match_terms hit', () => {
    const db = makeDb();
    const kwEntry: NeEntry = { ...entry, forbidden_code_patterns: undefined };
    const result = recordNegativeEvidenceMatches(
      db,
      { type: 'discovery_unit', id: 'du-1' },
      'we should use SomeLib for this',
      'discovery_unit',
      shadowEnv,
      [kwEntry],
    );
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe('keyword');

    const row = db.prepare(`SELECT reason FROM judgments WHERE subject_id = ?`).get('du-1') as { reason: string };
    expect(row.reason).toContain('keyword');
  });

  it('inserts one judgment per unique entry even when multiple patterns match the same entry', () => {
    const multiEntry: NeEntry = {
      id: 'ne-multi',
      verdict: 'falsified',
      reopen_condition: 're-evaluate',
      forbidden_code_patterns: ['AAA', 'BBB'],
      match_terms: [],
    };
    const db = makeDb();
    const result = recordNegativeEvidenceMatches(
      db,
      { type: 'self_improvement', id: 'si-3' },
      'has AAA and BBB both',
      'proposal',
      shadowEnv,
      [multiEntry],
    );
    // Two matches returned (one per pattern)
    expect(result).toHaveLength(2);
    // But only ONE judgment row for this entry
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM judgments WHERE subject_id = ?`).get('si-3') as { n: number }).n;
    expect(count).toBe(1);
  });

  it('returns [] on database error (fail-open)', () => {
    const db = makeDb();
    // Drop the table to force an insert failure
    db.exec(`DROP TABLE judgments`);
    const result = recordNegativeEvidenceMatches(
      db,
      { type: 'self_improvement', id: 'si-4' },
      'badPattern here',
      'proposal',
      shadowEnv,
      [entry],
    );
    expect(result).toEqual([]);
  });

  it('respects a null entries override (no registry read, no matches)', () => {
    const db = makeDb();
    const result = recordNegativeEvidenceMatches(
      db,
      { type: 'self_improvement', id: 'si-5' },
      'badPattern SomeLib',
      'proposal',
      shadowEnv,
      null,
    );
    expect(result).toEqual([]);
  });
});
