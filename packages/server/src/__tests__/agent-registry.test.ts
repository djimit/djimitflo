import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { AgentRegistryService } from '../services/agent-registry-service';

const TEST_OKF_BASE = path.join(__dirname, '__test_okf__');

describe('AgentRegistryService', () => {
  let service: AgentRegistryService;

  beforeEach(() => {
    if (fs.existsSync(TEST_OKF_BASE)) {
      fs.rmSync(TEST_OKF_BASE, { recursive: true });
    }
    service = new AgentRegistryService(TEST_OKF_BASE);
  });

  it('writeAgentConcept creates a valid OKF file with frontmatter', () => {
    const result = service.writeAgentConcept({
      id: 'test-agent-1',
      name: 'Test Hermes',
      description: 'A test Hermes agent',
      machineIp: '10.0.0.1',
      agentType: 'hermes',
      hostMachineId: 'test-machine',
      capabilities: ['code', 'research'],
      lastSeen: '2026-06-14T12:00:00Z',
      status: 'active',
    });

    expect(result).toContain('test-machine.md');

    const content = fs.readFileSync(path.join(TEST_OKF_BASE, 'agents', 'test-machine.md'), 'utf8');
    expect(content).toContain('type: Agent');
    expect(content).toContain('title: Test Hermes');
    expect(content).toContain('resource: http://10.0.0.1:3001');
    expect(content).toContain('tags: [hermes, test-machine, code, research]');
    expect(content).toContain('timestamp: 2026-06-14T12:00:00Z');
    expect(content).toContain('status: active');
    expect(content).toContain('- code');
    expect(content).toContain('- research');
  });

  it('regenerateIndex creates index.md with grouped agents', () => {
    service.writeAgentConcept({
      id: 'a1', name: 'Hermes-1', description: 'Test', machineIp: '10.0.0.1',
      agentType: 'hermes', hostMachineId: 'hermes-1', capabilities: ['code'],
      lastSeen: '2026-06-14T12:00:00Z', status: 'active',
    });
    service.writeAgentConcept({
      id: 'a2', name: 'Claw-1', description: 'Test', machineIp: '10.0.0.2',
      agentType: 'openclaw', hostMachineId: 'claw-1', capabilities: ['shell'],
      lastSeen: '2026-06-14T12:00:00Z', status: 'idle',
    });

    service.regenerateIndex([
      { id: 'a1', name: 'Hermes-1', description: 'Test', machineIp: '10.0.0.1', agentType: 'hermes', hostMachineId: 'hermes-1', capabilities: ['code'], lastSeen: '2026-06-14T12:00:00Z', status: 'active' },
      { id: 'a2', name: 'Claw-1', description: 'Test', machineIp: '10.0.0.2', agentType: 'openclaw', hostMachineId: 'claw-1', capabilities: ['shell'], lastSeen: '2026-06-14T12:00:00Z', status: 'idle' },
    ]);

    const index = fs.readFileSync(path.join(TEST_OKF_BASE, 'agents', 'index.md'), 'utf8');
    expect(index).toContain('## Hermes');
    expect(index).toContain('## Openclaw');
    expect(index).toContain('[Hermes-1]');
    expect(index).toContain('[Claw-1]');
  });

  it('updateHeartbeat writes concept and regenerates index', () => {
    const result = service.updateHeartbeat({
      id: 'a1', name: 'Hermes-1', description: 'Test', machineIp: '10.0.0.1',
      agentType: 'hermes', hostMachineId: 'hermes-1', capabilities: ['code'],
      lastSeen: '2026-06-14T13:00:00Z', status: 'active',
    });

    expect(result.conceptPath).toContain('hermes-1.md');
    expect(result.indexPath).toContain('index.md');
    expect(fs.existsSync(result.conceptPath)).toBe(true);
    expect(fs.existsSync(result.indexPath)).toBe(true);
  });
});