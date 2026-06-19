/**
 * Editor CLI executor — spawns `cline` (the autonomous AI editor-agent) and
 * streams best-effort execution events.
 *
 * CLI contract (headless, verified against the installed binary):
 *   cline --json --auto-approve <bool> -c <worktree> [--thinking <t>] [-m <m>] "<prompt>"
 *
 * `editor` is the runtime name; the binary is `cline` (aider/cursor not
 * installed). cline takes the worktree via its own `-c` flag (also used as the
 * spawn cwd). MVP parsing: each stdout line is attempted as JSON (emitted as a
 * LOG carrying the parsed shape) and otherwise heuristic-parsed; the final
 * result is decided by exit code. Native cline streaming-event schema mapping
 * (tool-call traces) is deferred.
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

export class EditorExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'editor';
  private readonly clinePath: string;
  private readonly executionTimeoutMs: number;
  private readonly skipPermissions: boolean;
  private readonly outputFormat: 'json' | 'default';

  constructor(clinePath?: string) {
    this.clinePath = clinePath || process.env.CLINE_BIN_PATH || 'cline';
    this.executionTimeoutMs = parseInt(process.env.CLINE_EXECUTION_TIMEOUT_MS || '600000', 10);
    this.skipPermissions = process.env.CLINE_SKIP_PERMISSIONS === 'true';
    this.outputFormat = (process.env.CLINE_OUTPUT_FORMAT as 'json' | 'default') || 'json';
  }

  canExecute(_task: Task): boolean {
    return true;
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();

    const args = this.buildEditorArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;

    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = buildExecutorEnv(options?.environment);

      const child = spawn(this.clinePath, args, {
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
        emitter.emit('error', new Error(`Cline execution timed out after ${this.executionTimeoutMs}ms`));
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
  // `cline --json --auto-approve <bool> -c <worktree> [--thinking <t>] [-m <m>] "<prompt>"`
  // The worktree is passed via cline's -c flag AND used as the spawn cwd.
  // --auto-approve reflects the skipPermissions gate (honored only when armed).
  // Thinking level from DJIMITFLO_CLINE_THINKING (default 'medium'); model from
  // ExecutorOptions or DJIMITFLO_CLINE_MODEL.

  private buildEditorArgs(task: Task, options?: ExecutorOptions): string[] {
    const skipPerms = options?.skipPermissions ?? this.skipPermissions;
    const cwd = options?.workingDirectory || process.cwd();

    const args: string[] = ['--json', '--auto-approve', skipPerms ? 'true' : 'false', '-c', cwd];

    const format = options?.format ?? this.outputFormat;
    if (format !== 'json') {
      // cline's --json is the headless structured mode; keep it on by default.
      // When 'default' is requested we still emit --json because cline lacks a
      // clean non-json headless mode — recorded honestly in the event metadata.
      args.push('--json');
    }

    args.push('--thinking', process.env.DJIMITFLO_CLINE_THINKING || 'medium');

    const model = options?.model || process.env.DJIMITFLO_CLINE_MODEL;
    if (model) {
      args.push('-m', model);
    }

    args.push(task.description);

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
          metadata: { executor: 'editor', parsing_mode: 'json', raw: parsed },
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
      metadata: { executor: 'editor', parsing_mode: 'heuristic', raw_output: trimmed },
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
      message: 'Editor (cline) execution started',
      level: LogLevel.INFO,
      metadata: { executor: 'editor', skip_permissions: skipPerms, output_format: this.outputFormat },
    };

    if (skipPerms) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.LOG,
        message:
          'SECURITY OVERRIDE: cline auto-approve enabled by CLINE_SKIP_PERMISSIONS=true. Approval gates will not be shown.',
        level: LogLevel.WARNING,
        metadata: {
          security_override: 'cline_auto_approve_bypass',
          reason: 'Configured via CLINE_SKIP_PERMISSIONS environment variable',
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
        message: 'Editor (cline) execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'editor', exit_code: exitCode },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `Editor (cline) execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'editor', exit_code: exitCode },
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
            message: 'Editor (cline) execution completed successfully',
            metrics: { executionTimeMs: 0 },
          });
        } else {
          resolve({
            status: 'failed',
            message: `Editor (cline) execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: { executionTimeMs: 0 },
          });
        }
      });

      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `Editor (cline) execution error: ${error.message}`,
          error: error.stack,
          metrics: { executionTimeMs: 0 },
        });
      });
    });
  }
}