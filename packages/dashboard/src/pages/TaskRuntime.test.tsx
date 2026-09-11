import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';
import { TaskDetailPage } from './TaskDetailPage';
import { AgentsPage } from './AgentsPage';
import { Layout } from '../components/Layout';
import { useStore } from '../lib/store';
import type { Agent } from '@djimitflo/shared';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe, isConnected: true }) }));

afterEach(() => { cleanup(); localStorage.clear(); useStore.setState({ tasks: [], agents: [] }); vi.unstubAllGlobals(); });

it('persists chosen model/reasoning at creation and executes the selected advertised runtime', async () => {
  localStorage.setItem('djimitflo_auth_session', 'fixture-session');
  let created: Record<string, unknown> = {};
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown;
    if (url.endsWith('/loops/runtime-contracts')) data = { runtimes: { mock: { available: true }, codex: { available: true }, opencode: { available: false } } };
    else if (url.endsWith('/repositories')) data = { repositories: [{ id: 'repo-fixture', name: 'Disposable task fixture', path: '/tmp/djimitflo-task-fixture' }] };
    else if (url.endsWith('/tasks') && options?.method === 'POST') {
      created = { ...JSON.parse(options.body as string), id: 'fixture-task', status: 'pending', risk_level: 'low', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      data = created;
    } else if (url.endsWith('/tasks/fixture-task')) data = created;
    else if (url.endsWith('/events')) data = { events: [] };
    else if (url.endsWith('/approvals')) data = { approvals: [] };
    else if (url.endsWith('/execute')) data = { status: 'started', executor: 'codex' };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => data };
  });
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter initialEntries={['/tasks']}><Routes>
    <Route path="/tasks" element={<TasksPage />} />
    <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
  </Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
  await screen.findByRole('option', { name: 'codex' });
  fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Astra fixture' } });
  fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'Controlled local check' } });
  fireEvent.change(await screen.findByLabelText('Task repository'), { target: { value: 'repo-fixture' } });
  fireEvent.change(screen.getByLabelText('Task runtime'), { target: { value: 'codex' } });
  fireEvent.change(screen.getByLabelText('Task model'), { target: { value: 'gpt-6-astra' } });
  fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'max' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
  fireEvent.click(await screen.findByText('Astra fixture'));
  const execute = await screen.findByRole('button', { name: 'Execute' });
  await waitFor(() => expect((execute as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Execution runtime') as HTMLSelectElement).value).toBe('codex');
  expect(screen.getByText('Model: gpt-6-astra · Reasoning: max')).toBeTruthy();
  expect(created.repository_id).toBe('repo-fixture');
  expect(created.metadata).toEqual({ executor: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max', workingDirectory: '/tmp/djimitflo-task-fixture' });
  fireEvent.click(execute);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/fixture-task/execute', expect.objectContaining({ method: 'POST', body: JSON.stringify({ executor: 'codex' }) })));
});

it.each(['paused', 'queued'])('blocks recovery-held %s tasks without claiming the provider stopped', async (status) => {
  const fetch = vi.fn(async (url: string) => {
    let data: unknown;
    if (url.endsWith('/loops/runtime-contracts')) data = { runtimes: { codex: { available: true } } };
    else if (url.endsWith('/tasks/held-task')) data = { id: 'held-task', title: 'Interrupted provider', status, priority: 'medium', risk_level: 'low', execution_mode: 'review_only', tags: [], metadata: { executor: 'codex', execution_recovery_hold: true } };
    else if (url.endsWith('/events')) data = { events: [] };
    else if (url.endsWith('/approvals')) data = { approvals: [{ id: 'approved-fixture', task_id: 'held-task', status: 'approved', title: 'Review local audit artifact', risk_level: 'low', request_type: 'high_risk_action', request_message: 'Manual review', request_data: {}, approved_by: null }] };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => data };
  });
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter initialEntries={['/tasks/held-task']}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes></MemoryRouter>);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('provider outcome is unknown and the provider may still be running');
  const execute = screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement;
  expect(execute.disabled).toBe(true);
  fireEvent.click(execute);
  const cancel = screen.queryByRole('button', { name: 'Cancel' }) as HTMLButtonElement | null;
  if (status === 'queued') {
    expect(cancel?.disabled).toBe(true);
    fireEvent.click(cancel!);
  }
  expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/tasks/held-task/review');
  expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('heading', { name: 'Approvals', exact: true })).toBeTruthy();
  expect(screen.getByText('Review local audit artifact')).toBeTruthy();
  expect(screen.queryByText('High Risk Action')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/execute') || url.endsWith('/cancel'))).toBe(false);
});

it('shows failed repository discovery and retries without silently selecting a working directory', async () => {
  let repositoryAttempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/loops/runtime-contracts')) return { ok: true, status: 200, json: async () => ({ runtimes: {} }) };
    if (url.endsWith('/repositories')) {
      repositoryAttempts++;
      return repositoryAttempts === 1
        ? { ok: false, status: 503, json: async () => ({ error: { message: 'Repository store unavailable' } }) }
        : { ok: true, status: 200, json: async () => ({ repositories: [{ id: 'fixture', name: 'Fixture', path: '/tmp/fixture' }] }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'New Task' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Repository store unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry repositories' }));
  await screen.findByRole('option', { name: 'Fixture — /tmp/fixture' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByLabelText('Task repository') as HTMLSelectElement).value).toBe('');
  expect(screen.getByText(/execution uses the server\/runtime default directory/)).toBeTruthy();
});

it('shows the selected existing agent through the Swarm detail-link route', () => {
  useStore.setState({ agents: [
    { id: 'one', name: 'Agent one', description: '', status: 'idle', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 },
    { id: 'two', name: 'Agent two', description: '', status: 'idle', capabilities: [], total_tasks: 0, completed_tasks: 0, failed_tasks: 0 },
  ] as Agent[] });
  render(<MemoryRouter initialEntries={['/agents/two']}><Routes><Route path="/agents/:agentId" element={<AgentsPage />} /></Routes></MemoryRouter>);
  expect(screen.getByText('Agent two')).toBeTruthy();
  expect(screen.queryByText('Agent one')).toBeNull();
  expect(screen.getByRole('link', { name: 'All agents' }).getAttribute('href')).toBe('/agents');
});

it('makes previously unlinked research and evidence pages reachable from navigation', () => {
  render(<MemoryRouter><Layout /></MemoryRouter>);
  fireEvent.click(screen.getByText('Research & evidence'));
  for (const path of ['/authority', '/audit/logs', '/pipeline-builder', '/agi-reasoning', '/consensus-debates', '/predictive-analytics', '/self-healing', '/explainers']) {
    expect(document.querySelector(`a[href="${path}"]`)).toBeTruthy();
  }
});
