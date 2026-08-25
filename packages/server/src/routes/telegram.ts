/**
 * Telegram bot routes — webhook endpoint for Telegram messages.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { TelegramBotService } from '../services/telegram-bot-service';
import type { AuthMiddleware } from '../middleware/auth';

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

export function telegramConfigStatus(env: NodeJS.ProcessEnv = process.env, configured = Boolean(env.TELEGRAM_BOT_TOKEN)) {
  const allowedUsers = parseTelegramAllowedUsers(env.TELEGRAM_ALLOWED_USERS);
  const userMap = parseTelegramUserMap(env.TELEGRAM_USER_MAP);
  const missing_env = [
    ['TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN],
    ['TELEGRAM_ALLOWED_USERS', env.TELEGRAM_ALLOWED_USERS],
    ['TELEGRAM_WEBHOOK_URL', env.TELEGRAM_WEBHOOK_URL],
    ['TELEGRAM_USER_MAP', env.TELEGRAM_USER_MAP],
  ].filter(([, value]) => !value).map(([key]) => key);

  return {
    configured,
    ready: Boolean(env.TELEGRAM_BOT_TOKEN && allowedUsers.length > 0 && env.TELEGRAM_WEBHOOK_URL && Object.keys(userMap).length > 0),
    allowed_user_count: allowedUsers.length,
    webhook_configured: Boolean(env.TELEGRAM_WEBHOOK_URL),
    linked_identity_count: Object.keys(userMap).length,
    missing_env,
  };
}

export function createTelegramRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const bot = new TelegramBotService(db);
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    bot.configure({
      botToken,
      allowedUsers: parseTelegramAllowedUsers(process.env.TELEGRAM_ALLOWED_USERS),
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
      userMap: parseTelegramUserMap(process.env.TELEGRAM_USER_MAP),
    });
  }

  // POST /api/telegram/webhook — receive Telegram webhook
  router.post('/webhook', async (req, res) => {
    try {
      if (!bot.isConfigured()) {
        res.status(503).json({ error: 'Telegram webhook is not configured' });
        return;
      }
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (secret && req.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
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
    res.json(telegramConfigStatus(process.env, bot.isConfigured()));
  });

  return router;
}
