import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { approvalMessage, buildDigest, inQuietHours, maybeSendDigest, pushApproval, setPushSender } from '../services/operator-push';
import { TelegramBotService } from '../services/telegram-bot-service';
import { SECRET_PATTERNS } from '../services/secret-patterns';

let db: Database.Database;
const sent: Array<{ id: string; text: string; url?: string | null }> = [];
const alerts: string[] = [];
const sender = { requestApproval: vi.fn(async (id: string, text: string, url?: string | null) => { sent.push({ id, text, url }); }), broadcastAlert: vi.fn(async (t: string) => { alerts.push(t); }) };
const NOON = new Date('2026-10-06T12:00:00Z');
const approval = (id: string) => ({ id, title: 'Add unit tests for services/x.ts', risk_level: 'low', action_type: 'loop_maker', target_path: 'packages/server/src/__tests__/x.test.ts',
  expires_at: '2026-10-06T14:00:00Z', metadata: { loop_name: 'test-gap', note: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } });
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON'); sent.length = 0; alerts.length = 0; setPushSender(sender); });
afterEach(() => { setPushSender(null); db.close(); vi.unstubAllEnvs(); });

it('UX-12: defaults send nothing', async () => {
  expect(await pushApproval(db, approval('a1'), {}, NOON)).toBe('disabled');
  expect(await maybeSendDigest(db, {}, new Date('2026-10-06T07:05:00Z'))).toBe(false);
  expect(sent).toHaveLength(0); expect(alerts).toHaveLength(0);
});

it('UX-12: with the flag on, one message per approval, none on duplicates, the hourly cap and quiet hours hold', async () => {
  const env = { TELEGRAM_PUSH_ENABLED: 'true', TELEGRAM_PUSH_MAX_PER_HOUR: '2', TELEGRAM_QUIET_HOURS: '22-7', DJIMITFLO_PUBLIC_URL: 'https://djimitflo.example' };
  expect(await pushApproval(db, approval('a1'), env, NOON)).toBe('sent');
  expect(await pushApproval(db, approval('a1'), env, NOON)).toBe('duplicate');
  expect(await pushApproval(db, approval('a2'), env, NOON)).toBe('sent');
  expect(await pushApproval(db, approval('a3'), env, NOON)).toBe('capped');
  expect(await pushApproval(db, approval('a4'), env, new Date('2026-10-06T23:30:00Z'))).toBe('quiet');
  expect(sent.map((s) => s.id)).toEqual(['a1', 'a2']);
  expect(sent[0].url).toBe('https://djimitflo.example/decisions#approvals');
  expect(inQuietHours('22-7', new Date('2026-10-06T06:59:00Z'))).toBe(true);
  expect(inQuietHours('22-7', new Date('2026-10-06T07:00:00Z'))).toBe(false);
  expect(inQuietHours('', NOON)).toBe(false);
});

it('UX-12: the message carries lane, scope, risk and id, and no secret pattern', () => {
  const text = approvalMessage(approval('a1'));
  expect(text).toContain('Lane: test-gap'); expect(text).toContain('Scope: packages/server/src/__tests__/x.test.ts'); expect(text).toContain('Id: a1');
  for (const { pattern } of SECRET_PATTERNS) { pattern.lastIndex = 0; expect(pattern.test(text)).toBe(false); }
  expect(approvalMessage({ ...approval('a1'), title: 'leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
});

function bot(apiRequest = vi.fn(async () => ({}))) {
  const b = new TelegramBotService(db, { request: apiRequest } as never);
  b.configure({ botToken: 'test-bot-token', allowedUsers: [111, 222] });
  const out: string[] = [];
  vi.spyOn(b, 'sendMessage').mockImplementation(async (_chat: number, text: string) => { out.push(text); });
  return { b, out, apiRequest };
}
const mapUser = (telegramId: string, role: string) => {
  const id = `u-${telegramId}`;
  db.prepare("INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, datetime('now'), datetime('now'))").run(id, `${id}@example.test`, role);
  db.prepare("INSERT INTO telegram_identities (telegram_user_id, user_id, added_by, created_at) VALUES (?, ?, 'test-admin', datetime('now'))").run(telegramId, id);
  return id;
};

it('UX-12: a callback from an unmapped user, or a mapped user without approve:task, is refused and never calls the API', async () => {
  const { b, out, apiRequest } = bot();
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'ap:a1', message: { chat: { id: 111 } } })).toBe('refused');
  mapUser('222', 'viewer');
  expect(await b.handleCallback({ id: 'q', from: { id: 222 }, data: 'ap:a1', message: { chat: { id: 222 } } })).toBe('refused');
  expect(apiRequest).not.toHaveBeenCalled();
  expect(out[0]).toContain('Not allowed');
});

it('UX-12: a mapped approver approves through the API as themselves; deny asks a fixed reason first; self-approval is refused', async () => {
  const apiRequest = vi.fn(async (_actor: string, route: string) => { if (route.includes('/a-own/')) throw new Error('SELF_APPROVAL_FORBIDDEN'); return {}; });
  const { b, out } = bot(apiRequest as never);
  const user = mapUser('111', 'admin');
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'ap:a1', message: { chat: { id: 111 } } })).toBe('approved');
  expect(apiRequest).toHaveBeenCalledWith(user, '/approvals/a1/approve', 'POST');
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'dn:a1', message: { chat: { id: 111 } } })).toBe('reason_asked');
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'rs:a1:r', message: { chat: { id: 111 } } })).toBe('denied');
  expect(apiRequest).toHaveBeenCalledWith(user, '/approvals/a1/deny', 'POST', { reason: 'Too risky' });
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'ap:a-own', message: { chat: { id: 111 } } })).toBe('self_approval');
  expect(out.at(-1)).toContain('cannot approve your own');
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'ap:../../x', message: { chat: { id: 111 } } })).toBe('invalid');
});

it('UX-13: the digest reports a seeded day and says so honestly on an empty one; sent once per day at the hour', async () => {
  const empty = buildDigest(db, NOON.getTime(), {});
  expect(empty.text).toContain('0 verified, 0 regressed'); expect(empty.text).toContain('Stalls: none');
  const ins = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at) VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', ?, ?, ?)`);
  ins.run('v1', 'verified', '2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z'); ins.run('r1', 'regressed', '2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z');
  const d = buildDigest(db, NOON.getTime(), {});
  expect(d.data).toMatchObject({ verified_24h: 1, regressed_24h: 1, new_proposals_24h: 2 });
  expect(d.text).toContain('Realm gates:');
  const env = { OPERATOR_DIGEST_ENABLED: 'true', OPERATOR_DIGEST_HOUR: '7' };
  expect(await maybeSendDigest(db, env, new Date('2026-10-06T06:30:00Z'))).toBe(false);
  expect(await maybeSendDigest(db, env, new Date('2026-10-06T07:10:00Z'))).toBe(true);
  expect(await maybeSendDigest(db, env, new Date('2026-10-06T07:40:00Z'))).toBe(false);
  expect(alerts).toHaveLength(1);
});
