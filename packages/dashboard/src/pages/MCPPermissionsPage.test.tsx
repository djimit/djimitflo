import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';
import { MCPPermissionsPage } from './MCPPermissionsPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows effective status and unfiltered server tool counts', async () => {
  vi.spyOn(api, 'getMCPServers').mockResolvedValue({ servers: [{
    id: 'djimitflo-runtime',
    name: 'Runtime MCP',
    description: '',
    status: 'running',
    effective_status: 'catalog',
    status_stale: false,
    tool_count: 44,
    approval_gate_count: 3,
    command: '',
    args: [],
    env: {},
    version: null,
    author: null,
    url: null,
    last_ping_at: '2026-08-01T10:07:56Z',
    error_message: null,
    metadata: { synced_from: 'djimitflo_sync_mcp_catalog' },
    created_at: '2026-08-01T10:07:56Z',
    updated_at: '2026-08-01T10:07:56Z',
  }] as never });
  vi.spyOn(api, 'getMCPPermissions').mockResolvedValue({ permissions: [] });

  render(<MCPPermissionsPage />);

  expect(await screen.findByText('Catalog synced')).toBeTruthy();
  expect(screen.getByText(/Catalog synced: /)).toBeTruthy();
  expect(screen.getByText(/Registered tools: 44/)).toBeTruthy();
  expect(screen.getByText(/Marked requires approval \(not enforced\): 3/)).toBeTruthy();
  // AUTHZ-F7: the page says the decisions are a catalog, not an enforced control
  expect(screen.getByRole('note').textContent).toMatch(/Catalog only — not enforced/);
});

// L6-08: opening the page is a passive read; probing is an explicit, manage:config-gated button.
const STORED_SERVER = {
  id: 's5', name: 'Probed tool', description: '', status: 'running', effective_status: 'running', status_stale: false,
  tool_count: 0, approval_gate_count: 0, command: '', args: [], env: {}, version: null, author: null,
  url: 'http://tool.test/', last_ping_at: '2026-10-20T08:00:00.000Z', last_verified_at: '2026-10-20T08:00:00.000Z',
  error_message: null, metadata: {}, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-20T08:00:00.000Z',
};

function asRole(role: string) {
  useAuthStore.setState({ token: 't', user: { id: 'u1', email: 'u@example.test', role } as never, isAuthenticated: true } as never);
}

it('mount reads stored state only: no refresh, no POST, and shows the as-of time', async () => {
  asRole('admin');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes('/mcp/servers') ? { servers: [STORED_SERVER] } : { permissions: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  render(<MCPPermissionsPage />);

  expect(await screen.findByText('Probed tool', { selector: 'span' })).toBeTruthy();
  const calls = fetchSpy.mock.calls.map(([input, init]) => ({ url: String(input), method: (init?.method || 'GET').toUpperCase() }));
  expect(calls.some((c) => c.url.includes('/mcp/servers'))).toBe(true);
  expect(calls.filter((c) => /refresh/.test(c.url) || c.method !== 'GET')).toEqual([]);
  expect(screen.getByText(/Stored status, as of/)).toBeTruthy();
  expect(screen.getByRole('note').textContent).toMatch(/Catalog only — not enforced/);
});

it('refresh is an explicit button that probes and reports the scope', async () => {
  asRole('admin');
  vi.spyOn(api, 'getMCPServers').mockResolvedValue({ servers: [STORED_SERVER] as never });
  vi.spyOn(api, 'getMCPPermissions').mockResolvedValue({ permissions: [] });
  const refresh = vi.spyOn(api, 'refreshMCPServers').mockResolvedValue({
    servers: [STORED_SERVER] as never,
    refresh: { refreshed_at: '2026-10-24T09:00:00.000Z', probed: ['s5'], skipped: [{ id: 's1', reason: 'no_url' }] },
  });

  render(<MCPPermissionsPage />);
  await screen.findByText('Probed tool', { selector: 'span' });
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/Probed 1 server, skipped 1/)).toBeTruthy();
});

it('refresh is disabled without manage:config', async () => {
  asRole('viewer');
  vi.spyOn(api, 'getMCPServers').mockResolvedValue({ servers: [STORED_SERVER] as never });
  vi.spyOn(api, 'getMCPPermissions').mockResolvedValue({ permissions: [] });

  render(<MCPPermissionsPage />);
  await screen.findByText('Probed tool', { selector: 'span' });

  const button = screen.getByRole('button', { name: 'Refresh status' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe('Needs manage:config');
});
