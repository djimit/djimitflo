/**
 * Hermes CLI executor.
 *
 * Uses Hermes' programmatic chat surface rather than `hermes -z`: the latter
 * explicitly bypasses approvals. Djimitflo remains the approval boundary and
 * only an operator-armed skipPermissions request may add `--yolo`.
 */

import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Task, ExecutionEventType, LogLevel, type ExecutionEventCreateInput } from '@djimitflo/shared';
import { captureExecutorOutput } from '../executor-output';
import type { ExecutionResult, ExecutionSession, ExecutorKind, ExecutorOptions, TaskExecutor } from '../types';
import { buildExecutorEnv } from './executor-env';

export class HermesExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'hermes';
  private readonly hermesPath: string;
  private readonly executionTimeoutMs: number;

  constructor(hermesPath?: string) {
    this.hermesPath = hermesPath || process.env.HERMES_BIN_PATH || 'hermes';
    this.executionTimeoutMs = Number(process.env.HERMES_EXECUTION_TIMEOUT_MS || 600_000);
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
    const args = this.buildCommand(task, options).args;

    const spawnProcess = () => {
      const child = spawn(this.hermesPath, args, {
        cwd: options?.workingDirectory || process.cwd(),
        env: buildExecutorEnv(options?.environment),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      childProcess = child;
      const timeoutMs = options?.timeout ?? this.executionTimeoutMs;
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM');
        emitter.emit('error', new Error(`Hermes execution timed out after ${timeoutMs}ms`));
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5_000).unref();
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
      cancel: async () => {
        if (childProcess && !childProcess.killed) childProcess.kill('SIGTERM');
        session.status = 'cancelled';
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
      metadata: { executor: 'hermes', skip_permissions: skipPermissions, output_mode: 'plain' },
    };

    const queue: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const errors: Error[] = [];
    let exitCode: number | null = null;
    let wake: (() => void) | null = null;
    emitter.on('output', (text: string, stream: 'stdout' | 'stderr') => { queue.push({ text, stream }); wake?.(); wake = null; });
    emitter.on('error', (error: Error) => { errors.push(error); wake?.(); wake = null; });
    emitter.on('exit', (code: number) => { exitCode = code; wake?.(); wake = null; });

    while (exitCode === null || queue.length > 0 || errors.length > 0) {
      if (queue.length === 0 && errors.length === 0 && exitCode === null) {
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
      metadata: { executor: 'hermes', exit_code: exitCode },
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
