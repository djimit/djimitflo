import { describe, expect, it } from 'vitest';
import { MockExecutor } from '../execution/executors/mock-executor';
import type { Task } from '@djimitflo/shared';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1',
    title: 'Test task',
    description: 'A test task',
    status: 'pending',
    priority: 'medium',
    metadata: {},
    ...overrides,
  } as unknown as Task;
}

describe('MockExecutor', () => {
  it('should create an instance', () => {
    const executor = new MockExecutor();
    expect(executor).toBeDefined();
  });

  it('should have mock kind', () => {
    const executor = new MockExecutor();
    expect(executor.kind).toBe('mock');
  });

  it('should accept any task', () => {
    const executor = new MockExecutor();
    const task = createTask();
    expect(executor.canExecute(task)).toBe(true);
  });

  it('should start a session', async () => {
    const executor = new MockExecutor();
    const task = createTask();
    const session = await executor.start(task);

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.taskId).toBe(task.id);
    expect(session.executorKind).toBe('mock');
    expect(session.status).toBe('running');
  });

  it('should cancel a session', async () => {
    const executor = new MockExecutor();
    const task = createTask();
    const session = await executor.start(task);

    await session.cancel();
    expect(session.status).toBe('cancelled');
    expect(session.completedAt).toBeDefined();
  });

  it('should handle task with high priority', () => {
    const executor = new MockExecutor();
    const task = createTask({ priority: 'high' });
    expect(executor.canExecute(task)).toBe(true);
  });

  it('should handle task with metadata', () => {
    const executor = new MockExecutor();
    const task = createTask({ metadata: { runtime: 'mock', test: true } });
    expect(executor.canExecute(task)).toBe(true);
  });

  it('should handle task with low priority', () => {
    const executor = new MockExecutor();
    const task = createTask({ priority: 'low' });
    expect(executor.canExecute(task)).toBe(true);
  });

  it('should handle task with critical priority', () => {
    const executor = new MockExecutor();
    const task = createTask({ priority: 'critical' });
    expect(executor.canExecute(task)).toBe(true);
  });
});
