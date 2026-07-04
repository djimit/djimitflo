/**
 * Telegram bot routes — webhook endpoint for Telegram messages.
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { TelegramBotService } from '../services/telegram-bot-service';

export function createTelegramRoutes(db: Database): Router {
  const router = Router();
  const bot = new TelegramBotService(db);

  // POST /api/telegram/webhook — receive Telegram webhook
  router.post('/webhook', async (req, res) => {
    try {
      await bot.handleWebhook(req.body);
      res.json({ ok: true });
    } catch (error) {
      console.error('Telegram webhook error:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // GET /api/telegram/status — bot configuration status
  router.get('/status', (_req, res) => {
    res.json({ configured: bot.isConfigured() });
  });

  return router;
}
