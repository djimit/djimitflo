import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createSelfImprovementRoutes } from '../routes/self-improvement';
import { createGovernanceRoutes } from '../routes/swarm-governance';
import { TelegramApiService } from '../services/telegram-api-service';
import { TelegramBotService } from '../services/telegram-bot-service';
import { MemoryCandidateService } from '../services/memory-candidate-service';
import { decisionsInbox } from '../services/decisions-inbox';
import { CALLBACK_DATA_MAX_BYTES, pushApproval, pushTriage, setPushSender, triageMessages } from '../services/operator-push';

// Operator triage in one place: D5 labels and memory review get the same one-tap Telegram buttons as approvals,
// authorised like approvals (D3 identity + the web route's permission), executed through the same API route as /decisions.
const db = new Database(':memory:');
const saved = { JWT_SECRET: process.env.JWT_SECRET, OKF_BASE: process.env.OKF_BASE };
let server: Server; let adminId = ''; let approverId = ''; let adminToken = ''; let approverToken = ''; let base = '';
let memA = ''; let memB = '';
const TRIAGE_ON = { TELEGRAM_PUSH_ENABLED: 'true', TELEGRAM_TRIAGE_ENABLED: 'true' };

beforeAll(async () => {
  process.env.JWT_SECRET = 'telegram-triage-test-secret-'.repeat(3);
  process.env.OKF_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-triage-okf-'));
  db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  const authService = new AuthService(db);
  const admin = authService.createUser('admin@triage.test', 'Triage-test-only-password-123!', UserRole.ADMIN);
  const approver = authService.createUser('approver@triage.test', 'Triage-test-only-password-123!', UserRole.APPROVER);
  adminId = admin.id; approverId = approver.id; adminToken = authService.generateToken(admin); approverToken = authService.generateToken(approver);
  for (const [tg, user] of [['111', adminId], ['222', approverId]]) {
    db.prepare("INSERT INTO telegram_identities (telegram_user_id, user_id, added_by, created_at) VALUES (?, ?, 'test', datetime('now'))").run(tg, user);
  }
  const ins = db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at)
    VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, datetime('now'), datetime('now'))`);
  ins.run('11111111-aaaa-4bbb-8ccc-000000000001', 'Vague refactor idea', 'needs_more_evidence');
  ins.run('11111111-aaaa-4bbb-8ccc-000000000002', 'Regressed change', 'regressed');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('j1', 'proposal_prescreen', 'self_improvement', '11111111-aaaa-4bbb-8ccc-000000000001', 'h', 'shadow', 'no', 'names no concrete file', datetime('now'))`).run();
  const mem = new MemoryCandidateService(db);
  memA = mem.create({ title: 'guard-json-parse', content: 'Never JSON.parse model output without a guard', memory_type: 'engineering_rule' }).id;
  memB = mem.create({ title: 'prefer-small-diffs', content: 'Keep maker diffs under 200 lines', memory_type: 'engineering_rule' }).id;

  const auth = createAuthMiddleware(authService);
  const app = express(); app.use(express.json()); app.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  app.use('/api/self-improve', auth.requireAuth, createSelfImprovementRoutes(db, auth));
  app.use('/api/swarms', auth.requireAuth, createGovernanceRoutes(db, auth));
  app.use(errorHandler);
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
afterEach(() => { vi.unstubAllEnvs(); setPushSender(null); });

function bot() {
  const b = new TelegramBotService(db, new TelegramApiService(new AuthService(db), base));
  b.configure({ botToken: 'test-bot-token', allowedUsers: [111, 222, 333] });
  const out: string[] = [];
  vi.spyOn(b, 'sendMessage').mockImplementation(async (_chat: number, text: string) => { out.push(text); });
  return { b, out };
}
const tap = (b: TelegramBotService, from: number, data: string) => b.handleCallback({ id: 'q', from: { id: from }, data, message: { chat: { id: from } } });
const P1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const labels = () => db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'operator_label' ORDER BY rowid").all() as Array<{ decision: string; reason: string }>;
const access = (tg: string) => db.prepare("SELECT decision, reason FROM judgments WHERE judgment = 'telegram_access' AND subject_id = ? ORDER BY rowid").all(tg) as Array<{ decision: string; reason: string }>;

