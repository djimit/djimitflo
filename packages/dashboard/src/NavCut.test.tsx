import { cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { App } from './App';
import { useAuthStore } from './lib/auth-store';

/**
 * IA nav cut (UX-30 + dashboard truth audit 2026-11-12): 37 menu items became 21. Every retired or merged URL redirects
 * to the page that now holds it, and every menu item names its page exactly: one h1 per page, equal to the nav label.
 */
class OfflineSocket { readyState = 3; onopen = null; onclose = null; onmessage = null; onerror = null; close() {} send() {} addEventListener() {} removeEventListener() {} }

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch (API down in the nav cut test)'); }));
  vi.stubGlobal('WebSocket', OfflineSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterEach(() => cleanup());

function renderAt(path: string) {
  useAuthStore.setState({ token: 'nav', user: { id: 'u1', email: 'nav@example.test', role: 'admin' } as never, isAuthenticated: true, isLoading: false, error: null, restoreSession: async () => undefined } as never);
  window.history.pushState({}, '', path);
  return render(<App />);
}

const REDIRECTS: Array<[string, string]> = [
  // retired
  ['/dashboard', '/'],
  ['/swarm', '/agents'],
  ['/economy', '/usage'],
  ['/explainers', '/repositories'],
  ['/cognitive', '/evolution'],
  ['/agi-reasoning', '/'],
  ['/predictive-analytics', '/improvement-funnel'],
  ['/consensus-debates', '/decisions'],
  ['/catalog', '/agents'],
  ['/federation', '/fleet'],
  ['/pipeline-builder', '/goals-loops'],
  // merged
  ['/self-healing', '/observability#health-checks'],
  ['/interaction-board', '/agent-commons?tab=interactions'],
  ['/fleet-cockpit', '/fleet?tab=workers'],
  ['/self-driving', '/configuration#runtime-tuned'],
  ['/swarm-resources', '/governance?tab=swarm'],
];

it.each(REDIRECTS)('nav cut: %s redirects to %s', async (from, to) => {
  renderAt(from);
  await waitFor(() => expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(to), { timeout: 5000 });
});

it.each([
  ['/self-healing', 'Health checks'],
  ['/interaction-board', 'Interaction Board'],
  ['/fleet-cockpit', 'Worker pool'],
  ['/self-driving', 'Runtime-tuned parameters'],
  ['/swarm-resources', 'Swarm safety and panels'],
  ['/decisions', 'Backlog and memory triage'],
])('nav cut: merged content of %s is on its new page (%s)', async (from, heading) => {
  renderAt(from);
  await waitFor(() => expect([...document.querySelectorAll('main h2')].map((h) => h.textContent?.trim())).toContain(heading), { timeout: 5000 });
});

it('nav cut: the menu has 21 items, each page has exactly one h1 and it equals the nav label', async () => {
  const home = renderAt('/');
  await waitFor(() => expect(home.container.querySelectorAll('nav[aria-label="Main"] a').length).toBeGreaterThan(0));
  const items = [...home.container.querySelectorAll('nav[aria-label="Main"] a')].map((a) => ({ to: a.getAttribute('href') ?? '', label: a.querySelector('span')?.textContent?.trim() ?? '' }));
  cleanup();
  expect(items).toHaveLength(21);
  const mismatches: string[] = [];
  for (const { to, label } of items) {
    const view = renderAt(to);
    try {
      await waitFor(() => expect(view.container.querySelector('main h1')).toBeTruthy(), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 0));
      const h1s = [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim() ?? '');
      if (h1s.length !== 1 || h1s[0] !== label) mismatches.push(`${to}: nav "${label}", h1 ${JSON.stringify(h1s)}`);
    } catch {
      mismatches.push(`${to}: no h1 in main`);
    } finally {
      cleanup();
    }
  }
  expect(mismatches).toEqual([]);
}, 120_000);
