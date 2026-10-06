import express from 'express';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { createAuthMiddleware } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';
import { createApprovalRoutes } from '../routes/approvals';
import { TelegramBotService } from '../services/telegram-bot-service';

// Prod 06-10: Telegram taps on approvals a lane rule had already auto-approved hit 500 'Approval already processed'
// and the bot replied 'Error: INTERNAL_ERROR'.
const db = new Database(':memory:');
const originalSecret = process.env.JWT_SECRET;
let server: Server; let base: string; let approverToken = '';

beforeAll(async () => {
  process.env.JWT_SECRET = 'tg3-approval-test-secret-'.repeat(3);
  db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const authService = new AuthService(db);
  const maker = authService.createUser('maker@tg3.test', 'Tg3-test-only-password-123!', UserRole.MAKER);
  const approver = authService.createUser('approver@tg3.test', 'Tg3-test-only-password-123!', UserRole.APPROVER);
  approverToken = authService.generateToken(approver);
  db.prepare(`INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,owner_user_id,created_by)
    VALUES ('t1','Review','r','awaiting_approval','low','high','local',?,?)`).run(maker.id, maker.id);
  db.prepare(`INSERT INTO approvals (id,task_id,status,risk_level,request_type,request_message,request_data,requested_by,expires_at,approved_by,updated_at)
    VALUES ('done-1','t1','approved','high','high_risk_action','Review','{}',?,?,'autonomy:test-gap-rule-v1','2026-10-06T10:41:38.027Z')`)
    .run(maker.id, new Date(Date.now() + 60_000).toISOString());
  const auth = createAuthMiddleware(authService);
  const service = new ApprovalService(db, { broadcastTaskEventById: () => {} }, new AuditService(db));
  const engine = { handleApprovalDecision: async (id: string, approved: boolean, actor: string) => service.decideApproval(id, approved, actor) } as never;
  const app = express(); app.use(express.json());
  app.use('/approvals', auth.requireAuth, createApprovalRoutes(db, engine, auth)); app.use(errorHandler);
  server = await new Promise((resolve) => { const l = app.listen(0, () => resolve(l)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
});

it('TG-3: approving or denying an already-decided approval returns 409 APPROVAL_ALREADY_PROCESSED, not 500', async () => {
  for (const action of ['approve', 'deny']) {
    const res = await fetch(`${base}/approvals/done-1/${action}`, { method: 'POST', headers: { authorization: `Bearer ${approverToken}`, 'content-type': 'application/json' }, body: '{"reason":"x"}' });
    expect(res.status, action).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code, action).toBe('APPROVAL_ALREADY_PROCESSED');
  }
});

function bot(apiRequest: (...a: unknown[]) => Promise<unknown>) {
  const b = new TelegramBotService(db, { request: apiRequest } as never);
  b.configure({ botToken: 'test-bot-token', allowedUsers: [111] });
  const out: string[] = [];
  vi.spyOn(b, 'sendMessage').mockImplementation(async (_chat: number, text: string) => { out.push(text); });
  return { b, out };
}

it('TG-3: the bot says who already decided instead of INTERNAL_ERROR; other errors keep their code', async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role, is_active, created_at, updated_at) VALUES ('u-111', 'u111@tg3.test', 'x', 'admin', 1, datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO telegram_identities (telegram_user_id, user_id, added_by, created_at) VALUES ('111', 'u-111', 'test', datetime('now'))").run();
  const { b, out } = bot(vi.fn(async (_actor: unknown, route: unknown) => {
    if (String(route).includes('/done-1/')) throw new Error('APPROVAL_ALREADY_PROCESSED');
    throw new Error('APPROVAL_EXPIRED');
  }));
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'ap:done-1', message: { chat: { id: 111 } } })).toBe('already_decided');
  expect(out.at(-1)).toBe('✅ Already approved by autonomy:test-gap-rule-v1 at 2026-10-06T10:41:38Z');
  expect(await b.handleCallback({ id: 'q', from: { id: 111 }, data: 'ap:other', message: { chat: { id: 111 } } })).toBe('error');
  expect(out.at(-1)).toBe('Error: APPROVAL_EXPIRED');
});
