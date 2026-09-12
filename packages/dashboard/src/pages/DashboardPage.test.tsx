import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { DashboardPage } from './DashboardPage';
import { useStore } from '../lib/store';

vi.mock('../components/SpecComplianceWidget', () => ({ SpecComplianceWidget: () => null }));
vi.mock('../lib/api', () => ({ api: { getTasks: async () => ({ tasks: [] }), getAgents: async () => ({ agents: [] }) } }));

afterEach(() => { cleanup(); useStore.setState({ tasks: [], agents: [] }); });

it('renders the real store without recursive updates and reflects task transitions', () => {
  const task = { id: 'fixture', title: 'Fixture task', description: 'Disposable test', status: 'running', updated_at: new Date().toISOString() } as Task;
  useStore.setState({ tasks: [task] });
  render(<DashboardPage />);
  expect(screen.getByText('1 running now')).toBeTruthy();
  act(() => useStore.getState().updateTask(task.id, { status: 'completed' }));
  expect(screen.getByText('0 running now')).toBeTruthy();
  expect(screen.getByText('1 successful')).toBeTruthy();
  act(() => useStore.getState().updateTask(task.id, { status: 'pending' }));
  expect(screen.getByText('0 running now')).toBeTruthy();
  expect(screen.getByText('1 pending')).toBeTruthy();
});
