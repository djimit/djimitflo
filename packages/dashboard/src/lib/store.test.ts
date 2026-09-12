import { afterEach, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { useStore } from './store';

afterEach(() => useStore.setState({ tasks: [] }));

it('keeps one task when REST and WebSocket deliver the same creation and preserves newer updates', () => {
  const task = { id: 'fixture', title: 'Created', status: 'pending' } as Task;
  useStore.getState().addTask(task);
  useStore.getState().updateTask(task.id, { status: 'running' });
  useStore.getState().addTask(task);
  expect(useStore.getState().tasks).toEqual([{ ...task, status: 'running' }]);
});