it('an unknown Telegram user, and a mapped user whose role lacks the route permission, are refused and audited', async () => {
  for (const [k, v] of Object.entries(TRIAGE_ON)) vi.stubEnv(k, v);
  const { b, out } = bot();
  expect(await tap(b, 333, `pl:${P1}:w`)).toBe('refused');
  expect(access('333')).toEqual([{ decision: 'no', reason: 'label: not in the allowlist' }]);
  // the approver may promote memory (approve:task) but not label (write:governance), exactly like the web routes
  expect(await tap(b, 222, `pl:${P1}:w`)).toBe('refused');
  expect(access('222').at(-1)).toEqual({ decision: 'no', reason: 'label: role approver lacks write:governance' });
  expect(out.at(-1)).toContain('Not allowed');
  expect(labels()).toEqual([]);
});

it('payloads are validated: only kind + id, ≤ 64 bytes, and the id must exist', async () => {
  for (const [k, v] of Object.entries(TRIAGE_ON)) vi.stubEnv(k, v);
  const { b } = bot();
  for (const data of [`pl:${P1}`, 'pl:../../x:o', `mp:${memA}:o`, `pl:${P1}:x`, `pl:${'a'.repeat(60)}:o`, `mr:${memA};drop`]) expect(await tap(b, 111, data), data).toBe('invalid');
  expect(await tap(b, 111, 'pl:00000000-0000-4000-8000-000000000000:o')).toBe('not_found');
  expect(await tap(b, 111, 'mp:00000000-0000-4000-8000-000000000000')).toBe('not_found');
  expect(labels()).toEqual([]);
});

it('taps are refused while TELEGRAM_TRIAGE_ENABLED is off', async () => {
  vi.stubEnv('TELEGRAM_PUSH_ENABLED', 'true');
  const { b } = bot();
  expect(await tap(b, 111, `pl:${P1}:w`)).toBe('disabled');
  expect(labels()).toEqual([]);
});

it('a mapped admin labels through the /decisions route: the same operator_label judgment, recorded as that user', async () => {
  for (const [k, v] of Object.entries(TRIAGE_ON)) vi.stubEnv(k, v);
  const { b, out } = bot();
  expect(await tap(b, 111, `pl:${P1}:w`)).toBe('labelled');
  expect(out.at(-1)).toBe('🏷 Labelled wrong rejection: Vague refactor idea');
  expect(labels()).toEqual([{ decision: 'no', reason: `proposal_prescreen rejection labelled 'wrong' by ${adminId}` }]);
  expect(decisionsInbox(db).prescreen.items.find((i) => i.id === P1)?.label).toBe('wrong');
});

it('memory promote records the D3-mapped user as the human approver; reject works; a decided candidate is not re-run', async () => {
  for (const [k, v] of Object.entries(TRIAGE_ON)) vi.stubEnv(k, v);
  const { b, out } = bot();
  expect(await tap(b, 222, `mp:${memA}`)).toBe('promoted');
  const row = db.prepare('SELECT status, metadata FROM memory_candidates WHERE id = ?').get(memA) as { status: string; metadata: string };
  expect(row.status).toBe('promoted');
  expect(JSON.parse(row.metadata).promoted_by).toBe(approverId);
  expect(await tap(b, 222, `mp:${memA}`)).toBe('already_decided');
  expect(out.at(-1)).toBe('Already promoted: guard-json-parse');
  expect(await tap(b, 111, `mr:${memB}`)).toBe('rejected');
  expect((db.prepare('SELECT status FROM memory_candidates WHERE id = ?').get(memB) as { status: string }).status).toBe('rejected');
});

