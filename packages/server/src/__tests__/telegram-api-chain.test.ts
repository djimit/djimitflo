import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { createTaskRoutes } from '../routes/tasks';
import { createApprovalRoutes } from '../routes/approvals';
import { createTelegramRoutes } from '../routes/telegram';
import { TelegramApiService } from '../services/telegram-api-service';
import { ExecutionEngine } from '../execution/execution-engine';
import { errorHandler } from '../middleware/error-handler';
import { TelegramBotService } from '../services/telegram-bot-service';
import { createRoutes } from '../routes';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('runs Telegram webhook -> authenticated local API -> owned task/audit -> independent approval -> real mock completion and cancellation', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const authService = new AuthService(db);
  const owner = authService.createUser('telegram-owner@test', 'fixture-only-password', UserRole.ADMIN);
  const approver = authService.createUser('telegram-approver@test', 'fixture-only-password', UserRole.APPROVER);
  const viewer = authService.createUser('telegram-viewer@test', 'fixture-only-password', UserRole.VIEWER);
  const outsider = authService.createUser('telegram-outsider@test', 'fixture-only-password', UserRole.MAKER);
  const auth = createAuthMiddleware(authService);
  const engine = new ExecutionEngine(db);
  const app = express().use(express.json());
  const ws = { broadcastTaskEvent: vi.fn(), broadcastTaskEventById: vi.fn(), broadcast: vi.fn() } as any;
  app.use('/api/tasks', auth.requireAuth, createTaskRoutes(db, engine, auth, ws));
  app.use('/api/approvals', auth.requireAuth, createApprovalRoutes(db, engine, auth, ws));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  const api = new TelegramApiService(authService, `${base}/api`);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:disposable-token');
  vi.stubEnv('TELEGRAM_ALLOWED_USERS', '111,222,333,444,555');
  vi.stubEnv('TELEGRAM_USER_MAP', JSON.stringify({ '111': owner.id, '222': approver.id, '333': viewer.id, '444': outsider.id }));
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'disposable-webhook-secret');
  app.use('/api/telegram', createTelegramRoutes(db, auth, ws, api));
  app.use(errorHandler);
  const replies: string[] = [];
  const actualFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.telegram.org') {
      replies.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    expect(url.origin).toBe(base);
    return actualFetch(input, init);
  });
  let messageId = 0;
  const webhook = (sender: number, text: string, secret = 'disposable-webhook-secret') => actualFetch(`${base}/api/telegram/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: ++messageId, message: { chat: { id: sender }, from: { id: sender }, text, message_id: messageId } }),
  });
  try {
    expect((await webhook(111, '/task denied', 'wrong')).status).toBe(401);
    await webhook(999, '/task unknown'); await webhook(555, '/task unlinked'); await webhook(333, '/dennis_task not allowed');
    expect(db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM agents WHERE id='dennis-agent'").get()).toEqual({ n: 0 });
    expect(replies.at(-1)).toContain('FORBIDDEN');

    await webhook(111, '/task@fixture_bot deploy disposable mock fixture');
    const task = db.prepare('SELECT * FROM tasks').get() as any;
    expect(task).toMatchObject({ status: 'pending', created_by: owner.id, owner_user_id: owner.id });
    expect(db.prepare("SELECT count(*) n FROM audit_events WHERE task_id=? AND event_type='task.created' AND user_id=?").get(task.id, owner.id)).toEqual({ n: 1 });
    expect(ws.broadcastTaskEvent).toHaveBeenCalled();
    const awaiting = await engine.executeTask(task.id, 'mock');
    expect(awaiting.status).toBe('awaiting_approval');
    const approvalId = awaiting.approvalId!;
    await webhook(111, `/approve ${approvalId}`);
    expect(db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId)).toEqual({ status: 'pending' });
    expect(replies.at(-1)).toContain('eigen aanvraag');
    await webhook(333, `/approve ${approvalId}`);
    expect(replies.at(-1)).toContain('FORBIDDEN');
    await webhook(222, `/approve ${approvalId}`);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && (db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id) as any).status !== 'completed') {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id)).toEqual({ status: 'completed' });
    expect(db.prepare('SELECT status,decided_by FROM approvals WHERE id=?').get(approvalId)).toEqual({ status: 'approved', decided_by: approver.id });
    expect((db.prepare('SELECT count(*) n FROM execution_events WHERE task_id=?').get(task.id) as any).n).toBeGreaterThan(0);
    expect((db.prepare("SELECT count(*) n FROM audit_events WHERE task_id=? AND event_type='task.executed'").get(task.id) as any).n).toBe(1);

    await webhook(111, '/dennis_task safe fixture');
    const dryRun = db.prepare("SELECT * FROM tasks WHERE execution_mode='dry_run'").get() as any;
    expect(dryRun.owner_user_id).toBe(owner.id);
    expect(JSON.parse(dryRun.metadata).autonomy_mode).toBe('dry_run_only');
    await webhook(444, `/cancel ${dryRun.id}`);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(dryRun.id)).toEqual({ status: 'pending' });
    await webhook(111, `/cancel ${dryRun.id}`);
    expect(replies.at(-1)).toContain('TASK\\_NOT\\_RUNNING');
    await webhook(111, '/task Read disposable cancellation fixture');
    const cancellable = db.prepare("SELECT * FROM tasks WHERE description='Read disposable cancellation fixture'").get() as any;
    const running = await engine.executeTask(cancellable.id, 'mock');
    expect(running.status).toBe('started');
    await webhook(444, `/cancel ${cancellable.id}`);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(cancellable.id)).toEqual({ status: 'running' });
    await webhook(111, `/cancel ${cancellable.id}`);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(cancellable.id)).toEqual({ status: 'cancelled' });
    await running.completion;

    await webhook(111, '/task deploy rejected disposable fixture');
    const deniedTask = db.prepare("SELECT * FROM tasks WHERE description='deploy rejected disposable fixture'").get() as any;
    const deniedApproval = await engine.executeTask(deniedTask.id, 'mock');
    expect(deniedApproval.status).toBe('awaiting_approval');
    await webhook(222, `/reject ${deniedApproval.approvalId}`);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(deniedTask.id)).toEqual({ status: 'cancelled' });

    db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(owner.id);
    await webhook(111, '/task disabled');
    expect(db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 4 });
    expect(replies.at(-1)).toContain('disabled');
    db.prepare('UPDATE users SET is_active=1,role=? WHERE id=?').run(UserRole.VIEWER, owner.id);
    await webhook(111, '/task downgraded');
    expect(replies.at(-1)).toContain('FORBIDDEN');
    expect(db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 4 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
}, 30_000);

it('never forwards mapped-user credentials to a remote origin', () => {
  expect(() => new TelegramApiService({} as any, 'https://example.test/api')).toThrow('TELEGRAM_API_MUST_BE_LOCAL');
});

it.each([200, 429])('surfaces Telegram delivery rejection without exposing credentials (HTTP %s)', async status => {
  const service = new TelegramBotService({} as any);
  service.configure({ botToken: 'fixture-not-to-be-logged', allowedUsers: [] });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'Fixture rejected' }), { status }));
  await expect(service.sendMessage(123, 'Fixture reply')).rejects.toThrow('TELEGRAM_DELIVERY_FAILED');
});

it('reaches webhook-secret authentication through the full router without making diff/status public', async () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const authService = new AuthService(db);
  const auth = createAuthMiddleware(authService);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:disposable-token');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'fixture-secret');
  vi.stubEnv('TELEGRAM_ALLOWED_USERS', ''); vi.stubEnv('TELEGRAM_USER_MAP', '{}');
  const app = express().use(express.json()).use('/api', createRoutes(db, undefined, authService, auth, undefined, undefined, false));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/api`;
  try {
    const incoming = await fetch(`${base}/telegram/webhook`, { method: 'POST', headers: {
      'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'fixture-secret',
    }, body: '{}' });
    expect(incoming.status).toBe(200);
    expect((await fetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/telegram/status`)).status).toBe(401);
    expect((await fetch(`${base}/tasks/missing/diff`)).status).toBe(401);
    expect((await fetch(`${base}/tasks/missing/file-changes`)).status).toBe(401);
    expect((await fetch(`${base}/tasks/missing/snapshots`)).status).toBe(401);
    const publicHealth = await fetch(`${base}/health`);
    expect(publicHealth.status).toBe(200);
    expect(await publicHealth.json()).not.toHaveProperty('database');
    for (const route of ['/health/deep', '/health/metrics', '/health/metrics/json']) {
      expect((await fetch(`${base}${route}`)).status).toBe(401);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
