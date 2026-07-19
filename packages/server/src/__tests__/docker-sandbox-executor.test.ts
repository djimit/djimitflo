import { describe, expect, it } from 'vitest';
import type { Task, ExecutionEventCreateInput } from '@djimitflo/shared';
import { ExecutionEventType, LogLevel } from '@djimitflo/shared';
import type { TaskExecutor, ExecutionSession, ExecutorKind, ExecutorOptions } from '../execution/types';
import {
  DockerSandboxExecutor,
  DEFAULT_SANDBOX_CONFIG,
  type DockerSandboxConfig,
} from '../execution/executors/docker-sandbox-executor';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-id',
    title: 'Test task',
    description: 'echo hello world',
    status: 'pending' as any,
    priority: 'medium' as any,
    risk_level: 'low' as any,
    execution_mode: 'local' as any,
    agent_id: null,
    parent_task_id: null,
    repository_id: null,
    instruction_profile_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    execution_time_ms: null,
    token_usage: null,
    tags: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const testConfig: DockerSandboxConfig = {
  image: 'test-image:latest',
  cpuLimit: '2.0',
  memoryLimit: '256m',
  networkMode: 'none',
  timeoutMs: 60000,
  readOnlyRoot: true,
  bindMounts: [],
};

/** Fast inner executor stub — MockExecutor sleeps between events, this one doesn't. */
class StubExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'mock';
  lastEnvironment: Record<string, string> | undefined;

  canExecute(task: Task): boolean {
    return task.risk_level !== ('critical' as any);
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    this.lastEnvironment = options?.environment;
    const events = (async function* (): AsyncIterable<ExecutionEventCreateInput> {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.LOG,
        message: 'inner event',
        level: LogLevel.INFO,
        metadata: {},
      };
    })();
    return {
      id: 'inner-session',
      taskId: task.id,
      executorKind: this.kind,
      status: 'running',
      startedAt: new Date(),
      events,
      result: Promise.resolve({ status: 'completed', message: 'inner done' }),
    };
  }
}

describe('DockerSandboxExecutor.buildDockerArgs', () => {
  it('applies resource limits, network isolation, and read-only root with tmpfs', () => {
    const args = DockerSandboxExecutor.buildDockerArgs('sandbox-1', testConfig, 'node', ['script.js']);

    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--name', 'sandbox-1']);
    expect(args).toContain('--cpus');
    expect(args[args.indexOf('--cpus') + 1]).toBe('2.0');
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('256m');
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--tmpfs');
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp:size=64m');
    // image, then command and its args, close the invocation
    expect(args.slice(-3)).toEqual(['test-image:latest', 'node', 'script.js']);
  });

  it('omits --read-only when readOnlyRoot is disabled', () => {
    const args = DockerSandboxExecutor.buildDockerArgs('sandbox-1', { ...testConfig, readOnlyRoot: false }, 'sh', []);
    expect(args).not.toContain('--read-only');
    expect(args).not.toContain('--tmpfs');
  });

  it('mounts the working directory rw at /workspace and applies extra bind mounts', () => {
    const config = {
      ...testConfig,
      bindMounts: [{ host: '/host/cache', container: '/cache', mode: 'ro' as const }],
    };
    const args = DockerSandboxExecutor.buildDockerArgs('sandbox-1', config, 'sh', [], '/host/project');

    expect(args).toContain('/host/project:/workspace:rw');
    expect(args).toContain('-w');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace');
    expect(args).toContain('/host/cache:/cache:ro');
  });

  it('forwards env vars but never the __-prefixed internal markers', () => {
    const args = DockerSandboxExecutor.buildDockerArgs('sandbox-1', testConfig, 'sh', [], undefined, {
      MY_VAR: 'value',
      __DOCKER_SANDBOX_ENABLED: 'true',
    });

    expect(args).toContain('MY_VAR=value');
    expect(args.join(' ')).not.toContain('__DOCKER_SANDBOX_ENABLED');
  });
});

describe('DockerSandboxExecutor wrapper', () => {
  // ponytail: dockerPath 'true' — cleanupContainer spawns a no-op instead of the docker CLI
  const makeSandbox = (inner: TaskExecutor) => new DockerSandboxExecutor(inner, testConfig, 'true');

  it('mirrors the inner executor kind and delegates canExecute', () => {
    const inner = new StubExecutor();
    const sandbox = makeSandbox(inner);

    expect(sandbox.kind).toBe('mock');
    expect(sandbox.canExecute(makeTask())).toBe(true);
    expect(sandbox.canExecute(makeTask({ risk_level: 'critical' as any }))).toBe(false);
  });

  it('marks the inner environment as sandboxed and brackets events with sandbox lifecycle', async () => {
    const inner = new StubExecutor();
    const sandbox = makeSandbox(inner);
    const task = makeTask();

    const session = await sandbox.start(task);
    expect(inner.lastEnvironment?.__DOCKER_SANDBOX_ENABLED).toBe('true');

    const events: ExecutionEventCreateInput[] = [];
    for await (const event of session.events) events.push(event);

    expect(events[0].message).toContain('Docker sandbox started');
    expect(events[0].metadata).toMatchObject({ sandbox: 'docker', image: 'test-image:latest', network: 'none' });
    expect(events[1].message).toBe('inner event');
    expect(events[events.length - 1].message).toContain('Docker sandbox cleaned up');
  });

  it('passes the inner result through', async () => {
    const sandbox = makeSandbox(new StubExecutor());
    const session = await sandbox.start(makeTask());
    const result = await session.result;

    expect(result.status).toBe('completed');
    expect(result.message).toBe('inner done');
  });
});

describe('DEFAULT_SANDBOX_CONFIG', () => {
  it('is default-deny on network and read-only on root', () => {
    expect(DEFAULT_SANDBOX_CONFIG.networkMode).toBe('none');
    expect(DEFAULT_SANDBOX_CONFIG.readOnlyRoot).toBe(true);
  });
});