it('D2 dismiss: write:governance only, 404 for a non-candidate, audited, and the row leaves the requeue list', async () => {
  const post = (id: string, token: string, body: unknown = {}) => fetch(`${base}/self-improve/proposals/${id}/requeue-dismiss`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const R = '11111111-aaaa-4bbb-8ccc-000000000002';
  expect(decisionsInbox(db).requeue.map((r) => r.id)).toContain(R);
  expect((await post(R, approverToken)).status).toBe(403);
  expect((await post(P1, adminToken)).status).toBe(404);
  expect((await post(R, adminToken, { reason: 'flaky infra, superseded by #700' })).status).toBe(204);
  expect(decisionsInbox(db).requeue.map((r) => r.id)).not.toContain(R);
  expect(db.prepare("SELECT reason FROM judgments WHERE judgment = 'requeue_dismiss' AND subject_id = ?").get(R))
    .toEqual({ reason: `requeue candidate (regressed) dismissed by ${adminId}: flaky infra, superseded by #700` });
});

// ─── push side ───────────────────────────────────────────────────────────────

const pushDb = () => { const d = new Database(':memory:'); d.exec(schema); runMigrations(d); d.pragma('foreign_keys = OFF'); return d; };
const NOON = new Date('2026-10-07T12:00:00Z');

it('triage push: off by default and without the sub-flag; then one message per item, capped per push, each once', async () => {
  const d = pushDb();
  const ins = d.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at)
    VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', 'needs_more_evidence', datetime('now'), datetime('now'))`);
  const pj = d.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', 'shadow', 'no', 'leaks ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ?)`);
  for (const i of [1, 2]) { ins.run(`p${i}`, `Proposal ${i}`); pj.run(`j${i}`, `p${i}`, `2026-10-07T0${i}:00:00Z`); }
  const mid = new MemoryCandidateService(d).create({ title: 'rule', content: 'Keep diffs small', memory_type: 'engineering_rule' }).id;
  const sent: Array<{ text: string; buttons: Array<{ text: string; data: string }>; url?: string | null }> = [];
  setPushSender({ requestApproval: vi.fn(async () => {}), broadcastAlert: vi.fn(async () => {}), requestTriage: vi.fn(async (text, buttons, url) => { sent.push({ text, buttons, url }); }) });
  expect((await pushTriage(d, {}, NOON)).result).toBe('disabled');
  expect((await pushTriage(d, { TELEGRAM_PUSH_ENABLED: 'true' }, NOON)).result).toBe('disabled');
  const env = { ...TRIAGE_ON, TELEGRAM_TRIAGE_MAX_PER_PUSH: '2', TELEGRAM_PUSH_MAX_PER_HOUR: '10', TELEGRAM_QUIET_HOURS: '22-7', DJIMITFLO_PUBLIC_URL: 'https://djimitflo.example/' };
  expect((await pushTriage(d, env, new Date('2026-10-07T23:00:00Z'))).result).toBe('quiet');
  expect(await pushTriage(d, env, NOON)).toEqual({ result: 'sent', sent: 2 });
  expect(await pushTriage(d, env, NOON)).toEqual({ result: 'sent', sent: 1 });
  expect((await pushTriage(d, env, NOON)).result).toBe('nothing');
  expect(sent.map((s) => s.buttons.map((b) => b.data))).toEqual([['pl:p2:o', 'pl:p2:w'], ['pl:p1:o', 'pl:p1:w'], [`mp:${mid}`, `mr:${mid}`]]);
  expect(sent[0].buttons.map((b) => b.text)).toEqual(['Correct rejection', 'Wrong rejection']);
  expect(sent[0].url).toBe('https://djimitflo.example/decisions#prescreen');
  expect(sent[2].url).toBe('https://djimitflo.example/decisions#memory');
  expect(sent[0].text).toContain('Proposal: Proposal 2');
  expect(sent[0].text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ'); // the reason leaves to Telegram redacted
  d.close();
});

it('triage shares the hourly cap mechanism but never crowds out an approval push', async () => {
  const d = pushDb();
  const ins = d.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, created_at, updated_at)
    VALUES (?, 'test', 't', 'd', 'r', 'gap_analysis', 'needs_more_evidence', datetime('now'), datetime('now'))`);
  const pj = d.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', 'shadow', 'no', 'r', datetime('now'))`);
  for (const i of [1, 2, 3]) { ins.run(`p${i}`); pj.run(`j${i}`, `p${i}`); }
  setPushSender({ requestApproval: vi.fn(async () => {}), broadcastAlert: vi.fn(async () => {}), requestTriage: vi.fn(async () => {}) });
  const env = { ...TRIAGE_ON, TELEGRAM_TRIAGE_MAX_PER_PUSH: '5', TELEGRAM_PUSH_MAX_PER_HOUR: '2' };
  expect(await pushTriage(d, env, NOON)).toEqual({ result: 'sent', sent: 2 });
  expect((await pushTriage(d, env, NOON)).result).toBe('capped');
  expect(await pushApproval(d, { id: 'a1', title: 'x' }, env, NOON)).toBe('sent');
  d.close();
});

it('callback data of every triage button fits Telegram\'s 64-byte limit; a longer id is left to the dashboard', () => {
  const inbox = { requeue: [], telegram: [], autonomy: [], memory: [{ id: 'm'.repeat(70), title: 't', content: 'c', memory_type: 'engineering_rule', status: 'candidate', created_at: '' }],
    prescreen: { items: [{ id: '11111111-aaaa-4bbb-8ccc-000000000001', title: 't', status: 's', reason: 'r', verdict_at: '', label: null }], labelled: 0, wrong: 0, false_rejection_pct: null, enforce_threshold: '' } };
  const msgs = triageMessages(inbox);
  expect(msgs.map((m) => m.key)).toEqual(['triage:label:11111111-aaaa-4bbb-8ccc-000000000001']);
  for (const b of msgs.flatMap((m) => m.buttons)) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
});
