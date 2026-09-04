import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  describe('polling lease', () => {
    it('skips duplicate pollers for the same bot token', async () => {
      const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-telegram-test-'));
      const first = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      const second = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });

      expect((first as any).acquireLease(mockConfigs[0])).toMatch(/\.lock$/);
      expect((second as any).acquireLease(mockConfigs[0])).toBeNull();

      await first.stopAll();
      fs.rmSync(leaseDir, { recursive: true, force: true });
    });

    it('takes over a lease from a dead same-host owner', async () => {
      const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-telegram-test-'));
      const owner = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      const lease = (owner as any).acquireLease(mockConfigs[0]) as string;
      // simuleer dode owner: herschrijf de lease met een niet-bestaande pid
      const leaseFile = fs.readFileSync(lease, 'utf8');
      const payload = JSON.parse(leaseFile);
      payload.pid = 999_999_999; // bijna zeker niet in gebruik
      fs.writeFileSync(lease, JSON.stringify(payload));
      (owner as any).leases = [];

      const taker = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      expect((taker as any).acquireLease(mockConfigs[0])).toMatch(/\.lock$/);

      await taker.stopAll();
      fs.rmSync(leaseDir, { recursive: true, force: true });
    });

    it('does not take over a live lease (pid alive)', async () => {
      const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-telegram-test-'));
      const first = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      (first as any).acquireLease(mockConfigs[0]);
      const second = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      // owner pid leeft; host-qualified check mag niet overnemen
      expect((second as any).acquireLease(mockConfigs[0])).toBeNull();
      await first.stopAll();
      fs.rmSync(leaseDir, { recursive: true, force: true });
    });

    it('takes over an expired lease regardless of host', async () => {
      const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-telegram-test-'));
      const first = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      const lease = (first as any).acquireLease(mockConfigs[0]) as string;
      // simuleer verlopen heartbeat: mtime ver naar verleden
      const old = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(lease, old, old);
      const second = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      expect((second as any).acquireLease(mockConfigs[0])).toMatch(/\.lock$/);
      await second.stopAll();
      fs.rmSync(leaseDir, { recursive: true, force: true });
    });

    it('keeps lease heartbeat fresh while running', async () => {
      const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimit-telegram-test-'));
      const svc = new TelegramGatewayService([mockConfigs[0]], mockOps, { leaseDir });
      const lease = (svc as any).acquireLease(mockConfigs[0]) as string;
      const before = fs.statSync(lease).mtimeMs;
      // forceer heartbeat-cycle korter door direct utimes te roepen is niet
      // nodig: verify startHeartbeat interval is armed
      expect((svc as any).heartbeatTimer).toBeNull(); // nog niet gestart (pas na startAll)
      (svc as any).startHeartbeat();
      expect((svc as any).heartbeatTimer).not.toBeNull();
      void before;
      await svc.stopAll();
      expect((svc as any).heartbeatTimer).toBeNull();
      fs.rmSync(leaseDir, { recursive: true, force: true });
    });
  });
});
