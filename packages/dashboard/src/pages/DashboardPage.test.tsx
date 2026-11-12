import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { DashboardPage } from './DashboardPage';
import { useStore } from '../lib/store';
import { api } from '../lib/api';

vi.mock('../components/SpecComplianceWidget', () => ({ SpecComplianceWidget: () => null }));
vi.mock('../lib/api', () => ({ api: { getTasks: vi.fn(), getAgents: async () => ({ agents: [] }) } }));

afterEach(() => { cleanup(); vi.mocked(api.getTasks).mockReset(); useStore.setState({ tasks: [], agents: [] }); });

const recent = { id: 'fixture', title: 'Fixture task', description: 'Disposable test', status: 'failed', updated_at: new Date().toISOString() } as Task;

// Truth audit 2026-11-12: prod showed 87 completed / 13 failed (the first 100 rows) while the DB held 1,137 / 302
it('shows the server per-status totals, not counts over a loaded page', async () => {
  vi.mocked(api.getTasks).mockResolvedValue({ tasks: [recent], total: 1462, counts: { completed: 1137, failed: 302, cancelled: 17, paused: 7, running: 2, queued: 1 } });
  render(<DashboardPage />);
  expect(await screen.findByText((1137).toLocaleString())).toBeTruthy();
  expect(screen.getByText('302')).toBeTruthy();
  expect(screen.getByText(`of ${(1462).toLocaleString()} tasks`)).toBeTruthy();
  expect(screen.getByText('2 running now')).toBeTruthy();
  expect(screen.getByText('Task: Fixture task')).toBeTruthy();
  expect(api.getTasks).toHaveBeenCalledWith({ limit: 5, view: 'summary' });
});

it('shows loading instead of zeros while the totals are in flight, and re-reads them on live task events', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.getTasks>>) => void;
  vi.mocked(api.getTasks).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  render(<DashboardPage />);
  expect(screen.getAllByText('…')).toHaveLength(4);
  expect(screen.queryByText('No recent activity')).toBeNull();
  await act(async () => resolve({ tasks: [], total: 0, counts: {} }));
  expect(screen.getByText('No recent activity')).toBeTruthy();
  vi.mocked(api.getTasks).mockResolvedValue({ tasks: [], total: 1, counts: { running: 1 } });
  act(() => useStore.getState().addTask({ ...recent, status: 'running' }));
  await waitFor(() => expect(screen.getByText('1 running now')).toBeTruthy());
});

it('shows a failed totals read as an error, not as zero tasks', async () => {
  vi.mocked(api.getTasks).mockRejectedValue(new Error('upstream 502'));
  render(<DashboardPage />);
  expect((await screen.findByRole('alert')).textContent).toContain('task totals: upstream 502');
  expect(screen.getByText('Recent activity unavailable')).toBeTruthy();
});
