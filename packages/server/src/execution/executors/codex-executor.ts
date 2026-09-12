/**
 * Codex CLI executor — spawns 'codex exec' process and streams structured events
 *
 * CLI contract verified against codex-cli 0.153.4:
 *   codex exec [--json] [--cd <path>] [--model <model>] <prompt>
 *
 * JSON event stream (NDJSON, one JSON object per line):
 *   thread.started, turn.started, item.started/updated/completed, turn.completed.
 * Legacy step-start/tool/text/step-finish events remain accepted.
 *
 * Non-JSON stdout lines use heuristic parsing without disabling later NDJSON.
 * Stderr diagnostics remain separate from the structured stdout protocol.
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { buildExecutorEnv } from './executor-env';
import { runtimeProcessClosed, stopRuntimeProcess } from './runtime-process';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { captureExecutorOutput } from '../executor-output';

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

  buildCommand(task: Task, options?: ExecutorOptions): { command: string; args: string[] } {
    return { command: this.codexPath, args: this.buildCodexArgs(task, options) };
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();

    const args = this.buildCodexArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;

    const spawnProcess = () => {
      if (session.status === 'cancelled') { resolveClosed(); emitter.emit('exit', null); return; }
      const cwd = options?.workingDirectory || process.cwd();
      const env = buildExecutorEnv(options?.environment);
      const timeoutMs = options?.timeout ?? this.executionTimeoutMs;

      const child = spawn(this.codexPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      childProcess = child;
      void runtimeProcessClosed(child).then(resolveClosed);

      const timeoutHandle = setTimeout(() => {
        stopRuntimeProcess(child);
        emitter.emit('error', new Error(`Codex execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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

    const events = this.createEventStream(task, emitter, spawnProcess, skipPerms, options);
    const result = this.createResultPromise(task, emitter);

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

  // ── CLI argument construction ───────────────────────────────────────────────
  //
  // `codex exec --json --cd <path> --model <model> -c model_reasoning_effort="high" <prompt>`

  private buildCodexArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = ['exec'];

    const format = options?.format ?? this.outputFormat;
    if (format === 'json') {
      args.push('--json');
    }

    if (options?.workingDirectory) {
      args.push('--cd', options.workingDirectory);
    }

    const model = options?.model || process.env.DJIMITFLO_CODEX_MODEL;
    if (model) args.push('--model', model);
    const reasoningEffort = options?.reasoningEffort || process.env.DJIMITFLO_CODEX_REASONING_EFFORT;
    if (reasoningEffort) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) throw new Error('INVALID_REASONING_EFFORT');
      args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    }
    if (options?.codexSandbox) args.push('--sandbox', options.codexSandbox);

    const skipPerms = options?.skipPermissions ?? this.skipPermissions;
    if (skipPerms) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
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
      case 'thread.started':
        return { task_id: taskId, event_type: ExecutionEventType.LOG, message: 'Codex thread started', level: LogLevel.INFO, metadata: { executor: 'codex', thread_id: event.thread_id } };
      case 'turn.completed':
        return { task_id: taskId, event_type: ExecutionEventType.LOG, message: 'Codex turn completed', level: LogLevel.INFO, metadata: { executor: 'codex', usage: event.usage } };
      case 'turn.failed':
      case 'error':
        return { task_id: taskId, event_type: ExecutionEventType.ERROR, message: String((event.error as { message?: string })?.message || event.message || 'Codex turn failed'), level: LogLevel.ERROR, metadata: { executor: 'codex', raw_event: event } };
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item as Record<string, unknown> | undefined;
        if (!item || typeof item !== 'object') return null;
        const tool = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type));
        const completed = event.type === 'item.completed';
        return {
          task_id: taskId,
          event_type: tool ? (completed ? ExecutionEventType.TOOL_RESULT : ExecutionEventType.TOOL_CALL) : ExecutionEventType.LOG,
          message: String(item.text || item.command || item.tool || item.type || 'Codex item'),
          level: item.status === 'failed' ? LogLevel.ERROR : LogLevel.INFO,
          ...(tool ? { tool_name: String(item.tool || item.type), ...(completed ? { tool_output: item } : { tool_input: item }) } : {}),
          metadata: { executor: 'codex', item_id: item.id, parsing_mode: 'json', raw_event: event },
        };
      }
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
    options?: ExecutorOptions,
  ): AsyncIterable<ExecutionEventCreateInput> {
    const outputFormat = options?.format ?? this.outputFormat;
    const useJsonParsing = outputFormat === 'json';
    let heuristicWarningEmitted = false;
    const buffers = { stdout: '', stderr: '' };
    const discarding = { stdout: false, stderr: false };
    const maxLineChars = 1024 * 1024;
    let truncationWarningEmitted = false;
    const truncationWarning = (): ExecutionEventCreateInput[] => {
      if (truncationWarningEmitted) return [];
      truncationWarningEmitted = true;
      return [{ task_id: task.id, event_type: ExecutionEventType.LOG, level: LogLevel.WARNING,
        message: 'EVIDENCE WARNING: Oversized Codex output line omitted from event parsing.',
        metadata: { parsing_mode: 'truncated', max_line_chars: maxLineChars } }];
    };
    const parseLine = (line: string, stream: 'stdout' | 'stderr'): ExecutionEventCreateInput[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      if (stream === 'stderr') {
        const warning = /\bwarn(?:ing)?\b/i.test(trimmed);
        const error = !warning && /\b(?:error|failed|fatal|panic)\b/i.test(trimmed);
        return [{ task_id: task.id, event_type: error ? ExecutionEventType.ERROR : ExecutionEventType.LOG,
          message: trimmed, level: error ? LogLevel.ERROR : warning ? LogLevel.WARNING : LogLevel.INFO,
          metadata: { executor: 'codex', stream, parsing_mode: 'diagnostic' } }];
      }
      if (useJsonParsing) {
        const jsonEvent = this.parseJsonEvent(trimmed);
        if (jsonEvent) {
          const mapped = this.mapJsonEventToExecutionEvent(task.id, jsonEvent);
          return mapped ? [mapped] : [];
        }
      }
      const events: ExecutionEventCreateInput[] = [];
      if (useJsonParsing && !heuristicWarningEmitted) {
        heuristicWarningEmitted = true;
        events.push({ task_id: task.id, event_type: ExecutionEventType.LOG, level: LogLevel.WARNING,
          message: 'EVIDENCE WARNING: Non-JSON Codex stdout uses heuristic parsing; subsequent JSON remains structured.',
          metadata: { parsing_mode: 'heuristic_fallback', reason: 'non_json_stdout_detected' } });
      }
      events.push(this.convertHeuristicToExecutionEvent(task.id, this.parseHeuristicLine(trimmed, stream), trimmed));
      return events;
    };
    const outputQueue: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    const errorQueue: Error[] = [];
    let exitCode: number | null | undefined;
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

    emitter.on('exit', (code: number | null) => {
      exitCode = code;
      if (resolver) {
        resolver(false);
        resolver = null;
      }
    });

    // Install listeners before spawning or yielding: a fast child may emit
    // output and close while the consumer is handling the initial event.
    spawnProcess();
    yield {
      task_id: task.id, event_type: ExecutionEventType.TASK_STARTED,
      message: 'Codex execution started', level: LogLevel.INFO,
      metadata: { executor: 'codex', skip_permissions: skipPerms, output_format: outputFormat,
        model: options?.model || process.env.DJIMITFLO_CODEX_MODEL || 'cli-default',
        reasoning_effort: options?.reasoningEffort || process.env.DJIMITFLO_CODEX_REASONING_EFFORT || 'cli-default' },
    };
    if (skipPerms) {
      yield { task_id: task.id, event_type: ExecutionEventType.LOG, level: LogLevel.WARNING,
        message: 'SECURITY OVERRIDE: Codex permission prompts bypassed by explicit runtime configuration. Approval gates will not be shown.',
        metadata: { security_override: 'codex_permissions_bypass', reason: 'Configured via executor options or CODEX_SKIP_PERMISSIONS' } };
    }

    while (exitCode === undefined || outputQueue.length > 0 || errorQueue.length > 0) {
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
        let chunk = text;
        if (discarding[stream]) {
          const boundary = chunk.indexOf('\n');
          if (boundary < 0) continue;
          chunk = chunk.slice(boundary + 1);
          discarding[stream] = false;
        }
        const lines = (buffers[stream] + chunk).split('\n');
        buffers[stream] = lines.pop() || '';
        for (const line of lines) yield* line.length > maxLineChars ? truncationWarning() : parseLine(line, stream);
        if (buffers[stream].length > maxLineChars) {
          buffers[stream] = '';
          discarding[stream] = true;
          yield* truncationWarning();
        }
      }
    }

    for (const stream of ['stdout', 'stderr'] as const) yield* parseLine(buffers[stream], stream);

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
    const output = captureExecutorOutput(emitter);
    const startedAt = Date.now();
    return new Promise((resolveResult) => {
      const resolve = (result: ExecutionResult) => {
        const captured = output();
        let tokenUsage: number | undefined;
        for (const line of (captured.stdout || '').split('\n')) {
          const event = this.parseJsonEvent(line);
          const usage = event?.type === 'turn.completed' ? event.usage as Record<string, unknown> | undefined : undefined;
          if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
            tokenUsage = (tokenUsage || 0) + usage.input_tokens + usage.output_tokens;
          }
        }
        resolveResult({ ...result, ...captured, metrics: { ...result.metrics, executionTimeMs: Date.now() - startedAt, ...(tokenUsage !== undefined ? { tokenUsage } : {}) } });
      };
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
