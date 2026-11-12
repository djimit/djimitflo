import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';
import { TaskDetailPage } from './TaskDetailPage';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

// Truth audit 2026-11-12: Tasks said "No tasks yet" while its data was still loading, filtered only the first 100 rows,
// and Task detail hid the executor failure reason behind a "failed" badge with a truncated id.
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => {}, isConnected: true }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); useStore.setState({ tasks: [], agents: [] }); });

const row = (id: string, status: string) => ({ id, title: `Task ${id}`, description: 'short', status, priority: 'medium', risk_level: 'low', execution_mode: 'review_only', tags: [], metadata: {}, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' });
const counts = { completed: 1137, failed: 302, cancelled: 17, paused: 7 };

it('shows Loading while the task list is in flight, never "No tasks yet"', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.getTasks>>) => void;
  vi.spyOn(api, 'getTasks').mockReturnValue(new Promise((r) => { resolve = r; }) as never);
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  expect(screen.getByText('Loading tasks…')).toBeTruthy();
  expect(screen.queryByText(/No tasks yet/)).toBeNull();
  await act(async () => resolve({ tasks: [row('a', 'failed') as never], total: 1463, counts }));
  expect(screen.getByText('Task a')).toBeTruthy();
  expect(screen.getByTestId('tasks-range').textContent).toBe(`Showing 1–1 of ${(1463).toLocaleString()}`);
});

it('shows a failed read as unavailable with the error, not as an empty task list', async () => {
  vi.spyOn(api, 'getTasks').mockRejectedValue(new Error('upstream 502'));
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('tasks: upstream 502');
  expect(screen.getByText(/Task list unavailable/)).toBeTruthy();
  expect(screen.queryByText(/No tasks yet/)).toBeNull();
});

it('filters by status (including cancelled and paused) and pages server-side', async () => {
  const getTasks = vi.spyOn(api, 'getTasks').mockResolvedValue({ tasks: Array.from({ length: 50 }, (_, i) => row(`t${i}`, 'completed')) as never, total: 1462, counts });
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  await screen.findByText('Task t0');
  expect(getTasks).toHaveBeenLastCalledWith({ status: undefined, q: undefined, limit: 50, offset: 0, view: 'summary' });
  expect(screen.getByRole('option', { name: 'Cancelled (17)' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Paused (7)' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
  fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'paused' } });
  await waitFor(() => expect(getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'paused', offset: 0 })));
});

it('task detail shows the executor failure reason, tokens and the full copyable id', async () => {
  const id = 'loop-worker-79272d20-f03f-4ef2-8a37-a6c44b7bcc5d-22fbe71d';
  vi.spyOn(api, 'getTask').mockResolvedValue({ ...row(id, 'failed'), token_usage: null, execution_time_ms: 600042,
    metadata: { executionResult: { status: 'failed', message: 'OpenCode execution error: OpenCode execution timed out after 600000ms', metrics: { tokenUsage: 30579 } } } } as never);
  vi.spyOn(api, 'getExecutionEvents').mockResolvedValue({ events: [] } as never);
  vi.spyOn(api, 'getApprovals').mockResolvedValue({ approvals: [] });
  vi.spyOn(api, 'getRuntimeContracts').mockResolvedValue({ runtimes: {} } as never);
  render(<MemoryRouter initialEntries={[`/tasks/${id}`]}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes></MemoryRouter>);
  const banner = await screen.findByTestId('task-failure');
  expect(banner.textContent).toContain('OpenCode execution timed out after 600000ms');
  expect(banner.textContent).toContain(`Tokens: ${(30579).toLocaleString()}`);
  expect(screen.getByTestId('task-id').textContent).toBe(id);
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
});
