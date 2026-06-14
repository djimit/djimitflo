import { describe, it, expect } from 'vitest';
import { WorkspaceProvisionerService } from '../services/workspace-provisioner-service';
import fs from 'fs';
import path from 'path';

const TEST_OUTPUT = path.join(__dirname, '__test_workspaces__');

describe('WorkspaceProvisionerService', () => {
  let service: WorkspaceProvisionerService;

  beforeEach(() => {
    if (fs.existsSync(TEST_OUTPUT)) {
      fs.rmSync(TEST_OUTPUT, { recursive: true });
    }
    service = new WorkspaceProvisionerService(TEST_OUTPUT);
  });

  it('provision generates all 5 identity files', () => {
    const result = service.provision({
      machineId: 'test-macmini',
      ip: '192.168.1.61',
      agentType: 'hermes',
      botName: 'DjimitMacMini_bot',
      capabilities: ['code', 'research', 'shell'],
    });

    expect(Object.keys(result.files)).toHaveLength(5);
    expect(result.files['SOUL.md']).toContain('Dennis Landman');
    expect(result.files['USER.md']).toContain('Senior IT-consultant');
    expect(result.files['TOOLS.md']).toContain('192.168.1.28:8000');
    expect(result.files['TOOLS.md']).toContain('hermes');
    expect(result.files['AGENTS.md']).toContain('test-macmini');
    expect(result.files['AGENTS.md']).toContain('192.168.1.61');
    expect(result.files['HEARTBEAT.md']).toContain('192.168.1.28:3001');

    const dir = result.dir;
    expect(fs.existsSync(path.join(dir, 'SOUL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'USER.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'TOOLS.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'HEARTBEAT.md'))).toBe(true);
  });

  it('provisionAll provisions multiple machines', () => {
    const results = service.provisionAll([
      { machineId: 'workstation', ip: '192.168.1.28', agentType: 'hermes', botName: 'Djimit2_bot', capabilities: ['code'] },
      { machineId: 'macbook', ip: '192.168.1.240', agentType: 'openclaw', botName: 'MacBookDjimit_bot', capabilities: ['shell'] },
    ]);

    expect(Object.keys(results)).toHaveLength(2);
    expect(results['workstation'].files['TOOLS.md']).toContain('192.168.1.28');
    expect(results['macbook'].files['TOOLS.md']).toContain('192.168.1.240');
  });

  it('deliverViaSsh returns scp commands', () => {
    const result = service.deliverViaSsh(
      { machineId: 'test-machine', ip: '192.168.1.61', agentType: 'hermes', botName: 'TestBot', capabilities: ['code'] },
      '/home/agent/.hermes',
    );

    expect(result.command).toContain('scp');
    expect(result.command).toContain('192.168.1.61:/home/agent/.hermes');
    expect(Object.keys(result.files)).toHaveLength(5);
  });

  it('heartbeat cadans is between 03:00 and 06:00', () => {
    const result = service.provision({
      machineId: 'test-machine', ip: '10.0.0.1', agentType: 'openclaw', botName: 'TestBot', capabilities: ['shell'],
    });

    const heartbeat = result.files['HEARTBEAT.md'];
    const hourMatch = heartbeat.match(/Dagelijks (\d{2}):(\d{2})/);
    expect(hourMatch).not.toBeNull();
    const hour = parseInt(hourMatch![1], 10);
    expect(hour).toBeGreaterThanOrEqual(3);
    expect(hour).toBeLessThanOrEqual(5);
  });
});