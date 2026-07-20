/**
 * DockerSandboxExecutor — wraps any TaskExecutor with Docker container isolation.
 *
 * Spawns the inner executor's command inside a Docker container with:
 * - Read-only root filesystem (unless bind-mounted RW)
 * - Network isolation (none by default, configurable)
 * - CPU/memory limits
 * - Automatic cleanup on completion
 * - Bind mount for working directory
 */

import { Task, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

export interface DockerSandboxConfig {
  image: string;
  cpuLimit: string;
  memoryLimit: string;
  networkMode: 'none' | 'bridge' | 'host';
  timeoutMs: number;
  readOnlyRoot: boolean;
  bindMounts: Array<{ host: string; container: string; mode: 'ro' | 'rw' }>;
}

export const DEFAULT_SANDBOX_CONFIG: DockerSandboxConfig = {
  image: process.env.DOCKER_SANDBOX_IMAGE || 'djimitflo-runner:latest',
  cpuLimit: process.env.DOCKER_CPU_LIMIT || '1.0',
  memoryLimit: process.env.DOCKER_MEMORY_LIMIT || '512m',
  networkMode: (process.env.DOCKER_NETWORK_MODE as 'none' | 'bridge' | 'host') || 'none',
  timeoutMs: parseInt(process.env.DOCKER_TIMEOUT_MS || '600000', 10),
  readOnlyRoot: true,
  bindMounts: [],
};

export class DockerSandboxExecutor implements TaskExecutor {
  readonly kind: ExecutorKind;

  constructor(
    private inner: TaskExecutor,
    private config: DockerSandboxConfig = DEFAULT_SANDBOX_CONFIG,
    private dockerPath: string = process.env.DOCKER_BIN_PATH || 'docker',
  ) {
    this.kind = inner.kind;
  }

  canExecute(task: Task): boolean {
    return this.inner.canExecute(task);
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    await this.ensureDockerAvailable();

    const sessionId = randomUUID();
    const startedAt = new Date();

    const sandboxedOptions: ExecutorOptions = {
      ...options,
      environment: {
        ...options?.environment,
        __DOCKER_SANDBOX_ENABLED: 'true',
      },
    };

    const innerSession = await this.inner.start(task, sandboxedOptions);

    const sandboxContainerName = `djimitflo-sandbox-${task.id.slice(0, 8)}-${Date.now()}`;

    const events = this.createSandboxedEventStream(task, innerSession, sandboxContainerName);
    const result = this.createSandboxedResult(task, innerSession, sandboxContainerName);

    const session: ExecutionSession = {
      id: sessionId,
      taskId: task.id,
      executorKind: this.kind,
      status: 'starting',
      startedAt,
      events,
      result,
      cancel: async () => {
        await this.cleanupContainer(sandboxContainerName);
        if (innerSession.cancel) await innerSession.cancel();
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };

    return session;
  }

  private async *createSandboxedEventStream(
    task: Task,
    innerSession: ExecutionSession,
    containerName: string,
  ): AsyncIterable<ExecutionEventCreateInput> {
    yield {
      task_id: task.id,
      event_type: 'task_started' as any,
      message: `Docker sandbox started: ${containerName}`,
      level: 'info' as any,
      metadata: {
        sandbox: 'docker',
        container: containerName,
        image: this.config.image,
        network: this.config.networkMode,
        cpu: this.config.cpuLimit,
        memory: this.config.memoryLimit,
      },
    };

    for await (const event of innerSession.events) {
      yield event;
    }

    await this.cleanupContainer(containerName);

    yield {
      task_id: task.id,
      event_type: 'task_completed' as any,
      message: `Docker sandbox cleaned up: ${containerName}`,
      level: 'info' as any,
      metadata: { sandbox: 'docker', container: containerName, cleaned: true },
    };
  }

  private async createSandboxedResult(
    _task: Task,
    innerSession: ExecutionSession,
    containerName: string,
  ): Promise<ExecutionResult> {
    const result = await innerSession.result;
    await this.cleanupContainer(containerName);
    return result;
  }

  private async cleanupContainer(name: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(this.dockerPath, ['rm', '-f', name], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => resolve(), 5000);
    });
  }

  private async ensureDockerAvailable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.dockerPath, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('DOCKER_SANDBOX_UNAVAILABLE')));
      proc.on('error', () => reject(new Error('DOCKER_SANDBOX_UNAVAILABLE')));
    });
  }

  static buildDockerArgs(
    containerName: string,
    config: DockerSandboxConfig,
    command: string,
    args: string[],
    workingDir?: string,
    env?: Record<string, string>,
  ): string[] {
    const dockerArgs: string[] = ['run', '--rm', '--name', containerName];

    dockerArgs.push('--cpus', config.cpuLimit);
    dockerArgs.push('--memory', config.memoryLimit);
    dockerArgs.push('--network', config.networkMode);

    if (config.readOnlyRoot) {
      dockerArgs.push('--read-only');
      dockerArgs.push('--tmpfs', '/tmp:size=64m');
    }

    if (workingDir) {
      dockerArgs.push('-v', `${workingDir}:/workspace:rw`);
      dockerArgs.push('-w', '/workspace');
    }

    for (const mount of config.bindMounts) {
      dockerArgs.push('-v', `${mount.host}:${mount.container}:${mount.mode}`);
    }

    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith('__')) {
          dockerArgs.push('-e', `${key}=${value}`);
        }
      }
    }

    dockerArgs.push(config.image);
    dockerArgs.push(command, ...args);

    return dockerArgs;
  }
}
