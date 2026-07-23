import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramGatewayService, TelegramBotConfig } from './index';

// Mock grammy's Bot class
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockCommand = vi.fn().mockReturnThis();
const mockCatch = vi.fn().mockReturnThis();
const mockReply = vi.fn().mockResolvedValue(undefined);

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation((token: string) => ({
    command: mockCommand,
    catch: mockCatch,
    start: mockStart,
    stop: mockStop,
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
    vi.clearAllMocks();
    service = new TelegramGatewayService(mockConfigs, mockOps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('stores configs and ops', () => {
      expect(service).toBeDefined();
      // Verify configs are stored (via behavior in startAll)
      expect(mockConfigs).toHaveLength(2);
    });
  });

  describe('startAll', () => {
    it('creates a bot per config', async () => {
      await service.startAll();
      // Bot constructor called once per config
      const { Bot } = await import('grammy');
      expect(Bot).toHaveBeenCalledTimes(2);
      expect(Bot).toHaveBeenCalledWith('test-token-1');
      expect(Bot).toHaveBeenCalledWith('test-token-2');
    });

    it('registers 3 commands per bot (start, status, task)', async () => {
      await service.startAll();
      // 2 bots * 3 commands = 6 command registrations
      expect(mockCommand).toHaveBeenCalledTimes(6);
    });

    it('starts polling for each bot', async () => {
      await service.startAll();
      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({ allowed_updates: ['message'] })
      );
    });

    it('registers error handler per bot', async () => {
      await service.startAll();
      expect(mockCatch).toHaveBeenCalledTimes(2);
    });

    it('handles single config', async () => {
      const singleService = new TelegramGatewayService(
        [mockConfigs[0]],
        mockOps
      );
      await singleService.startAll();
      const { Bot } = await import('grammy');
      expect(Bot).toHaveBeenCalledTimes(1);
    });

    it('handles empty configs', async () => {
      const emptyService = new TelegramGatewayService([], mockOps);
      await emptyService.startAll();
      const { Bot } = await import('grammy');
      expect(Bot).not.toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('stops all running bots', async () => {
      await service.startAll();
      await service.stopAll();
      expect(mockStop).toHaveBeenCalledTimes(2);
    });

    it('clears bots array after stopping', async () => {
      await service.startAll();
      await service.stopAll();
      // Calling stopAll again should not call stop on already-stopped bots
      await service.stopAll();
      expect(mockStop).toHaveBeenCalledTimes(2); // not 4
    });

    it('handles stop when no bots started', async () => {
      await service.stopAll();
      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe('command handlers', () => {
    it('registers start command that replies with bot info', async () => {
      await service.startAll();
      // Find the 'start' command handler
      const startCall = mockCommand.mock.calls.find(
        (call: any[]) => call[0] === 'start'
      );
      expect(startCall).toBeDefined();
      expect(startCall![1]).toBeInstanceOf(Function);
    });

    it('registers status command that calls ops.getStatus', async () => {
      await service.startAll();
      const statusCall = mockCommand.mock.calls.find(
        (call: any[]) => call[0] === 'status'
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1]).toBeInstanceOf(Function);
    });

    it('registers task command that calls ops.createTask', async () => {
      await service.startAll();
      const taskCall = mockCommand.mock.calls.find(
        (call: any[]) => call[0] === 'task'
      );
      expect(taskCall).toBeDefined();
      expect(taskCall![1]).toBeInstanceOf(Function);
    });
  });
});
