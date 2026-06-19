/**
 * Gemini CLI executor — spawns `gemini -p <prompt> -o json` and streams
 * best-effort execution events.
 *
 * CLI contract (headless, verified against the installed binary):
 *   gemini -p "<prompt>" -o json [-y] [-m <m>]
 *
 * The worktree is inherited as cwd via spawn (no --cwd flag). MVP parsing: each
 * stdout line is attempted as JSON (emitted as a LOG carrying the parsed shape)
 * and otherwise heuristic-parsed; the final result is decided by exit code.
 * Native Gemini streaming-event schema mapping (tool-call traces) is deferred.
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { buildExecutorEnv } from './executor-env';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

interface ParsedOutput {
  type: 'log' | 'error' | 'thinking' | 'unknown';
  message: string;
  level: LogLevel;
}

export class GeminiExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'gemini';
  private readonly geminiPath: string;
  private readonly executionTimeoutMs: number;
  private readonly skipPermissions: boolean;
  private readonly outputFormat: 'json' | 'default';

  constructor(geminiPath?: string) {
    this.geminiPath = geminiPath || process.env.GEMINI_BIN_PATH || 'gemini';
    this.executionTimeoutMs = parseInt(process.env.GEMINI_EXECUTION_TIMEOUT_MS || '600000', 10);
    this.skipPermissions = process.env.GEMINI_SKIP_PERMISSIONS === 'true';
    this.outputFormat = (process.env.GEMINI_OUTPUT_FORMAT as 'json' | 'default') || 'json';
  }

  canExecute(_task: Task): boolean {
    return true;
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();

    const args = this.buildGeminiArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;

    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = buildExecutorEnv(options?.environment);

      const child = spawn(this.geminiPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      childProcess = child;

      const timeoutHandle = setTimeout(() => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child && !child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }
        emitter.emit('error', new Error(`Gemini execution timed out after ${this.executionTimeoutMs}ms`));
      }, this.executionTimeoutMs);

      child.stdout?.on('data', (data) => {
        emitter.emit('output', data.toString(), 'stdout');
      });

      child.stderr?.on('data', (data) => {
        emitter.emit('output', data.toString(), 'stderr');
      });

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        emitter.emit('exit', code);
      });

      child.on('error', (error) => {
        emitter.emit('error', error);
      });
    };

    const events = this.createEventStream(task, emitter, spawnProcess, skipPerms);
    const result = this.createResultPromise(task, emitter);

    const session: ExecutionSession = {
      id: sessionId,
      taskId: task.id,
      executorKind: this.kind,
      status: 'starting',
      startedAt,
      events,
      result,
      cancel: async () => {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM');
          setTimeout(() => {
            if (childProcess && !childProcess.killed) {
              childProcess.kill('SIGKILL');
            }
          }, 5000);
        }
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };

    return session;
  }

  // ── CLI argument construction ───────────────────────────────────────────────
  //
  // `gemini -p "<prompt>" -o json [-y] [-m <m>]`
  // The worktree is inherited as cwd via spawn (no --cwd). Model may come from
  // ExecutorOptions or the DJIMITFLO_GEMINI_MODEL env var.

  private buildGeminiArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = ['-p', task.description];

    const format = options?.format ?? this.outputFormat;
    if (format === 'json') {
      args.push('-o', 'json');
    }

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;
    if (skipPerms) {
      args.push('-y');
    }

    const model = options?.model || process.env.DJIMITFLO_GEMINI_MODEL;
    if (model) {
      args.push('-m', model);
    }

    return args;
  }

  // ── Best-effort parsing (MVP) ───────────────────────────────────────────────

  private parseHeuristicLine(line: string, stream: 'stdout' | 'stderr'): ParsedOutput {
    if (stream === 'stderr' || line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
      return { type: 'error', message: line, level: LogLevel.ERROR };
    }
    if (line.toLowerCase().includes('thinking') || line.toLowerCase().includes('planning')) {
      return { type: 'thinking', message: line, level: LogLevel.DEBUG };
    }
    return { type: 'log', message: line, level: LogLevel.INFO };
  }

  private lineToExecutionEvent(taskId: string, line: string, stream: 'stdout' | 'stderr'): ExecutionEventCreateInput {
    const trimmed = line.trim();
    if (stream === 'stdout') {
      try {
        const parsed = JSON.parse(trimmed);
        const summary = typeof parsed === 'string'
          ? parsed
          : (parsed?.result ?? parsed?.text ?? parsed?.message ?? `JSON event: ${parsed?.type ?? 'object'}`);
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: typeof summary === 'string' ? summary : JSON.stringify(summary),
          level: LogLevel.INFO,
          metadata: { executor: 'gemini', parsing_mode: 'json', raw: parsed },
        };
      } catch {
        // not JSON — fall through to heuristic
      }
    }
    const parsed = this.parseHeuristicLine(trimmed, stream);
    return {
      task_id: taskId,
      event_type: parsed.type === 'error' ? ExecutionEventType.ERROR : ExecutionEventType.LOG,
      message: parsed.message,
      level: parsed.level,
      metadata: { executor: 'gemini', parsing_mode: 'heuristic', raw_output: trimmed },
    };
  }

  // ── Event stream ───────────────────────────────────────────────────────────

  private async *createEventStream(
    task: Task,
    emitter: EventEmitter,
    spawnProcess: () => void,
    skipPerms: boolean,
  ): AsyncIterable<ExecutionEventCreateInput> {
    spawnProcess();

    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TASK_STARTED,
      message: 'Gemini execution started',
      level: LogLevel.INFO,
      metadata: { executor: 'gemini', skip_permissions: skipPerms, output_format: this.outputFormat },
    };

    if (skipPerms) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.LOG,
        message:
          'SECURITY OVERRIDE: Gemini permission prompts bypassed by GEMINI_SKIP_PERMISSIONS=true. Approval gates will not be shown.',
        level: LogLevel.WARNING,
        metadata: {
          security_override: 'gemini_permissions_bypass',
          reason: 'Configured via GEMINI_SKIP_PERMISSIONS environment variable',
        },
      };
    }

    let buffer = '';
    const outputQueue: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const errorQueue: Error[] = [];
    let exitCode: number | null = null;
    let resolver: ((value: boolean) => void) | null = null;

    emitter.on('output', (text: string, stream: 'stdout' | 'stderr') => {
      outputQueue.push({ text, stream });
      if (resolver) {
        resolver(true);
        resolver = null;
      }
    });

    emitter.on('error', (error: Error) => {
      errorQueue.push(error);
      if (resolver) {
        resolver(true);
        resolver = null;
      }
    });

    emitter.on('exit', (code: number) => {
      exitCode = code;
      if (resolver) {
        resolver(false);
        resolver = null;
      }
    });

    while (exitCode === null) {
      if (outputQueue.length === 0 && errorQueue.length === 0) {
        await new Promise<boolean>((resolve) => {
          resolver = resolve;
        });
      }

      while (errorQueue.length > 0) {
        const error = errorQueue.shift()!;
        yield {
          task_id: task.id,
          event_type: ExecutionEventType.ERROR,
          message: `Process error: ${error.message}`,
          level: LogLevel.ERROR,
          metadata: { error: error.stack },
        };
      }

      while (outputQueue.length > 0) {
        const { text, stream } = outputQueue.shift()!;
        buffer += text;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          yield this.lineToExecutionEvent(task.id, line, stream);
        }
      }
    }

    if (buffer.trim()) {
      yield this.lineToExecutionEvent(task.id, buffer, 'stdout');
    }

    if (exitCode === 0) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_COMPLETED,
        message: 'Gemini execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'gemini', exit_code: exitCode },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `Gemini execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'gemini', exit_code: exitCode },
      };
    }
  }

  // ── Result promise ─────────────────────────────────────────────────────────

  private async createResultPromise(
    _task: Task,
    emitter: EventEmitter,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      emitter.on('exit', (code: number) => {
        if (code === 0) {
          resolve({
            status: 'completed',
            message: 'Gemini execution completed successfully',
            metrics: { executionTimeMs: 0 },
          });
        } else {
          resolve({
            status: 'failed',
            message: `Gemini execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: { executionTimeMs: 0 },
          });
        }
      });

      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `Gemini execution error: ${error.message}`,
          error: error.stack,
          metrics: { executionTimeMs: 0 },
        });
      });
    });
  }
}