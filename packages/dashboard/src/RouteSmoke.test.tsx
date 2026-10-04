import { cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { App } from './App';
import { useAuthStore } from './lib/auth-store';

/**
 * W7: every page in the menu renders with the API down. It must show a heading and never reach the global error
 * boundary ("Something crashed") — a page that throws on a failed call, or on its empty state, fails CI.
 * jsdom instead of Playwright: no browser download in CI; add Playwright when a browser-only bug gets through.
 */
// browsers have ResizeObserver, jsdom does not (the pipeline canvas needs it)
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
class OfflineSocket { readyState = 3; onopen = null; onclose = null; onmessage = null; onerror = null; close() {} send() {} addEventListener() {} removeEventListener() {} }

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch (API down in the route smoke)'); }));
  vi.stubGlobal('WebSocket', OfflineSocket);
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // pages log their failed calls; the assertions below decide
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterEach(() => cleanup());

function signIn() {
  useAuthStore.setState({ token: 'smoke', user: { id: 'u1', email: 'smoke@example.test', role: 'admin' } as never, isAuthenticated: true, isLoading: false, error: null, restoreSession: async () => undefined } as never);
}

async function renderAt(path: string) {
  signIn();
  window.history.pushState({}, '', path);
  const view = render(<App />);
  await waitFor(() => expect(view.container.querySelector('main h1, main h2')).toBeTruthy(), { timeout: 5000 });
  return view;
}

it('W7: every menu page renders a heading with the API down, and none crashes', async () => {
  const home = await renderAt('/');
  const paths = [...new Set([...home.container.querySelectorAll('nav a')].map((a) => a.getAttribute('href')).filter((h): h is string => !!h))];
  cleanup();
  expect(paths.length).toBeGreaterThan(30);
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const view = await renderAt(path);
      if (view.container.textContent?.includes('Something crashed')) failures.push(`${path}: error boundary`);
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    } finally {
      cleanup();
    }
  }
  expect(failures).toEqual([]);
}, 120_000);
