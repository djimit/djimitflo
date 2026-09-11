import { afterEach, expect, it, vi } from 'vitest';
import { Bot } from 'grammy';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramGatewayService } from './index';

afterEach(() => vi.restoreAllMocks());

it('routes actual grammY command updates only for explicitly linked allowed senders', async () => {
  vi.spyOn(Bot.prototype, 'start').mockResolvedValue();
  vi.spyOn(Bot.prototype, 'stop').mockResolvedValue();
  const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-transport-'));
  const createTask = vi.fn().mockResolvedValue('created-fixture-task');
  const getStatus = vi.fn().mockResolvedValue('fixture-status');
  const cfg = { token: '123:fixture-only', machineId: 'fixture-machine', agentType: 'hermes' as const,
    hostIp: '127.0.0.1', name: 'Fixture', allowedUsers: [111, 222], userMap: { '111': 'maker-user' } };
  const gateway = new TelegramGatewayService([cfg], { createTask, getStatus }, { leaseDir });
  try {
    await gateway.startAll();
    const bot = (gateway as any).bots[0] as Bot;
    bot.botInfo = { id: 123, is_bot: true, first_name: 'Fixture', username: 'fixture_bot',
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
      has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
    const replies: string[] = [];
    bot.api.config.use(async (_previous, method, payload) => {
      expect(method).toBe('sendMessage');
      replies.push((payload as any).text);
      return { ok: true, result: { message_id: 99 } } as any;
    });
    const update = (from: number, text: string) => bot.handleUpdate({ update_id: from, message: {
      message_id: from, date: 0, from: { id: from, is_bot: false, first_name: 'Fixture' },
      chat: { id: from, type: 'private', first_name: 'Fixture' }, text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    } });
    await update(999, '/task forbidden');
    await update(222, '/task unlinked');
    expect(createTask).not.toHaveBeenCalled();
    await update(111, '/task@fixture_bot bounded task');
    expect(createTask).toHaveBeenCalledExactlyOnceWith('bounded task', 'fixture-machine', 'maker-user');
    await update(111, '/status');
    expect(getStatus).toHaveBeenCalledExactlyOnceWith('fixture-machine', 'maker-user');
    expect(replies.some(text => text.includes('created-fixture-task'))).toBe(true);
  } finally { await gateway.stopAll(); fs.rmSync(leaseDir, { recursive: true, force: true }); }
});
