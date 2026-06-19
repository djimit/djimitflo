/**
 * Claude CLI executor — spawns `claude -p <prompt> --output-format json` and
 * streams best-effort execution events.
 *
 * CLI contract (headless, verified against the installed binary):
 *   claude -p "<prompt>" --output-format json [--dangerously-skip-permissions] [--model <m>]
 *
 * The worktree is inherited as cwd via spawn (no --cd flag). MVP parsing: each
 * stdout line is attempted as JSON (emitted as a LOG carrying the parsed shape)
 * and otherwise heuristic-parsed; the final result is decided by exit code.
 * Native Claude streaming-event schema mapping (tool-call traces) is deferred —
 * this mirrors how CodexExecutor falls back to heuristics for non-JSON output.
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

export class ClaudeExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'claude';
  private readonly claudePath: string;
  private readonly executionTimeoutMs: number;
  private readonly skipPermissions: boolean;
  private readonly outputFormat: 'json' | 'default';

  constructor(claudePath?: string) {
    this.claudePath = claudePath || process.env.CLAUDE_BIN_PATH || 'claude';
    this.executionTimeoutMs = parseInt(process.env.CLAUDE_EXECUTION_TIMEOUT_MS || '600000', 10);
    this.skipPermissions = process.env.CLAUDE_SKIP_PERMISSIONS === 'true';
    this.outputFormat = (process.env.CLAUDE_OUTPUT_FORMAT as 'json' | 'default') || 'json';
  }

  canExecute(_task: Task): boolean {
    return true;
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();

    const args = this.buildClaudeArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;

    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = buildExecutorEnv(options?.environment);

      const child = spawn(this.claudePath, args, {
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
        emitter.emit('error', new Error(`Claude execution timed out after ${this.executionTimeoutMs}ms`));
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
  // `claude -p "<prompt>" --output-format json [--dangerously-skip-permissions] [--model <m>]`
  // The worktree is inherited as cwd via spawn (no --cd). Model may come from
  // ExecutorOptions or the DJIMITFLO_CLAUDE_MODEL env var.

  private buildClaudeArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = ['-p', task.description];

    const format = options?.format ?? this.outputFormat;
    if (format === 'json') {
      args.push('--output-format', 'json');
    }

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;
    if (skipPerms) {
      args.push('--dangerously-skip-permissions');
    }

    const model = options?.model || process.env.DJIMITFLO_CLAUDE_MODEL;
    if (model) {
      args.push('--model', model);
    }

    return args;
  }

  // ── Best-effort parsing (MVP) ───────────────────────────────────────────────
  //
  // Try JSON.parse per line; if it parses, surface a compact LOG. Otherwise
  // heuristic-parse. No native Claude event-schema → ExecutionEventType mapping
  // yet (deferred); tool-call traces are best-effort LOG lines.

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
          metadata: { executor: 'claude', parsing_mode: 'json', raw: parsed },
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
      metadata: { executor: 'claude', parsing_mode: 'heuristic', raw_output: trimmed },
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
      message: 'Claude execution started',
      level: LogLevel.INFO,
      metadata: { executor: 'claude', skip_permissions: skipPerms, output_format: this.outputFormat },
    };

    if (skipPerms) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.LOG,
        message:
          'SECURITY OVERRIDE: Claude permission prompts bypassed by CLAUDE_SKIP_PERMISSIONS=true. Approval gates will not be shown.',
        level: LogLevel.WARNING,
        metadata: {
          security_override: 'claude_permissions_bypass',
          reason: 'Configured via CLAUDE_SKIP_PERMISSIONS environment variable',
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
        message: 'Claude execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'claude', exit_code: exitCode },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `Claude execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'claude', exit_code: exitCode },
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
            message: 'Claude execution completed successfully',
            metrics: { executionTimeMs: 0 },
          });
        } else {
          resolve({
            status: 'failed',
            message: `Claude execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: { executionTimeMs: 0 },
          });
        }
      });

      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `Claude execution error: ${error.message}`,
          error: error.stack,
          metrics: { executionTimeMs: 0 },
        });
      });
    });
  }
}