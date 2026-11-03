import { cleanup, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_PERMISSIONS, UserRole } from '@djimitflo/shared';
import { App } from './App';
import { useAuthStore } from './lib/auth-store';
import { NAV_PERMISSIONS } from './lib/permissions';
import { PAGE_FIXTURES, SHELL_RESPONSES } from './test-utils/route-fixtures';
import { visibleText } from './test-utils/visible-text';

/**
 * W7: every page in the menu renders with the API down. It must show a heading and never reach the global error
 * boundary ("Something crashed") — a page that throws on a failed call, or on its empty state, fails CI.
 * jsdom instead of Playwright: no browser download in CI; add Playwright when a browser-only bug gets through.
 */
// browsers have ResizeObserver, jsdom does not (the pipeline canvas needs it)
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
class OfflineSocket { readyState = 3; onopen = null; onclose = null; onmessage = null; onerror = null; close() {} send() {} addEventListener() {} removeEventListener() {} }

// UXE-03: offline (API down) unless a test switches to fixtures, answered as `fixtureRole` would be by the server
let fixtureRole: UserRole | null = null;
let forbidden: string[] = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (!fixtureRole) throw new TypeError('Failed to fetch (API down in the route smoke)');
    return fixtureFetch(fixtureRole, String(input), (init?.method ?? 'GET').toUpperCase());
  }));
  vi.stubGlobal('WebSocket', OfflineSocket);
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.spyOn(console, 'error').mockImplementation(() => undefined); // pages log their failed calls; the assertions below decide
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterEach(() => cleanup());

function signIn(role: string = 'admin') {
  useAuthStore.setState({ token: 'smoke', user: { id: 'u1', email: 'smoke@example.test', role } as never, isAuthenticated: true, isLoading: false, error: null, restoreSession: async () => undefined } as never);
}

