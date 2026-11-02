import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  plTaskKeys,
  recordPlFreezeRefusal,
  lastPlFreezeRefusal,
  PL_ID,
} from '../services/pl-001';

let db: Database.Database;
const NOW = '2026-10-11T12:00:00.000Z';
const LATER = '2026-10-11T13:00:00.000Z';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
});
afterEach(() => { db.close(); });

describe('plTaskKeys', () => {
  it('returns an empty set when no attempts exist', () => {
    expect(plTaskKeys(db).size).toBe(0);
  });

  it('returns the distinct task keys across all pl_attempts', () => {
    db.prepare("INSERT INTO pl_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
      .run('a1', PL_ID, 'k1', 'A', 0, NOW);
    db.prepare("INSERT INTO pl_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
      .run('a2', PL_ID, 'k1', 'B', 1, NOW);
    db.prepare("INSERT INTO pl_attempts (id, experiment_id, task_key, arm, seq, status, retries, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
      .run('a3', PL_ID, 'k2', 'A', 2, NOW);
    const keys = plTaskKeys(db);
    expect(keys.size).toBe(2);
    expect(keys.has('k1')).toBe(true);
    expect(keys.has('k2')).toBe(true);
  });

  it('returns an empty set when the pl_attempts table is missing', () => {
    db.exec('DROP TABLE pl_attempts');
    expect(plTaskKeys(db).size).toBe(0);
  });
});

describe('recordPlFreezeRefusal', () => {
  it('records a refusal that lastPlFreezeRefusal reads back', () => {
    recordPlFreezeRefusal(db, 'not enough applicable tasks', NOW);
    const r = lastPlFreezeRefusal(db);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('not enough applicable tasks');
    expect(r!.at).toBe(NOW);
  });

  it('truncates the reason to 300 characters', () => {
    const long = 'x'.repeat(500);
    recordPlFreezeRefusal(db, long, NOW);
    const r = lastPlFreezeRefusal(db);
    expect(r).not.toBeNull();
    expect(r!.reason.length).toBe(300);
    expect(r!.reason).toBe('x'.repeat(300));
  });

  it('records the subject as the PL-001 experiment id with judgment pl_001_freeze', () => {
    recordPlFreezeRefusal(db, 'reason', NOW);
    const row = db.prepare("SELECT judgment, subject_type, subject_id, mode, decision FROM judgments WHERE judgment = 'pl_001_freeze'").get() as
      { judgment: string; subject_type: string; subject_id: string; mode: string; decision: string };
    expect(row.judgment).toBe('pl_001_freeze');
    expect(row.subject_type).toBe('experiment');
    expect(row.subject_id).toBe(PL_ID);
    expect(row.mode).toBe('on');
    expect(row.decision).toBe('refused');
  });
});

describe('lastPlFreezeRefusal', () => {
  it('returns null when no refusal has been recorded', () => {
    expect(lastPlFreezeRefusal(db)).toBeNull();
  });

  it('returns the most recent refusal (ORDER BY created_at DESC)', () => {
    recordPlFreezeRefusal(db, 'first refusal', NOW);
    recordPlFreezeRefusal(db, 'second refusal', LATER);
    const r = lastPlFreezeRefusal(db);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('second refusal');
    expect(r!.at).toBe(LATER);
  });

  it('returns null when the judgments table is missing', () => {
    recordPlFreezeRefusal(db, 'reason', NOW);
    db.exec('DROP TABLE judgments');
    expect(lastPlFreezeRefusal(db)).toBeNull();
  });
});