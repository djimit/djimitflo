import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createTestDb } from './helpers/test-db';
import { createHealthRoutes } from '../routes/health';
import { createTelegramRoutes } from '../routes/telegram';

const telegramKeys = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USERS',
  'TELEGRAM_WEBHOOK_URL',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_USER_MAP',
] as const;
const originalTelegramEnv = Object.fromEntries(telegramKeys.map((key) => [key, process.env[key]]));

async function listen(app: express.Express): Promise<{ baseUrl: string; server: Server }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

afterEach(() => {
  for (const key of telegramKeys) {
    const value = originalTelegramEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('public HTTP boundaries', () => {
  it('does not expose database provenance on public health', async () => {
    const db = createTestDb();
    const app = express().use('/api/health', createHealthRoutes(db));
    const { baseUrl, server } = await listen(app);

    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'healthy', name: 'djimitflo' });
    expect(body).not.toHaveProperty('database');
    server.close();
    db.close();
  });

  it('fails closed when Telegram webhook secret is absent', async () => {
    const db = createTestDb();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALLOWED_USERS = '123';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://example.test/api/telegram/webhook';
    process.env.TELEGRAM_USER_MAP = '{"123":"user-1"}';
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const app = express().use(express.json()).use('/api/telegram', createTelegramRoutes(db));
    const { baseUrl, server } = await listen(app);

    const response = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: 123 }, from: { id: 123 }, text: '/approve forged', message_id: 1 } }),
    });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toContain('secret is not configured');
    server.close();
    db.close();
  });
});
