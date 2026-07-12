/**
 * Telegram bot routes — webhook endpoint for Telegram messages.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { TelegramBotService } from '../services/telegram-bot-service';
import type { AuthMiddleware } from '../middleware/auth';

export function createTelegramRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const bot = new TelegramBotService(db);
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    bot.configure({
      botToken,
      allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map(Number).filter(Number.isFinite),
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
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
    res.json({ configured: bot.isConfigured() });
  });

  return router;
}