async function renderAt(path: string, role: string = 'admin') {
  signIn(role);
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

/**
 * UXE-03: role matrix. Pages come from the App.tsx route table, not from the rendered nav, so a page the nav hides is
 * still checked. Server permissions come from the route source (`scripts/route-source-inventory.mjs`, the same parse as
 * `ux-coverage.mjs`); the fixture fetch answers 403 exactly where the server's `requirePermission` would.
 */
const ROUTE_TABLE = [...readFileSync(join(__dirname, 'App.tsx'), 'utf8').matchAll(/<Route (?:index|path="([^"]+)") element=\{<(\w+)/g)]
  .filter(([, path, element]) => element !== 'Navigate' && element !== 'LoginPage' && path !== '*' && !path?.includes(':'))
  .map(([, path]) => (path ? `/${path}` : '/')).sort();
const ROLES = Object.values(UserRole);
const holds = (role: UserRole, permission: string) => ROLE_PERMISSIONS[role].includes(permission);
const EVERY_ROLE = ROLE_PERMISSIONS[UserRole.VIEWER].filter((p) => ROLES.every((role) => holds(role, p)));
const visibleFor = (role: UserRole) => ROUTE_TABLE.filter((path) => !NAV_PERMISSIONS[path] || holds(role, NAV_PERMISSIONS[path]));
// Admin panels inside an otherwise readable page; the page itself works. Reported in the UXE-03 PR, never extended silently.
const KNOWN_IN_PAGE_403 = [
  '/agent-commons: GET /api/swarm-v2/social/lures needs manage:tokens',
  '/agent-commons: GET /api/swarm-v2/social/join-requests needs manage:tokens',
];

type ServerRoute = { method: string; mounted_path: string; permissions: string[] };
let serverRoutes: ServerRoute[] = [];
let currentPage = '';
beforeAll(async () => {
  const { inventoryRouteSource } = await import('../../../scripts/route-source-inventory.mjs');
  serverRoutes = inventoryRouteSource(join(__dirname, '../../..')).mounted;
  serverRoutes.push({ method: 'GET', mounted_path: '/api/audit-logs', permissions: ['read:audit'] }); // router.use check, audit-logs.ts:54-56
});

/** The most specific mounted route for a request (literal segments beat `:params`). */
function serverRoute(method: string, path: string): ServerRoute | undefined {
  const parts = path.split('/');
  return serverRoutes
    .filter((r) => r.method === method && r.mounted_path.split('/').length === parts.length
      && r.mounted_path.split('/').every((segment, i) => segment.startsWith(':') || segment === parts[i]))
    .sort((a, b) => b.mounted_path.split('/').filter((x) => !x.startsWith(':')).length - a.mounted_path.split('/').filter((x) => !x.startsWith(':')).length)[0];
}
const extraPermissions = (call: string) => {
  const [method, path] = call.split(' ');
  return (serverRoute(method, path)?.permissions ?? []).filter((p) => !EVERY_ROLE.includes(p));
};

function fixtureFetch(role: UserRole, input: string, method: string): Response {
  const url = new URL(input, 'http://localhost');
  const call = `${method} ${url.pathname}`;
  const missing = (serverRoute(method, url.pathname)?.permissions ?? []).filter((p) => !holds(role, p));
  if (missing.length) {
    forbidden.push(`${currentPage}: ${call} needs ${missing.join(', ')}`);
    return new Response(JSON.stringify({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN', status: 403 } }), { status: 403 });
  }
  const body = PAGE_FIXTURES[currentPage]?.responses[call] ?? SHELL_RESPONSES[call];
  return body === undefined
    ? new Response(JSON.stringify({ error: { message: 'not in the route smoke fixtures', code: 'UNAVAILABLE', status: 503 } }), { status: 503 })
    : new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const navLinks = (container: HTMLElement) => [...container.querySelectorAll('nav[aria-label="Main"] a')].map((a) => a.getAttribute('href') ?? '').sort();

it('UXE-03: the route table, the page fixtures and the admin nav list the same pages', async () => {
  expect(ROUTE_TABLE.length).toBeGreaterThan(30);
  expect(Object.keys(PAGE_FIXTURES).sort()).toEqual(ROUTE_TABLE);
  expect(Object.keys(NAV_PERMISSIONS).filter((path) => !ROUTE_TABLE.includes(path))).toEqual([]);
  const admin = await renderAt('/');
  expect(navLinks(admin.container)).toEqual(ROUTE_TABLE);
});

it('UXE-03: NAV_PERMISSIONS mirror the server permission of each page\'s primary call; no role sees a 403 page or misses a permitted one', () => {
  const disagree = ROUTE_TABLE.flatMap((path) => {
    const { primary } = PAGE_FIXTURES[path];
    if (primary && !serverRoute(...(primary.split(' ') as [string, string]))) return [`${path}: ${primary} has no server route`];
    const server = primary ? extraPermissions(primary) : [];
    return server.join(', ') === (NAV_PERMISSIONS[path] ?? '') ? [] : [`${path}: ui ${NAV_PERMISSIONS[path] ?? 'none'}, server ${server.join(', ') || 'none'}`];
  });
  expect(disagree).toEqual([]);
  for (const role of ROLES) {
    const shown = visibleFor(role);
    const usable = (path: string) => extraPermissions(PAGE_FIXTURES[path].primary ?? 'GET /').every((p) => holds(role, p));
    expect({ role, visibleBut403: shown.filter((path) => !usable(path)) }).toEqual({ role, visibleBut403: [] });
    expect({ role, hiddenButPermitted: ROUTE_TABLE.filter((path) => !shown.includes(path) && usable(path)) }).toEqual({ role, hiddenButPermitted: [] });
  }
});

describe.each(ROLES)('UXE-03: role %s', (role) => {
  afterEach(() => { fixtureRole = null; currentPage = ''; });

  it('nav shows exactly the pages the role may use, and each renders a heading with the API down', async () => {
    const home = await renderAt('/', role);
    expect(navLinks(home.container)).toEqual(visibleFor(role));
    cleanup();
    const failures: string[] = [];
    for (const path of visibleFor(role)) {
      try {
        const view = await renderAt(path, role);
        if (view.container.textContent?.includes('Something crashed')) failures.push(`${path}: error boundary`);
      } catch (err) {
        failures.push(`${path}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      } finally {
        cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('on fixtures every visible page renders its h1 and a fixture value, and no call is refused', async () => {
    fixtureRole = role;
    forbidden = [];
    const failures: string[] = [];
    for (const path of visibleFor(role)) {
      currentPage = path;
      const { shows } = PAGE_FIXTURES[path];
      signIn(role);
      window.history.pushState({}, '', path);
      const view = render(<App />);
      const main = () => view.container.querySelector('main');
      try {
        await waitFor(() => {
          expect(main()?.querySelector('h1')?.textContent?.trim()).toMatch(/\w/);
          if (shows) expect(visibleText(main()!)).toContain(shows);
        }, { timeout: 5000 });
        if (view.container.textContent?.includes('Something crashed')) failures.push(`${path}: error boundary`);
      } catch {
        failures.push(`${path}: h1 "${main()?.querySelector('h1')?.textContent ?? ''}", fixture value ${JSON.stringify(shows)} not visible`);
      } finally {
        cleanup();
      }
    }
    expect(failures).toEqual([]);
    expect([...new Set(forbidden)].sort()).toEqual(holds(role, 'manage:tokens') ? [] : [...KNOWN_IN_PAGE_403].sort());
  }, 120_000);
});
