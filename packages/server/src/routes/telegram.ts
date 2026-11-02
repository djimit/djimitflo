/**
 * Telegram bot routes — webhook endpoint for Telegram messages.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { TelegramBotService } from '../services/telegram-bot-service';
import type { AuthMiddleware } from '../middleware/auth';
import type { WebSocketService } from '../services/websocket-service';
import type { TelegramApiService } from '../services/telegram-api-service';
import { setPushSender, startOperatorDigest } from '../services/operator-push';
import { ROLE_PERMISSIONS, type UserRole } from '@djimitflo/shared';

export function parseTelegramAllowedUsers(value = ''): number[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
}

export function parseTelegramUserMap(value = ''): Record<string, string> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([key, user]) => /^\d+$/.test(key) && typeof user === 'string' && user.trim())) as Record<string, string>
      : {};
  } catch { return {}; }
}

/**
 * TG-2 (prod 2026-10-06): Approve/Deny buttons are authorised ONLY by the D3 table telegram_identities (an active user
 * whose role holds approve:task) — TELEGRAM_USER_MAP only links chat commands. The status used to report ready from the
 * env alone while every button press was refused, so readiness now requires at least one D3 approver identity.
 */
export function approverIdentityCount(db: Database | undefined): number | null {
  if (!db) return null;
  try {
    const rows = db.prepare(`SELECT u.role FROM telegram_identities t JOIN users u ON u.id = t.user_id WHERE u.is_active = 1`).all() as Array<{ role: UserRole }>;
    return rows.filter((r) => (ROLE_PERMISSIONS[r.role] ?? []).includes('approve:task')).length;
  } catch { return 0; } // table missing on an old schema = no approver
}

export function telegramConfigStatus(env: NodeJS.ProcessEnv = process.env, configured = Boolean(env.TELEGRAM_BOT_TOKEN), db?: Database) {
  const allowedUsers = parseTelegramAllowedUsers(env.TELEGRAM_ALLOWED_USERS);
  const userMap = parseTelegramUserMap(env.TELEGRAM_USER_MAP);
  const missing_env = [
    ['TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN],
    ['TELEGRAM_ALLOWED_USERS', env.TELEGRAM_ALLOWED_USERS],
    ['TELEGRAM_WEBHOOK_URL', env.TELEGRAM_WEBHOOK_URL],
    ['TELEGRAM_WEBHOOK_SECRET', env.TELEGRAM_WEBHOOK_SECRET],
    ['TELEGRAM_USER_MAP', env.TELEGRAM_USER_MAP],
  ].filter(([, value]) => !value).map(([key]) => key);
  const approvers = approverIdentityCount(db);
  const envReady = Boolean(env.TELEGRAM_BOT_TOKEN && allowedUsers.length > 0 && env.TELEGRAM_WEBHOOK_URL && env.TELEGRAM_WEBHOOK_SECRET);
  const blocking = [
    ...missing_env.filter((k) => k !== 'TELEGRAM_USER_MAP'),
    ...(approvers === null ? ['approver identity unknown (no database)'] : approvers === 0
      ? ['no telegram_identities row for an active user with approve:task — add it on /decisions (Telegram identities); TELEGRAM_USER_MAP does not authorise buttons'] : []),
  ];

  return {
    configured,
    ready: envReady && (approvers ?? 0) > 0,
    allowed_user_count: allowedUsers.length,
    webhook_configured: Boolean(env.TELEGRAM_WEBHOOK_URL),
    linked_identity_count: Object.keys(userMap).length,
    approver_identity_count: approvers,
    missing_env,
    blocking,
  };
}

export function createTelegramRoutes(db: Database, auth?: AuthMiddleware, _wsService?: WebSocketService, api?: TelegramApiService): Router {
  const router = Router();
  const bot = new TelegramBotService(db, api);
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    bot.configure({
      botToken,
      allowedUsers: parseTelegramAllowedUsers(process.env.TELEGRAM_ALLOWED_USERS),
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
      userMap: parseTelegramUserMap(process.env.TELEGRAM_USER_MAP),
    });
    // UX-12/13: this webhook bot is the canonical push channel; both pushes stay off until their flags are set
    setPushSender(bot);
    startOperatorDigest(db);
  }

  // POST /api/telegram/webhook — receive Telegram webhook
  router.post('/webhook', async (req, res) => {
    try {
      if (!bot.isConfigured()) {
        res.status(503).json({ error: 'Telegram webhook is not configured' });
        return;
      }
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret) {
        res.status(503).json({ error: 'Telegram webhook secret is not configured' });
        return;
      }
      if (req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }
      await bot.handleWebhook(req.body);
      res.json({ ok: true });
    } catch (error) {
      console.error('Telegram webhook error:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // GET /api/telegram/status — bot configuration status
  router.get('/status', requireAuth, (_req, res) => {
    res.json(telegramConfigStatus(process.env, bot.isConfigured(), db));
  });

  return router;
}
