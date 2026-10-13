import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { AUTH_SESSION_KEY, useAuthStore } from './lib/auth-store';
import { api } from './lib/api';
import { OperatorCockpitPage } from './pages/OperatorCockpitPage';
import { WsContext } from './components/WebSocketProvider';
import { WebSocketEventType, type WebSocketMessage } from '@djimitflo/shared';

class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
let sockets = 0;
class CountingSocket { static OPEN = 1; readyState = 0; onopen = null; onclose = null; onmessage = null; onerror = null; constructor() { sockets += 1; } close() {} send() {} addEventListener() {} removeEventListener() {} }

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => { sockets = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

function signIn() {
  localStorage.setItem(AUTH_SESSION_KEY, 'ux3-token');
  useAuthStore.setState({ token: 'ux3-token', user: { id: 'u1', email: 'ux3@example.test', role: 'admin' } as never, isAuthenticated: true, isLoading: false, error: null, restoreSession: async () => undefined } as never);
}

it.each(['/swarm', '/fleet-cockpit', '/tasks/t1', '/swarm-mission-control/proof-runs/p1'])('UX-3: rendering %s opens exactly one WebSocket for the session', async (path) => {
  vi.stubGlobal('WebSocket', CountingSocket);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('API down'); }));
  signIn();
  window.history.pushState({}, '', path);
  const view = render(<App />);
  await waitFor(() => expect(view.container.querySelector('main h1, main h2, main [role="alert"]')).toBeTruthy(), { timeout: 5000 });
  // the provider opens its socket in an effect: wait for it (CI Node 22 once counted 0), then make sure no second one follows
  await waitFor(() => expect(sockets).toBe(1), { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  expect(sockets).toBe(1);
});

it('UX-3: an unknown path renders a 404 page with a link home', async () => {
  vi.stubGlobal('WebSocket', CountingSocket);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('API down'); }));
  signIn();
  window.history.pushState({}, '', '/no-such-page');
  render(<App />);
  expect(await screen.findByText('Page not found')).toBeTruthy();
  expect(screen.getByRole('link', { name: /back to the cockpit/i }).getAttribute('href')).toBe('/');
});

const cockpit = { at: '2026-10-05T20:00:00Z', build: { commit: null, build_time: null }, scorecard: {}, guardrails: [], stalls: [], gym: [], remote_workers: [], maker_usage_7d: [], judgments_7d: [], deploys: [] };

it('UX-3: the cockpit refetches on its interval and on an approval message, and says how fresh it is', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(api, 'getServiceMap').mockResolvedValue({ services: [] });
  const get = vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue(cockpit as never);
  const handlers = new Map<string, (m: WebSocketMessage) => void>();
  const subscribe = (type: string, h: (m: WebSocketMessage) => void) => { handlers.set(type, h); return () => handlers.delete(type); };
  render(<WsContext.Provider value={{ subscribe: subscribe as never, isConnected: true }}><MemoryRouter><OperatorCockpitPage /></MemoryRouter></WsContext.Provider>);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/updated \d+ s ago/)).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(30_000); });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await act(async () => { handlers.get(WebSocketEventType.APPROVAL_REQUESTED)?.({ type: WebSocketEventType.APPROVAL_REQUESTED, payload: {}, timestamp: '' } as WebSocketMessage); });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
});

it('UX-3: a banner says when the live connection is down', async () => {
  vi.spyOn(api, 'getServiceMap').mockResolvedValue({ services: [] });
  vi.spyOn(api, 'getOperatorCockpit').mockResolvedValue(cockpit as never);
  const { ConnectionBanner } = await import('./components/WebSocketProvider');
  const { rerender } = render(<WsContext.Provider value={{ subscribe: (() => () => undefined) as never, isConnected: false }}><ConnectionBanner graceMs={0} /></WsContext.Provider>);
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/live updates are off/i);
  rerender(<WsContext.Provider value={{ subscribe: (() => () => undefined) as never, isConnected: true }}><ConnectionBanner graceMs={0} /></WsContext.Provider>);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});
