import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FleetHostsPage } from './FleetHostsPage';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

// UX-4: actions are gated by role; these cases exercise them as an admin
beforeEach(() => { useAuthStore.setState({ user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never }); });

const cmd = (over: Record<string, unknown>) => ({ id: 'c1', host: 'workstation', kind: 'shell', command: 'systemctl restart foo', command_sha256: 'a'.repeat(64), status: 'pending_approval',
  requested_by: 'op', approved_by: null, approved_at: null, expires_at: null, decided_reason: null, started_at: null, finished_at: null, exit_code: null, output: null, created_at: '', ...over });
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getRuntimeHealth').mockResolvedValue({ runtimes: [] });
  vi.spyOn(api, 'getFleetHosts').mockResolvedValue({
    hosts: [{ host: 'workstation', last_seen: '', seconds_ago: 12, live: true, agent_version: '1', info: { os: 'linux', load: [1.2, 1.1, 1], disk_root_pct: 49, components: ['docker:deer-flow-gateway', 'user:hermes-gateway'] } }],
    commands: [cmd({}) as never, cmd({ id: 'c2', kind: 'diagnostic', command: 'uptime', status: 'done', exit_code: 0, output: 'up 3 days' }) as never],
  });
});

it('shows live hosts, approves the exact command hash and requests diagnostics', async () => {
  const approve = vi.spyOn(api, 'approveFleetCommand').mockResolvedValue(cmd({ status: 'queued' }) as never);
  const request = vi.spyOn(api, 'requestFleetCommand').mockResolvedValue(cmd({}) as never);
  render(<FleetHostsPage />);
  expect(await screen.findByText('live')).toBeTruthy();
  expect(screen.getByText('2 components')).toBeTruthy();
  expect(screen.getByText('deer-flow-gateway')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(approve).toHaveBeenCalledWith('c1', 'a'.repeat(64)));
  fireEvent.click(screen.getByRole('button', { name: 'disk' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('workstation', 'disk'));
  fireEvent.click(screen.getByRole('button', { name: 'Output' }));
  expect(screen.getByText('up 3 days')).toBeTruthy();
});
