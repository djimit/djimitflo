import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
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
  expect(screen.getByText(/Approval gates: 3/)).toBeTruthy();
});
