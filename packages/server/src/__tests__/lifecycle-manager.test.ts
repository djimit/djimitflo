import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleManager, type Stoppable } from '../services/lifecycle-manager';

describe('LifecycleManager', () => {
  let manager: LifecycleManager;
  let exit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exit = vi.fn();
    manager = new LifecycleManager(exit as unknown as (code: number) => never);
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('unhandledRejection');
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const closeFn = vi.fn((cb: () => void) => cb());
    const mockServer = { close: closeFn };
    manager.initSignalHandlers(mockServer);

    const service = createMockService('TestService');
    manager.register(service);

    expect(() => process.emit('SIGTERM' as any)).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  it('handles SIGINT and exits after cleanup', async () => {
    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    const service = createMockService('TestService');
    manager.register(service);

    expect(() => process.emit('SIGINT' as any)).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('stops registered services in reverse registration order', async () => {
    const order: string[] = [];
    const first = { serviceName: 'First', stop: vi.fn(() => { order.push('First'); }) };
    const second = { serviceName: 'Second', stop: vi.fn(() => { order.push('Second'); }) };
    const third = { serviceName: 'Third', stop: vi.fn(() => { order.push('Third'); }) };
    manager.register(first);
    manager.register(second);
    manager.register(third);

    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);
    process.emit('SIGTERM' as any);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(order).toEqual(['Third', 'Second', 'First']);
  });

  it('continues stopping remaining services and still exits 0 when one service.stop() rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('stop failed');
    const failing = { serviceName: 'Failing', stop: vi.fn(() => { throw failure; }) };
    const healthy = { serviceName: 'Healthy', stop: vi.fn() };
    manager.register(failing);
    manager.register(healthy);

    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);
    process.emit('SIGTERM' as any);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(healthy.stop).toHaveBeenCalledTimes(1);
    expect(failing.stop).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Failing'), failure);
  });

  it('awaits asynchronous stop() implementations before completing shutdown', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const slow = {
      serviceName: 'Slow',
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              events.push('slow-done');
              resolve();
            }, 1000);
          }),
      ),
    };
    manager.register(slow);

    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);
    process.emit('SIGTERM' as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(events).toEqual(['slow-done']);
  });

  it('ignores a second shutdown signal received while shutdown is already in progress', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const service = createMockService('TestService');
    manager.register(service);

    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    process.emit('SIGTERM' as any);
    process.emit('SIGTERM' as any);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('ignoring'));
  });

  it('exits with code 1 and logs the error when the shutdown sequence throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeError = new Error('close failed');
    const mockServer = {
      close: () => {
        throw closeError;
      },
    };
    const service = createMockService('TestService');
    manager.register(service);
    manager.initSignalHandlers(mockServer);

    process.emit('SIGTERM' as any);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(service.stop).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('❌ Shutdown error:', closeError);
  });

  it('logs unhandled promise rejections without throwing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockServer = { close: (cb: () => void) => cb() };
    manager.initSignalHandlers(mockServer);

    const reason = new Error('unhandled boom');
    expect(() => process.emit('unhandledRejection' as any, reason, Promise.resolve())).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('⚠️  Unhandled rejection:', reason);
    expect(exit).not.toHaveBeenCalled();
  });
});
