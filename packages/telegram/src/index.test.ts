import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramGatewayService, TelegramBotConfig } from './index';

// Track calls manually (avoid clearAllMocks issues with hoisted vi.mock)
let commandCalls: string[] = [];
let startCalls = 0;
let stopCalls = 0;
let catchCalls = 0;

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation((token: string) => ({
    command: vi.fn((name: string) => {
      commandCalls.push(name);
      return { command: vi.fn().mockReturnThis(), catch: vi.fn().mockReturnThis(), start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    }),
    catch: vi.fn(() => { catchCalls++; return undefined; }),
    start: vi.fn().mockImplementation(() => { startCalls++; return Promise.resolve(); }),
    stop: vi.fn().mockImplementation(() => { stopCalls++; return Promise.resolve(); }),
    token,
  })),
}));

describe('TelegramGatewayService', () => {
  const mockConfigs: TelegramBotConfig[] = [
    { token: 'test-token-1', machineId: 'machine-1', agentType: 'hermes', hostIp: '192.168.1.28', name: 'Hermes Bot' },
    { token: 'test-token-2', machineId: 'machine-2', agentType: 'openclaw', hostIp: '192.168.1.29', name: 'OpenClaw Bot' },
  ];

  const mockOps = {
    createTask: vi.fn().mockResolvedValue('task-123'),
    getStatus: vi.fn().mockResolvedValue('All systems operational'),
  };

  let service: TelegramGatewayService;

  beforeEach(() => {
    commandCalls = [];
    startCalls = 0;
    stopCalls = 0;
    catchCalls = 0;
    service = new TelegramGatewayService(mockConfigs, mockOps);
  });

  describe('startAll', () => {
    it('creates a bot per config', async () => {
      await service.startAll();
      const { Bot } = await import('grammy');
      expect(Bot).toHaveBeenCalledTimes(2);
    });

    it('registers 3 commands per bot', async () => {
      await service.startAll();
      // 2 bots * 3 commands = 6
      expect(commandCalls.length).toBe(6);
    });

    it('starts polling for each bot', async () => {
      await service.startAll();
      expect(startCalls).toBe(2);
    });

    it('registers error handler per bot', async () => {
      await service.startAll();
      expect(catchCalls).toBe(2);
    });

    it('handles single config', async () => {
      const single = new TelegramGatewayService([mockConfigs[0]], mockOps);
      await single.startAll();
      const { Bot } = await import('grammy');
      expect(Bot).toHaveBeenCalledTimes(1);
    });

    it('handles empty configs', async () => {
      const empty = new TelegramGatewayService([], mockOps);
      await empty.startAll();
      const { Bot } = await import('grammy');
      expect(Bot).not.toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('stops all running bots', async () => {
      await service.startAll();
      await service.stopAll();
      expect(stopCalls).toBe(2);
    });

    it('handles stop when no bots started', async () => {
      await service.stopAll();
      expect(stopCalls).toBe(0);
    });
  });

  describe('command handlers', () => {
    it('registers start, status, and task commands', async () => {
      await service.startAll();
      expect(commandCalls).toContain('start');
      expect(commandCalls).toContain('status');
      expect(commandCalls).toContain('task');
    });
  });
});
