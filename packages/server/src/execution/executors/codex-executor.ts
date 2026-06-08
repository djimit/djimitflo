/**
 * Codex CLI executor — spawns 'codex exec' process and streams structured events
 *
 * CLI contract (anticipated; verified against actual binary when available):
 *   codex exec [--format json] [--dir <path>] [--model <model>] <prompt>
 *
 * JSON event stream (NDJSON, one JSON object per line):
 *   { "type": "step-start", ... }
 *   { "type": "tool",       ... }
 *   { "type": "text",       ... }
 *   { "type": "step-finish",... }
 *
 * Falls back to heuristic parsing if Codex does not produce valid JSON.
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ── Structured Codex JSON event types ───────────────────────────────────────

interface CodexStepStart {
  type: 'step-start';
  id: string;
  sessionID: string;
  snapshot?: string;
}

interface CodexToolUse {
  type: 'tool';
  tool: string;
  callID: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    metadata?: Record<string, unknown>;
  };
  id: string;
  sessionID: string;
}

interface CodexText {
  type: 'text';
  text: string;
  id: string;
  sessionID: string;
}

interface CodexStepFinish {
  type: 'step-finish';
  reason: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
  };
  id: string;
  sessionID: string;
}

type CodexEventPart = CodexStepStart | CodexToolUse | CodexText | CodexStepFinish;

interface CodexEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: CodexEventPart & Record<string, unknown>;
  [key: string]: unknown;
}

// ── Heuristic fallback (degraded mode) ──────────────────────────────────────

interface ParsedOutput {
  type: 'log' | 'tool_call' | 'tool_result' | 'error' | 'thinking' | 'unknown';
  message: string;
  level: LogLevel;
  metadata?: Record<string, unknown>;
}

// ── Executor ────────────────────────────────────────────────────────────────

export class CodexExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'codex';
  private readonly codexPath: string;
  private readonly executionTimeoutMs: number;
  private readonly skipPermissions: boolean;
  private readonly outputFormat: 'json' | 'default';

  constructor(codexPath?: string) {
    this.codexPath = codexPath || process.env.CODEX_BIN_PATH || 'codex';
    this.executionTimeoutMs = parseInt(process.env.CODEX_EXECUTION_TIMEOUT_MS || '600000', 10);
    this.skipPermissions = process.env.CODEX_SKIP_PERMISSIONS === 'true';
    this.outputFormat = (process.env.CODEX_OUTPUT_FORMAT as 'json' | 'default') || 'json';
  }

  canExecute(_task: Task): boolean {
    return true;
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();

    const args = this.buildCodexArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;

    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = { ...process.env, ...options?.environment };

      const child = spawn(this.codexPath, args, {
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
        emitter.emit('error', new Error(`Codex execution timed out after ${this.executionTimeoutMs}ms`));
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
  // Two likely CLI invocations, controlled by env vars:
  //   `codex exec [--format json] [--dir <path>] [--model <model>] <prompt>`
  //     — OpenAI Codex CLI (default binary: `codex`, override with CODEX_BIN_PATH)
  //   `kilo run [--format json] [--dir <path>] [--model <model>] <prompt>`
  //     — Kilo CLI (default binary: `kilo`, override with CODEX_BIN_PATH,
  //       alternative subcommand via CODEX_SUBCOMMAND, default: `exec`)
  //
  // Both produce the same structured NDJSON event stream (step-start/tool/text/step-finish).

  private buildCodexArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = ['exec'];

    const format = options?.format ?? this.outputFormat;
    if (format === 'json') {
      args.push('--format', 'json');
    }

    if (options?.workingDirectory) {
      args.push('--dir', options.workingDirectory);
    }

    if (options?.model) {
      args.push('--model', options.model);
    }

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;
    if (skipPerms) {
      args.push('--dangerously-skip-permissions');
    }

    args.push(task.description);

    return args;
  }

  // ── Structured JSON event parsing ──────────────────────────────────────────

  private parseJsonEvent(line: string): CodexEvent | null {
    try {
      const event = JSON.parse(line) as CodexEvent;
      if (typeof event.type === 'string') {
        return event;
      }
      return null;
    } catch {
      return null;
    }
  }

  private mapJsonEventToExecutionEvent(taskId: string, event: CodexEvent): ExecutionEventCreateInput | null {
    // Codex may nest event data under `part` (like OpenCode) or flatten it at top level.
    // Handle both shapes.
    const part = event.part ?? (event as unknown as Record<string, unknown>);

    switch (event.type) {
      case 'step-start':
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TASK_STARTED,
          message: 'Codex step started',
          level: LogLevel.INFO,
          metadata: {
            executor: 'codex',
            sessionID: event.sessionID,
            snapshot: (part as Record<string, unknown>)?.snapshot,
          },
        };

      case 'tool': {
        const state = (part as Record<string, unknown>)?.state as Record<string, unknown> | undefined;
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TOOL_CALL,
          message: (state?.input as Record<string, unknown>)?.description as string ||
            `Tool call: ${(part as Record<string, unknown>)?.tool || 'unknown'}`,
          level: LogLevel.INFO,
          tool_name: (part as Record<string, unknown>)?.tool as string | undefined,
          metadata: {
            executor: 'codex',
            callID: (part as Record<string, unknown>)?.callID,
            sessionID: event.sessionID,
            status: state?.status,
            input: state?.input,
          },
        };
      }

      case 'text': {
        const text = (part as Record<string, unknown>)?.text as string || '';
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: text,
          level: LogLevel.INFO,
          metadata: { executor: 'codex', sessionID: event.sessionID },
        };
      }

      case 'step-finish': {
        const reason = ((part as Record<string, unknown>)?.reason as string) || 'unknown';
        const isSuccess = reason === 'stop' || reason === 'complete';
        return {
          task_id: taskId,
          event_type: isSuccess ? ExecutionEventType.TASK_COMPLETED : ExecutionEventType.TASK_FAILED,
          message: `Codex step finished: ${reason}`,
          level: isSuccess ? LogLevel.INFO : LogLevel.ERROR,
          metadata: {
            executor: 'codex',
            sessionID: event.sessionID,
            reason,
            tokens: (part as Record<string, unknown>)?.tokens,
          },
        };
      }

      default:
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: `Unknown Codex event: ${event.type}`,
          level: LogLevel.DEBUG,
          metadata: { executor: 'codex', raw_type: event.type, raw_event: event },
        };
    }
  }

  // ── Heuristic fallback parsing (degraded mode) ─────────────────────────────

  private parseHeuristicLine(line: string, stream: 'stdout' | 'stderr'): ParsedOutput {
    if (line.includes('Using tool:') || line.includes('Tool:') || line.includes('Calling')) {
      return { type: 'tool_call', message: line, level: LogLevel.INFO };
    }
    if (line.includes('Tool result:') || line.includes('Result:') || line.includes('Success:')) {
      return { type: 'tool_result', message: line, level: LogLevel.INFO };
    }
    if (stream === 'stderr' || line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
      return { type: 'error', message: line, level: LogLevel.ERROR };
    }
    if (line.includes('Thinking') || line.includes('Planning') || line.includes('Analyzing')) {
      return { type: 'thinking', message: line, level: LogLevel.DEBUG };
    }
    return { type: 'log', message: line, level: LogLevel.INFO };
  }

  private convertHeuristicToExecutionEvent(
    taskId: string,
    parsed: ParsedOutput,
    rawLine: string,
  ): ExecutionEventCreateInput {
    const baseEvent = {
      task_id: taskId,
      message: parsed.message,
      level: parsed.level,
      metadata: { ...parsed.metadata, raw_output: rawLine, parsing_mode: 'heuristic' as const },
    };

    switch (parsed.type) {
      case 'tool_call':
        return { ...baseEvent, event_type: ExecutionEventType.TOOL_CALL, tool_name: this.extractToolName(rawLine) };
      case 'tool_result':
        return { ...baseEvent, event_type: ExecutionEventType.TOOL_RESULT, tool_name: this.extractToolName(rawLine) };
      case 'error':
        return { ...baseEvent, event_type: ExecutionEventType.ERROR };
      default:
        return { ...baseEvent, event_type: ExecutionEventType.LOG };
    }
  }

  private extractToolName(line: string): string | undefined {
    const match = line.match(/(?:Using tool|Tool|Calling):\s*([a-zA-Z_]+)/i);
    return match?.[1];
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
      message: 'Codex execution started',
      level: LogLevel.INFO,
      metadata: { executor: 'codex', skip_permissions: skipPerms, output_format: this.outputFormat },
    };

    if (skipPerms) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.LOG,
        message:
          'SECURITY OVERRIDE: Codex permission prompts bypassed by CODEX_SKIP_PERMISSIONS=true. Approval gates will not be shown.',
        level: LogLevel.WARNING,
        metadata: {
          security_override: 'codex_permissions_bypass',
          reason: 'Configured via CODEX_SKIP_PERMISSIONS environment variable',
        },
      };
    }

    let useJsonParsing = this.outputFormat === 'json';
    let heuristicWarningEmitted = false;

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

          if (useJsonParsing) {
            const jsonEvent = this.parseJsonEvent(trimmed);
            if (jsonEvent) {
              const mapped = this.mapJsonEventToExecutionEvent(task.id, jsonEvent);
              if (mapped) yield mapped;
            } else {
              // Not valid JSON — switch to heuristic fallback
              if (!heuristicWarningEmitted) {
                heuristicWarningEmitted = true;
                useJsonParsing = false;
                yield {
                  task_id: task.id,
                  event_type: ExecutionEventType.LOG,
                  message:
                    'EVIDENCE WARNING: Codex structured output unavailable; falling back to heuristic parsing. Event accuracy may be reduced.',
                  level: LogLevel.WARNING,
                  metadata: { parsing_mode: 'heuristic_fallback', reason: 'non_json_output_detected' },
                };
              }
              const parsed = this.parseHeuristicLine(trimmed, stream);
              yield this.convertHeuristicToExecutionEvent(task.id, parsed, trimmed);
            }
          } else {
            const parsed = this.parseHeuristicLine(trimmed, stream);
            yield this.convertHeuristicToExecutionEvent(task.id, parsed, trimmed);
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (useJsonParsing) {
        const jsonEvent = this.parseJsonEvent(trimmed);
        if (jsonEvent) {
          const mapped = this.mapJsonEventToExecutionEvent(task.id, jsonEvent);
          if (mapped) yield mapped;
        }
      } else {
        const parsed = this.parseHeuristicLine(trimmed, 'stdout');
        yield this.convertHeuristicToExecutionEvent(task.id, parsed, trimmed);
      }
    }

    if (exitCode === 0) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_COMPLETED,
        message: 'Codex execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'codex', exit_code: exitCode },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `Codex execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'codex', exit_code: exitCode },
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
            message: 'Codex execution completed successfully',
            metrics: { executionTimeMs: 0 },
          });
        } else {
          resolve({
            status: 'failed',
            message: `Codex execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: { executionTimeMs: 0 },
          });
        }
      });

      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `Codex execution error: ${error.message}`,
          error: error.stack,
          metrics: { executionTimeMs: 0 },
        });
      });
    });
  }
}
