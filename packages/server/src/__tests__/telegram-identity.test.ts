import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { mayApproveViaTelegram, resolveTelegramActor } from '../services/telegram-identity';

let db: Database.Database;
const user = (id: string, role: string, active = 1) =>
  db.prepare("INSERT INTO users (id, email, password_hash, role, is_active) VALUES (?, ?, 'x', ?, ?)").run(id, `${id}@x`, role, active);
const map = (tg: string, userId: string) => db.prepare("INSERT INTO telegram_identities (telegram_user_id, user_id, added_by) VALUES (?, ?, 'operator')").run(tg, userId);
const audits = () => db.prepare("SELECT subject_id, decision, reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").all();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

it('ships with an empty allowlist: every id is denied and audited', () => {
  expect((db.prepare('SELECT COUNT(*) n FROM telegram_identities').get() as { n: number }).n).toBe(0);
  expect(resolveTelegramActor(db, 123456)).toBeNull();
  expect(audits()).toEqual([{ subject_id: '123456', decision: 'no', reason: 'resolve: not in the allowlist' }]);
});

it('resolves an allowlisted id to its user and role; inactive or invalid ids are denied', () => {
  user('u1', 'viewer'); user('u2', 'approver', 0); map('111', 'u1'); map('222', 'u2');
  expect(resolveTelegramActor(db, '111')).toEqual({ telegramUserId: '111', userId: 'u1', role: 'viewer' });
  expect(resolveTelegramActor(db, '222')).toBeNull();
  expect(resolveTelegramActor(db, 'abc')).toBeNull();
  expect(audits().map((a) => (a as { reason: string }).reason)).toEqual(['resolve: mapped user u2 missing or inactive', 'resolve: invalid telegram user id']);
});

it('approval via Telegram needs the web approve:task permission', () => {
  user('v', 'viewer'); user('a', 'approver'); map('1', 'v'); map('2', 'a');
  expect(mayApproveViaTelegram(db, 1)).toBeNull();
  expect(mayApproveViaTelegram(db, 2)?.userId).toBe('a');
  expect(audits()).toEqual([
    { subject_id: '1', decision: 'no', reason: 'approve: role viewer lacks approve:task' },
    { subject_id: '2', decision: 'yes', reason: 'approve: user a (approver)' },
  ]);
});

it('trims surrounding whitespace from the telegram user id before validating it', () => {
  user('u', 'viewer'); map('777', 'u');
  expect(resolveTelegramActor(db, '  777 ')).toEqual({ telegramUserId: '777', userId: 'u', role: 'viewer' });
  expect(resolveTelegramActor(db, '  abc  ')).toBeNull();
  expect(audits().map((a) => (a as { reason: string }).reason)).toContain('resolve: invalid telegram user id');
});

it('rejects ids longer than 20 digits and accepts the 20-digit boundary', () => {
  user('u', 'viewer'); map('12345678901234567890', 'u');
  expect(resolveTelegramActor(db, '12345678901234567890')?.userId).toBe('u');
  expect(resolveTelegramActor(db, '123456789012345678901')).toBeNull();
  expect(audits().map((a) => (a as { reason: string }).reason)).toEqual(['resolve: invalid telegram user id']);
});

it('treats null/undefined telegram user ids as missing and audits them under (missing)', () => {
  expect(resolveTelegramActor(db, null as unknown as undefined)).toBeNull();
  expect(resolveTelegramActor(db, undefined as unknown as undefined)).toBeNull();
  expect(audits().map((a) => (a as { subject_id: string }).subject_id)).toEqual(['(missing)', '(missing)']);
});

it('uses the supplied action label (truncated to 16 chars) in the audit state_hash', () => {
  expect(resolveTelegramActor(db, 5, 'a-very-long-action-label')).toBeNull();
  const row = db.prepare("SELECT subject_id, state_hash, reason FROM judgments WHERE judgment = 'telegram_access' ORDER BY rowid").get() as { subject_id: string; state_hash: string; reason: string };
  expect(row.subject_id).toBe('5');
  expect(row.state_hash).toBe('a-very-long-acti');
  expect(row.reason).toBe('a-very-long-action-label: not in the allowlist');
});

it('denies a mapped id whose user row is missing from the users table', () => {
  map('9', 'ghost');
  expect(resolveTelegramActor(db, 9)).toBeNull();
  expect(audits().map((a) => (a as { reason: string }).reason)).toEqual(['resolve: mapped user ghost missing or inactive']);
});

it('does not crash when auditing fails: a deny stays a deny even if the judgment write throws', () => {
  db.exec("DROP TABLE judgments");
  expect(resolveTelegramActor(db, 5)).toBeNull();
  expect(mayApproveViaTelegram(db, 5)).toBeNull();
});
