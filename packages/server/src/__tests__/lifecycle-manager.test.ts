import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleManager, type Stoppable } from '../services/lifecycle-manager';

describe('LifecycleManager', () => {
  let manager: LifecycleManager;
  let exit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exit = vi.fn();
    manager = new LifecycleManager(exit as unknown as (code: number) => never);
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
    const mockServer = { close: (cb: () => void) => cb() };
    expect(() => manager.initSignalHandlers(mockServer)).not.toThrow();
  });

  it('handles SIGTERM and exits after cleanup', async () => {
    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    const service = createMockService('TestService');
    manager.register(service);

    expect(() => process.emit('SIGTERM' as any)).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('handles SIGINT and exits after cleanup', async () => {
    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    const service = createMockService('TestService');
    manager.register(service);

    expect(() => process.emit('SIGINT' as any)).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
