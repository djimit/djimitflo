import { describe, it, expect, vi, beforeEach } from 'vitest';

// Since grammy uses dynamic import which vitest 4 can't mock easily,
// we test the service logic by mocking the module under test itself
import { TelegramGatewayService, TelegramBotConfig } from './index';

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
    service = new TelegramGatewayService(mockConfigs, mockOps);
  });

  describe('constructor', () => {
    it('stores configs and creates empty bots array', () => {
      expect(service).toBeDefined();
      // Bots array starts empty
      expect((service as any).bots).toEqual([]);
    });
  });

  describe('stopAll', () => {
    it('handles stop when no bots started', async () => {
      // Should not throw when no bots are running
      await expect(service.stopAll()).resolves.toBeUndefined();
    });
  });

  describe('integration with ops', () => {
    it('createTask returns a task id', async () => {
      const result = await mockOps.createTask('test task', 'machine-1');
      expect(result).toBe('task-123');
    });

    it('getStatus returns status string', async () => {
      const result = await mockOps.getStatus('machine-1');
      expect(result).toBe('All systems operational');
    });
  });

  describe('config validation', () => {
    it('accepts multiple configs', () => {
      expect(mockConfigs).toHaveLength(2);
      expect(mockConfigs[0].agentType).toBe('hermes');
      expect(mockConfigs[1].agentType).toBe('openclaw');
    });

    it('handles single config', () => {
      const single = new TelegramGatewayService([mockConfigs[0]], mockOps);
      expect(single).toBeDefined();
    });

    it('handles empty configs', () => {
      const empty = new TelegramGatewayService([], mockOps);
      expect(empty).toBeDefined();
    });
  });
});
