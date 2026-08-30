import { describe, expect, it, vi } from 'vitest';
import { DjimitfloRansomwareAdapter } from '../src/adapters/djimitflo-adapter';

class TestEventBus {
  private handler?: (event: { type: string; payload: unknown }) => void;
  emitted: Array<{ type: string; payload: unknown }> = [];

  subscribe(handler: (event: { type: string; payload: unknown }) => void): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }

  emit(type: string, payload: unknown): void {
    this.emitted.push({ type, payload });
  }

  publish(type: string, payload: unknown): void {
    this.handler?.({ type, payload });
  }
}

describe('DjimitfloRansomwareAdapter', () => {
  it('routes self narration and behavioral signals into response detection', () => {
    const bus = new TestEventBus();
    const adapter = new DjimitfloRansomwareAdapter({ swarmEventBus: bus, ransomwareConfig: {} });
    adapter.start();

    bus.publish('worker_executed', { agentId: 'agent-1', output: '# High-ROI target' });
    bus.publish('loop_completed', { agentId: 'agent-1', fileChanges: Array.from({ length: 50 }, (_, i) => `${i}.locked`) });

    expect(bus.emitted.some(event => event.type === 'ransomware:self_narration')).toBe(true);
    expect(bus.emitted.filter(event => event.type === 'ransomware:detected')).toHaveLength(2);
  });

  it('triggers kill and backup callbacks for destructive commands', async () => {
    const bus = new TestEventBus();
    const onKill = vi.fn();
    const onBackupRestore = vi.fn();
    const adapter = new DjimitfloRansomwareAdapter({
      swarmEventBus: bus,
      ransomwareConfig: { backupTrigger: { enabled: true, eventBusTopic: 'backup:restore_requested', targetDb: 'evidence' } },
      onKill,
      onBackupRestore
    });
    adapter.start();

    bus.publish('agent_action', { agentId: 'agent-1', command: 'DROP DATABASE prod; DROP TABLE users' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onKill).toHaveBeenCalledWith('agent-1', 'ransomware_detected');
    expect(onBackupRestore).toHaveBeenCalledWith('evidence', expect.any(Date));
    expect(bus.emitted.some(event => event.type === 'backup:restore_requested')).toBe(true);
  });
});
