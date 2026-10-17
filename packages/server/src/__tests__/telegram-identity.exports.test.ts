import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { mayActViaTelegram } from '../services/telegram-identity';

let db: Database.Database;

const user = (id: string, role: string, active = 1) =>
  db.prepare("INSERT INTO users (id, email, password_hash, role, is_active) VALUES (?, ?, 'x', ?, ?)").run(id, `${id}@x`, role, active);

const map = (tg: string, userId: string) =>
  db.prepare("INSERT INTO telegram_identities (telegram_user_id, user_id, added_by) VALUES (?, ?, 'operator')").run(tg, userId);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
});

afterEach(() => db.close());

describe('telegram-identity exports — mayActViaTelegram', () => {
  it('returns null for an id not in the allowlist and audits the deny', () => {
    const result = mayActViaTelegram(db, 999, 'resolve', 'read:evidence');
    expect(result).toBeNull();
    const rows = db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all() as { decision: string; reason: string }[];
    expect(rows).toEqual([{ decision: 'no', reason: 'resolve: not in the allowlist' }]);
  });

  it('returns the actor when the role holds the requested permission', () => {
    user('u1', 'admin');
    map('42', 'u1');
    const result = mayActViaTelegram(db, '42', 'act', 'approve:task');
    expect(result).toEqual({ telegramUserId: '42', userId: 'u1', role: 'admin' });
    const rows = db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all() as { decision: string; reason: string }[];
    expect(rows[0]).toEqual({ decision: 'yes', reason: 'act: user u1 (admin)' });
  });

  it('returns null and audits when the role lacks the permission', () => {
    user('v', 'viewer');
    map('7', 'v');
    const result = mayActViaTelegram(db, 7, 'create', 'write:evidence');
    expect(result).toBeNull();
    const rows = db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all() as { decision: string; reason: string }[];
    expect(rows[0]).toEqual({ decision: 'no', reason: 'create: role viewer lacks write:evidence' });
  });

  it('denies an inactive mapped user even if the role would hold the permission', () => {
    user('a', 'approver', 0);
    map('5', 'a');
    const result = mayActViaTelegram(db, '5', 'approve', 'approve:task');
    expect(result).toBeNull();
  });

  it('accepts a numeric telegramUserId by coercing to string', () => {
    user('m', 'maker');
    map('314', 'm');
    const result = mayActViaTelegram(db, 314, 'run', 'execute:task');
    expect(result?.userId).toBe('m');
    expect(result?.role).toBe('maker');
  });

  it('audits with the caller-supplied action label in both allow and deny paths', () => {
    user('x', 'checker');
    map('88', 'x');
    // checker has read:evidence but not execute:task
    mayActViaTelegram(db, '88', 'scan', 'read:evidence');
    mayActViaTelegram(db, '88', 'exec', 'execute:task');
    const rows = db.prepare("SELECT reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all() as { reason: string }[];
    expect(rows[0].reason).toBe('scan: user x (checker)');
    expect(rows[1].reason).toBe('exec: role checker lacks execute:task');
  });
});
