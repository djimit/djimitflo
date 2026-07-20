import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@djimitflo/shared';
import type { TaskExecutor } from '../execution/types';
import { DockerSandboxExecutor } from '../execution/executors/docker-sandbox-executor';

describe('DockerSandboxExecutor', () => {
  it('refuses execution before starting the unsandboxed inner executor', async () => {
    const start = vi.fn();
    const inner = {
      kind: 'mock',
      canExecute: () => true,
      start,
    } as unknown as TaskExecutor;
    const sandbox = new DockerSandboxExecutor(inner, undefined, 'docker-that-does-not-exist');

    await expect(sandbox.start({ id: 'task-1' } as Task)).rejects.toThrow('DOCKER_SANDBOX_UNAVAILABLE');
    expect(start).not.toHaveBeenCalled();
  });
});
