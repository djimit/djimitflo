/**
 * Hermes CLI executor.
 *
 * Uses Hermes' programmatic chat surface rather than `hermes -z`: the latter
 * explicitly bypasses approvals. Djimitflo remains the approval boundary and
 * only an operator-armed skipPermissions request may add `--yolo`.
 */

import { randomUUID } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Task, ExecutionEventType, LogLevel, type ExecutionEventCreateInput } from '@djimitflo/shared';
import { captureExecutorOutput } from '../executor-output';
import type { ExecutionResult, ExecutionSession, ExecutorKind, ExecutorOptions, TaskExecutor } from '../types';
import { buildExecutorEnv } from './executor-env';
import { runtimeProcessClosed, stopRuntimeProcess } from './runtime-process';

export class HermesExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'hermes';
  private readonly hermesPath: string;
  private readonly executionTimeoutMs: number;
  private readonly runtimeIdentity: string;

  constructor(hermesPath?: string) {
    this.hermesPath = hermesPath || process.env.HERMES_BIN_PATH || 'hermes';
    this.executionTimeoutMs = Number(process.env.HERMES_EXECUTION_TIMEOUT_MS || 600_000);
    const probe = spawnSync(this.hermesPath, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    const version = (probe.stdout || '').trim().split(/\r?\n/)[0];
    this.runtimeIdentity = version ? `${this.hermesPath}@${version}` : this.hermesPath;
  }

  canExecute(_task: Task): boolean { return true; }

  buildCommand(task: Task, options?: ExecutorOptions): { command: string; args: string[] } {
    const args = ['chat', '-q', task.description, '--oneshot', '--quiet'];
    if (options?.model) args.push('--model', options.model);
    if (options?.skipPermissions) args.push('--yolo');
    return { command: this.hermesPath, args };
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();
    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const args = this.buildCommand(task, options).args;

    const spawnProcess = () => {
      if (session.status === 'cancelled') { resolveClosed(); emitter.emit('exit', null); return; }
      const child = spawn(this.hermesPath, args, {
        cwd: options?.workingDirectory || process.cwd(),
        env: buildExecutorEnv(options?.environment),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      childProcess = child;
      void runtimeProcessClosed(child).then(resolveClosed);
      const timeoutMs = options?.timeout ?? this.executionTimeoutMs;
      const timeout = setTimeout(() => {
        stopRuntimeProcess(child);
        emitter.emit('error', new Error(`Hermes execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref();
      child.stdout?.on('data', data => emitter.emit('output', data.toString(), 'stdout'));
      child.stderr?.on('data', data => emitter.emit('output', data.toString(), 'stderr'));
      child.on('close', code => { clearTimeout(timeout); emitter.emit('exit', code); });
      child.on('error', error => emitter.emit('error', error));
    };

    const events = this.createEventStream(task, emitter, spawnProcess, Boolean(options?.skipPermissions));
    const result = this.createResultPromise(emitter);
    const session: ExecutionSession = {
      id: sessionId,
      taskId: task.id,
      executorKind: this.kind,
      status: 'starting',
      startedAt,
      events,
      result,
      closed,
      cancel: async () => {
        session.status = 'cancelled';
        await stopRuntimeProcess(childProcess);
        if (!childProcess) resolveClosed();
        session.completedAt = new Date();
      },
    };
    return session;
  }

  private async *createEventStream(
    task: Task,
    emitter: EventEmitter,
    spawnProcess: () => void,
    skipPermissions: boolean,
  ): AsyncIterable<ExecutionEventCreateInput> {
    spawnProcess();
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TASK_STARTED,
      message: 'Hermes execution started',
      level: LogLevel.INFO,
      metadata: {
        executor: 'hermes',
        runtime_identity: this.runtimeIdentity,
        skip_permissions: skipPermissions,
        output_mode: 'plain',
        usage_source: 'unavailable',
        provenance_status: 'partial',
      },
    };

    const queue: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const errors: Error[] = [];
    let exitCode: number | null | undefined;
    let wake: (() => void) | null = null;
    emitter.on('output', (text: string, stream: 'stdout' | 'stderr') => { queue.push({ text, stream }); wake?.(); wake = null; });
    emitter.on('error', (error: Error) => { errors.push(error); wake?.(); wake = null; });
    emitter.on('exit', (code: number | null) => { exitCode = code; wake?.(); wake = null; });

    while (exitCode === undefined || queue.length > 0 || errors.length > 0) {
      if (queue.length === 0 && errors.length === 0 && exitCode === undefined) {
        await new Promise<void>(resolve => { wake = resolve; });
      }
      while (errors.length > 0) {
        const error = errors.shift()!;
        yield { task_id: task.id, event_type: ExecutionEventType.ERROR, message: `Hermes process error: ${error.message}`, level: LogLevel.ERROR, metadata: { executor: 'hermes' } };
      }
      while (queue.length > 0) {
        const { text, stream } = queue.shift()!;
        for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
          yield {
            task_id: task.id,
            event_type: stream === 'stderr' ? ExecutionEventType.ERROR : ExecutionEventType.LOG,
            message: line,
            level: stream === 'stderr' ? LogLevel.ERROR : LogLevel.INFO,
            metadata: { executor: 'hermes', parsing_mode: 'plain' },
          };
        }
      }
    }
    yield {
      task_id: task.id,
      event_type: exitCode === 0 ? ExecutionEventType.TASK_COMPLETED : ExecutionEventType.TASK_FAILED,
      message: exitCode === 0 ? 'Hermes execution completed successfully' : `Hermes execution failed with exit code ${exitCode}`,
      level: exitCode === 0 ? LogLevel.INFO : LogLevel.ERROR,
      metadata: {
        executor: 'hermes',
        runtime_identity: this.runtimeIdentity,
        exit_code: exitCode,
        usage_source: 'unavailable',
        provenance_status: 'partial',
      },
    };
  }

  private async createResultPromise(emitter: EventEmitter): Promise<ExecutionResult> {
    const output = captureExecutorOutput(emitter);
    return new Promise(resolve => {
      emitter.once('exit', (code: number) => resolve(code === 0
        ? { status: 'completed', message: 'Hermes execution completed successfully', metrics: { executionTimeMs: 0 }, ...output() }
        : { status: 'failed', message: `Hermes execution failed with exit code ${code}`, error: `Process exited with code ${code}`, metrics: { executionTimeMs: 0 }, ...output() }));
      emitter.once('error', (error: Error) => resolve({ status: 'failed', message: `Hermes execution error: ${error.message}`, error: error.stack, metrics: { executionTimeMs: 0 }, ...output() }));
    });
  }
}
