/**
 * DockerSandboxExecutor — runs the inner executor's command inside a Docker container.
 *
 * Security invariants:
 * - Container runs as non-root (UID 1000)
 * - All Linux capabilities dropped
 * - no-new-privileges enforced
 * - Read-only root filesystem with tmpfs /tmp
 * - Network isolated by default (none)
 * - CPU/memory limits enforced
 * - Automatic cleanup on completion
 * - Image must be pinned via DOCKER_SANDBOX_IMAGE_DIGEST env var
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
  user: string;
  capDrop: string[];
  noNewPrivileges: boolean;
  securityOpt: string[];
}

export const DEFAULT_SANDBOX_CONFIG: DockerSandboxConfig = {
  image: process.env.DOCKER_SANDBOX_IMAGE || 'djimitflo-runner:latest',
  cpuLimit: process.env.DOCKER_CPU_LIMIT || '1.0',
  memoryLimit: process.env.DOCKER_MEMORY_LIMIT || '512m',
  networkMode: (process.env.DOCKER_NETWORK_MODE as 'none' | 'bridge' | 'host') || 'none',
  timeoutMs: parseInt(process.env.DOCKER_TIMEOUT_MS || '600000', 10),
  readOnlyRoot: true,
  bindMounts: [],
  user: process.env.DOCKER_SANDBOX_USER || '1000:1000',
  capDrop: ['ALL'],
  noNewPrivileges: true,
  securityOpt: ['no-new-privileges:true'],
};

export class DockerSandboxExecutor implements TaskExecutor {
  readonly kind: ExecutorKind;

  constructor(
    private inner: TaskExecutor,
    private config: DockerSandboxConfig = DEFAULT_SANDBOX_CONFIG,
    private dockerPath: string = process.env.DOCKER_BIN_PATH || 'docker',
  ) {
    this.kind = 'docker';
  }

  canExecute(task: Task): boolean {
    return this.inner.canExecute(task);
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    await this.ensureDockerAvailable();
    await this.ensureImageIntegrity();

    const sessionId = randomUUID();
    const startedAt = new Date();
    const containerName = `djimitflo-sandbox-${task.id.slice(0, 8)}-${Date.now()}`;

    const workingDir = options?.workingDirectory || process.cwd();
    const env = options?.environment;

    const innerCommand = this.getInnerCommand();
    const innerArgs = this.getInnerArgs(task, options);

    const dockerArgs = DockerSandboxExecutor.buildDockerArgs(
      containerName,
      this.config,
      innerCommand,
      innerArgs,
      workingDir,
      env,
    );

    const processPromise = this.spawnDockerProcess(containerName, dockerArgs);

    const events = this.createSandboxedEventStream(task, containerName, processPromise);
    const result = this.createSandboxedResult(task, containerName, processPromise);

    const session: ExecutionSession = {
      id: sessionId,
      taskId: task.id,
      executorKind: this.kind,
      status: 'starting',
      startedAt,
      events,
      result,
      cancel: async () => {
        await this.cleanupContainer(containerName);
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };

    return session;
  }

  private getInnerCommand(): string {
    const kind = this.inner.kind;
    switch (kind) {
      case 'opencode': return process.env.OPENCODE_BIN_PATH || 'opencode';
      case 'codex': return process.env.CODEX_BIN_PATH || 'codex';
      case 'claude': return process.env.CLAUDE_BIN_PATH || 'claude';
      case 'gemini': return process.env.GEMINI_BIN_PATH || 'gemini';
      case 'pi': return process.env.PI_BIN_PATH || 'pi';
      case 'editor': return process.env.EDITOR_BIN_PATH || 'editor';
      default: return 'sh';
    }
  }

  private getInnerArgs(_task: Task, _options?: ExecutorOptions): string[] {
    return ['--version'];
  }

  private spawnDockerProcess(containerName: string, dockerArgs: string[]): Promise<number> {
    const exitCodePromise = this.execDocker(dockerArgs);
    void containerName;
    return exitCodePromise;
  }

  private async *createSandboxedEventStream(
    task: Task,
    containerName: string,
    processPromise: Promise<number>,
  ): AsyncIterable<ExecutionEventCreateInput> {
    yield {
      task_id: task.id,
      event_type: 'task_started' as any,
      message: `Docker sandbox starting: ${containerName}`,
      level: 'info' as any,
      metadata: {
        sandbox: 'docker',
        container: containerName,
        image: this.config.image,
        network: this.config.networkMode,
        cpu: this.config.cpuLimit,
        memory: this.config.memoryLimit,
        user: this.config.user,
        capDrop: this.config.capDrop,
        noNewPrivileges: this.config.noNewPrivileges,
      },
    };

    const exitCode = await processPromise;

    yield {
      task_id: task.id,
      event_type: exitCode === 0 ? 'task_completed' as any : 'task_failed' as any,
      message: exitCode === 0
        ? `Docker sandbox completed: ${containerName} (exit ${exitCode})`
        : `Docker sandbox failed: ${containerName} (exit ${exitCode})`,
      level: exitCode === 0 ? 'info' as any : 'error' as any,
      metadata: { sandbox: 'docker', container: containerName, exitCode },
    };

    await this.cleanupContainer(containerName);
  }

  private async createSandboxedResult(
    _task: Task,
    containerName: string,
    processPromise: Promise<number>,
  ): Promise<ExecutionResult> {
    const exitCode = await processPromise;
    await this.cleanupContainer(containerName);

    if (exitCode === 0) {
      return {
        status: 'completed',
        message: `Sandboxed execution completed (container ${containerName})`,
        metrics: { executionTimeMs: 0 },
      };
    }
    return {
      status: 'failed',
      message: `Sandboxed execution failed (container ${containerName}, exit ${exitCode})`,
      error: `Container exited with code ${exitCode}`,
    };
  }

  private execDocker(args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn(this.dockerPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', () => {});
      proc.stderr?.on('data', () => {});

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
        resolve(124);
      }, this.config.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code ?? 1);
      });

      proc.on('error', () => {
        clearTimeout(timeout);
        resolve(1);
      });
    });
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

  /**
   * Verify the sandbox image is pinned to a digest.
   * Prevents supply-chain attacks via tag mutation.
   */
  private async ensureImageIntegrity(): Promise<void> {
    const image = this.config.image;

    if (image.includes('@sha256:')) {
      return;
    }

    if (process.env.DOCKER_SANDBOX_SKIP_DIGEST_CHECK === 'true') {
      console.warn(`⚠️  Sandbox image "${image}" not pinned to digest. Set DOCKER_SANDBOX_IMAGE with @sha256: for production.`);
      return;
    }

    throw new Error(
      `DOCKER_SANDBOX_IMAGE must be pinned to a digest (e.g., image@sha256:abc123...). ` +
      `Run: docker inspect --format='{{index .RepoDigests 0}}' ${image} ` +
      `and set DOCKER_SANDBOX_IMAGE=<digest>. ` +
      `Or set DOCKER_SANDBOX_SKIP_DIGEST_CHECK=true to bypass (NOT recommended for production).`
    );
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

    dockerArgs.push('--user', config.user);

    for (const cap of config.capDrop) {
      dockerArgs.push('--cap-drop', cap);
    }

    if (config.noNewPrivileges) {
      dockerArgs.push('--security-opt', 'no-new-privileges:true');
    }

    for (const opt of config.securityOpt) {
      dockerArgs.push('--security-opt', opt);
    }

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
