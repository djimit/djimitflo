import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleManager, type Stoppable } from '../services/lifecycle-manager';

describe('LifecycleManager', () => {
  let manager: LifecycleManager;

  beforeEach(() => {
    manager = new LifecycleManager();
  });

  function createMockService(name: string): Stoppable & { stop: ReturnType<typeof vi.fn> } {
    return {
      serviceName: name,
      stop: vi.fn(),
    };
  }

  it('starts with zero registered services', () => {
    expect(manager.serviceCount).toBe(0);
  });

  it('tracks registered services', () => {
    const service = createMockService('TestService');
    manager.register(service);
    expect(manager.serviceCount).toBe(1);
  });

  it('tracks multiple registered services', () => {
    manager.register(createMockService('Service1'));
    manager.register(createMockService('Service2'));
    manager.register(createMockService('Service3'));
    expect(manager.serviceCount).toBe(3);
  });

  it('initSignalHandlers does not throw', () => {
    const mockServer = { close: vi.fn() };
    expect(() => manager.initSignalHandlers(mockServer)).not.toThrow();
  });

  it('handles SIGTERM without throwing', () => {
    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    const service = createMockService('TestService');
    manager.register(service);

    expect(() => process.emit('SIGTERM' as any)).not.toThrow();
  });

  it('handles SIGINT without throwing', () => {
    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    const service = createMockService('TestService');
    manager.register(service);

    expect(() => process.emit('SIGINT' as any)).not.toThrow();
  });
});
