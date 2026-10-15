import { describe, expect, it } from 'vitest';
import { messageBus } from '../services/message_bus';
import type { SwarmMessage } from '../services/message_bus';

const msg = (overrides?: Partial<SwarmMessage>): SwarmMessage => ({
  id: 'm1',
  from_agent_id: 'a',
  to_agent_id: 'b',
  type: 'status_update',
  payload: {},
  priority: 'medium',
  read_at: null,
  created_at: new Date().toISOString(),
  ...overrides,
});

describe('messageBus', () => {
  it('is a singleton with the expected methods', () => {
    expect(typeof messageBus.publish).toBe('function');
    expect(typeof messageBus.subscribe).toBe('function');
    expect(typeof messageBus.unsubscribe).toBe('function');
    expect(typeof messageBus.disconnect).toBe('function');
  });

  it('publish delivers the message to subscribed agents', async () => {
    const received: SwarmMessage[] = [];
    const unsub = messageBus.subscribe('agent-1', (m) => received.push(m));
    await messageBus.publish('agent-1', msg({ to_agent_id: 'agent-1' }));
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('m1');
    unsub();
  });

  it('publish is a no-op when no subscriber exists for the target agent', async () => {
    // Should not throw
    await messageBus.publish('nobody-here', msg());
  });

  it('multiple subscribers all receive the same message', async () => {
    const a: SwarmMessage[] = [];
    const b: SwarmMessage[] = [];
    const unA = messageBus.subscribe('multi', (m) => a.push(m));
    const unB = messageBus.subscribe('multi', (m) => b.push(m));
    await messageBus.publish('multi', msg({ to_agent_id: 'multi' }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unA();
    unB();
  });

  it('the returned unsubscribe function stops delivery for that callback only', async () => {
    const first: SwarmMessage[] = [];
    const second: SwarmMessage[] = [];
    const unFirst = messageBus.subscribe('pair', (m) => first.push(m));
    const unSecond = messageBus.subscribe('pair', (m) => second.push(m));
    unFirst();
    await messageBus.publish('pair', msg({ to_agent_id: 'pair' }));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    unSecond();
  });

  it('unsubscribe(agentId) removes all callbacks for that agent', async () => {
    const received: SwarmMessage[] = [];
    messageBus.subscribe('wipe', (m) => received.push(m));
    messageBus.subscribe('wipe', (m) => received.push(m));
    messageBus.unsubscribe('wipe');
    await messageBus.publish('wipe', msg({ to_agent_id: 'wipe' }));
    expect(received).toHaveLength(0);
  });

  it('disconnect() clears all subscriptions across agents', async () => {
    const received: SwarmMessage[] = [];
    const unA = messageBus.subscribe('dc-a', (m) => received.push(m));
    const unB = messageBus.subscribe('dc-b', (m) => received.push(m));
    messageBus.disconnect();
    // After disconnect, even the old unsubscribe handles are harmless
    unA();
    unB();
    await messageBus.publish('dc-a', msg({ to_agent_id: 'dc-a' }));
    await messageBus.publish('dc-b', msg({ to_agent_id: 'dc-b' }));
    expect(received).toHaveLength(0);
  });
});
