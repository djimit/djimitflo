import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { setPushSender, startOperatorDigest } from '../services/operator-push';

let db: Database.Database;
const alerts: string[] = [];
const sender = {
  requestApproval: vi.fn(async () => {}),
  broadcastAlert: vi.fn(async (t: string) => { alerts.push(t); }),
  requestTriage: vi.fn(async () => {}),
};

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(schema);
  runMigrations(db);
  db.pragma('foreign_keys = ON');
  alerts.length = 0;
  setPushSender(sender);
});

afterEach(() => {
  setPushSender(null);
  db.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('startOperatorDigest: no-op when neither digest nor triage is enabled', () => {
  vi.stubEnv('OPERATOR_DIGEST_ENABLED', 'false');
  vi.stubEnv('TELEGRAM_PUSH_ENABLED', 'false');
  vi.useFakeTimers();
  startOperatorDigest(db);
  vi.advanceTimersByTime(30 * 60_000);
  expect(alerts).toHaveLength(0);
});

it('startOperatorDigest: arms a 15-min tick that sends the daily digest and is idempotent', () => {
  vi.stubEnv('OPERATOR_DIGEST_ENABLED', 'true');
  vi.stubEnv('OPERATOR_DIGEST_HOUR', '12');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));

  const spy = vi.spyOn(globalThis, 'setInterval');
  startOperatorDigest(db);
  expect(spy).toHaveBeenCalledTimes(1);
  startOperatorDigest(db);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();

  vi.advanceTimersByTime(15 * 60_000);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('Djimitflo daily digest');
  expect(db.prepare("SELECT 1 FROM judgments WHERE judgment = 'needs_you_ranking'").get()).toBeTruthy();
});