/**
 * OpenCode CLI executor — spawns OpenCode process and streams structured events
 *
 * CLI contract verified against OpenCode 1.15.4 (2026-05-18, live binary):
 *   --dir <path>                          working directory (NOT --cwd)
 *   --format json|default                  output format (default: default)
 *   --model <provider/model>              model selection
 *   --agent <name>                        agent selection (build/plan/explore/scout/custom)
 *   --dangerously-skip-permissions       auto-approve permissions (default: false)
 *   --continue / --session <id>           session continuity (future scope)
 *   --variant <level>                     model reasoning effort
 *   --file <path>                         attach files to message
 *
 * Invalid flags removed in Phase 5.1: --cwd, --temperature, --max-tokens
 *
 * JSON event stream (NDJSON, one JSON object per line):
 *   { type: "step_start",  sessionID, timestamp, part: { type: "step-start", ... } }
 *   { type: "tool_use",    sessionID, timestamp, part: { type: "tool", tool, callID, state: { ... } } }
 *   { type: "text",        sessionID, timestamp, part: { type: "text", text, ... } }
 *   { type: "step_finish", sessionID, timestamp, part: { type: "step-finish", reason, tokens, ... } }
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { buildExecutorEnv } from './executor-env';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ── Structured OpenCode JSON event types ────────────────────────────────────

interface OpenCodeStepStart {
  type: 'step-start';
  id: string;
  messageID: string;
  sessionID: string;
  snapshot?: string;
}

interface OpenCodeToolUse {
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
  messageID: string;
  sessionID: string;
}

interface OpenCodeText {
  type: 'text';
  text: string;
  id: string;
  messageID: string;
  sessionID: string;
  time?: { start: number; end: number };
}

interface OpenCodeStepFinish {
  type: 'step-finish';
  reason: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  cost?: number;
  id: string;
  messageID: string;
  sessionID: string;
  snapshot?: string;
}

type OpenCodeEventPart = OpenCodeStepStart | OpenCodeToolUse | OpenCodeText | OpenCodeStepFinish;

interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part: OpenCodeEventPart & Record<string, unknown>;
}

// ── Heuristic fallback (kept for degraded mode) ─────────────────────────────

interface ParsedOutput {
  type: 'log' | 'tool_call' | 'tool_result' | 'error' | 'approval_request' | 'thinking' | 'unknown';
  message: string;
  level: LogLevel;
  metadata?: Record<string, unknown>;
}

// ── Executor ────────────────────────────────────────────────────────────────

export class OpenCodeExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'opencode';
  private readonly opencodePath: string;
  private readonly executionTimeoutMs: number;
  private readonly skipPermissions: boolean;
  private readonly outputFormat: 'json' | 'default';

  constructor(opencodePath?: string) {
    this.opencodePath = opencodePath || process.env.OPENCODE_BIN_PATH || 'opencode';
    this.executionTimeoutMs = parseInt(process.env.OPENCODE_EXECUTION_TIMEOUT_MS || '600000', 10);
    this.skipPermissions = process.env.OPENCODE_SKIP_PERMISSIONS === 'true';
    this.outputFormat = (process.env.OPENCODE_OUTPUT_FORMAT as 'json' | 'default') || 'json';
  }

  canExecute(_task: Task): boolean {
    return true;
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();

    const args = this.buildOpenCodeArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;

    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = buildExecutorEnv(options?.environment);

      const child = spawn(this.opencodePath, args, {
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
        emitter.emit('error', new Error(`OpenCode execution timed out after ${this.executionTimeoutMs}ms`));
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

  private buildOpenCodeArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = [];

    args.push('run');

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

    if (options?.agentKind) {
      args.push('--agent', options.agentKind);
    }

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;
    if (skipPerms) {
      args.push('--dangerously-skip-permissions');
    }

    args.push(task.description);

    return args;
  }

  // ── Structured JSON event parsing ──────────────────────────────────────────

  private parseJsonEvent(line: string): OpenCodeEvent | null {
    try {
      const event = JSON.parse(line) as OpenCodeEvent;
      if (typeof event.type === 'string') {
        return event;
      }
      return null;
    } catch {
      return null;
    }
  }

  private mapJsonEventToExecutionEvent(taskId: string, event: OpenCodeEvent): ExecutionEventCreateInput | null {
    const part = event.part;

    switch (event.type) {
      case 'step_start':
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TASK_STARTED,
          message: 'OpenCode step started',
          level: LogLevel.INFO,
          metadata: { executor: 'opencode', sessionID: event.sessionID, snapshot: part?.snapshot },
        };

      case 'tool_use': {
        const toolPart = part as OpenCodeToolUse;
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TOOL_CALL,
          message: toolPart.state?.input?.description as string || `Tool call: ${toolPart.tool}`,
          level: LogLevel.INFO,
          tool_name: toolPart.tool,
          metadata: {
            executor: 'opencode',
            callID: toolPart.callID,
            sessionID: event.sessionID,
            status: toolPart.state?.status,
            input: toolPart.state?.input,
          },
        };
      }

      case 'text': {
        const textPart = part as OpenCodeText;
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: textPart.text,
          level: LogLevel.INFO,
          metadata: { executor: 'opencode', sessionID: event.sessionID },
        };
      }

      case 'step_finish': {
        const finishPart = part as OpenCodeStepFinish;
        const isSuccess = finishPart.reason === 'stop' || finishPart.reason === 'complete';
        return {
          task_id: taskId,
          event_type: isSuccess ? ExecutionEventType.TASK_COMPLETED : ExecutionEventType.TASK_FAILED,
          message: `OpenCode step finished: ${finishPart.reason}`,
          level: isSuccess ? LogLevel.INFO : LogLevel.ERROR,
          metadata: {
            executor: 'opencode',
            sessionID: event.sessionID,
            reason: finishPart.reason,
            tokens: finishPart.tokens,
            cost: finishPart.cost,
          },
        };
      }

      default:
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: `Unknown OpenCode event: ${event.type}`,
          level: LogLevel.DEBUG,
          metadata: { executor: 'opencode', raw_type: event.type, raw_event: event },
        };
    }
  }

  // ── Heuristic fallback parsing (deprecated, kept for degraded mode) ────────

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

  private convertHeuristicToExecutionEvent(taskId: string, parsed: ParsedOutput, rawLine: string): ExecutionEventCreateInput {
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
      message: 'OpenCode execution started',
      level: LogLevel.INFO,
      metadata: { executor: 'opencode', skip_permissions: skipPerms, output_format: this.outputFormat },
    };

    if (skipPerms) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.LOG,
        message: 'SECURITY OVERRIDE: OpenCode permission prompts bypassed by OPENCODE_SKIP_PERMISSIONS=true. Approval gates will not be shown.',
        level: LogLevel.WARNING,
        metadata: { security_override: 'opencode_permissions_bypass', reason: 'Configured via OPENCODE_SKIP_PERMISSIONS environment variable' },
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
      if (resolver) { resolver(true); resolver = null; }
    });

    emitter.on('error', (error: Error) => {
      errorQueue.push(error);
      if (resolver) { resolver(true); resolver = null; }
    });

    emitter.on('exit', (code: number) => {
      exitCode = code;
      if (resolver) { resolver(false); resolver = null; }
    });

    while (exitCode === null) {
      if (outputQueue.length === 0 && errorQueue.length === 0) {
        await new Promise<boolean>((resolve) => { resolver = resolve; });
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
                  message: 'EVIDENCE WARNING: OpenCode structured output unavailable; falling back to heuristic parsing. Event accuracy may be reduced.',
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
        message: 'OpenCode execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'opencode', exit_code: exitCode },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `OpenCode execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'opencode', exit_code: exitCode },
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
            message: 'OpenCode execution completed successfully',
            metrics: { executionTimeMs: 0 },
          });
        } else {
          resolve({
            status: 'failed',
            message: `OpenCode execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: { executionTimeMs: 0 },
          });
        }
      });

      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `OpenCode execution error: ${error.message}`,
          error: error.stack,
          metrics: { executionTimeMs: 0 },
        });
      });
    });
  }
}