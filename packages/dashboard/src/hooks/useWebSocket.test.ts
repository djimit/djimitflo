import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket';
import { AUTH_SESSION_KEY, useAuthStore } from '../lib/auth-store';
import { WS_CLOSE_CODES } from '@djimitflo/shared';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  close = vi.fn(() => { this.readyState = 3; this.onclose?.({ code: 1000 }); });
  constructor(public url: string, public protocol: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  useAuthStore.getState().replaceToken('test-session');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAuthStore.setState({ token: null, user: null, isAuthenticated: false, isLoading: false });
});

describe('WebSocket lifecycle', () => {
  it('reconnects an open socket when the access token changes', () => {
    renderHook(() => useWebSocket(true));
    act(() => Socket.instances[0].open());
    act(() => useAuthStore.getState().replaceToken('replacement'));
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(2);
    expect(Socket.instances[1].protocol).toBe('bearer.replacement');
  });

  it('refreshes an expired socket once and stops if the replacement is rejected before opening', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ token: 'replacement', user: { id: 'fixture' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    renderHook(() => useWebSocket(true));
    act(() => Socket.instances[0].open());
    await act(async () => { Socket.instances[0].serverClose(WS_CLOSE_CODES.AUTH_EXPIRED); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(2);
    expect(Socket.instances[1].protocol).toBe('bearer.replacement');
    await act(async () => { Socket.instances[1].serverClose(WS_CLOSE_CODES.AUTH_EXPIRED); vi.advanceTimersByTime(6000); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(2);
  });

  it('does not reconnect or loop on an invalid/revoked token', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    renderHook(() => useWebSocket(true));
    act(() => { Socket.instances[0].serverClose(WS_CLOSE_CODES.AUTH_INVALID); vi.advanceTimersByTime(6000); });
    expect(fetch).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(1);
  });

  it('closes the socket when another tab removes the session', () => {
    renderHook(() => useWebSocket(true));
    act(() => Socket.instances[0].open());
    act(() => {
      localStorage.removeItem(AUTH_SESSION_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: AUTH_SESSION_KEY, oldValue: 'test-session', newValue: null }));
      vi.advanceTimersByTime(6000);
    });
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(1);
  });

  it('does not reconnect after unmount while a refresh response is pending', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    const hook = renderHook(() => useWebSocket(true));
    act(() => Socket.instances[0].serverClose(WS_CLOSE_CODES.AUTH_EXPIRED));
    hook.unmount();
    await act(async () => { resolve(new Response(JSON.stringify({ token: 'replacement', user: { id: 'fixture' } }))); });
    expect(Socket.instances).toHaveLength(1);
  });

  it.each([false, true])('closes the socket on unmount without reconnecting (opened=%s)', opened => {
    const hook = renderHook(() => useWebSocket(true));
    const socket = Socket.instances[0];
    expect(socket.protocol).toBe('bearer.test-session');
    if (opened) act(() => socket.open());
    hook.unmount();
    expect(socket.close).toHaveBeenCalledOnce();
    act(() => { socket.onopen?.(); vi.advanceTimersByTime(6000); });
    expect(Socket.instances).toHaveLength(1);
  });

  it('reconnects after an unexpected disconnect and cancels pending retries on logout', () => {
    const hook = renderHook(({ authenticated }) => useWebSocket(authenticated), { initialProps: { authenticated: true } });
    act(() => Socket.instances[0].open());
    act(() => Socket.instances[0].close());
    act(() => vi.advanceTimersByTime(3000));
    expect(Socket.instances).toHaveLength(2);
    act(() => Socket.instances[1].close());
    hook.rerender({ authenticated: false });
    act(() => vi.advanceTimersByTime(6000));
    expect(Socket.instances).toHaveLength(2);
    hook.rerender({ authenticated: true });
    expect(Socket.instances).toHaveLength(3);
  });
});
