/**
 * Pi CLI executor — spawns `pi --mode json -p` and streams structured NDJSON events.
 *
 * CLI contract (VERIFIED 2026-06-20 against Pi 0.79.8 — see docs/pi.md):
 *   pi --mode json -p [--provider <p>] [--model <m>] [--tools <list>]
 *      [--no-approve] [--no-context-files] [--no-extensions] [--no-skills]
 *      [--offline] [--thinking <level>] [--no-session] <prompt>
 *
 * Pi uses the child-process `cwd` as its working directory (no --dir flag).
 *
 * NDJSON event stream (one JSON object per line), first line is a session header:
 *   {"type":"session","version":3,"id":"...","cwd":"..."}
 *   {"type":"agent_start"}
 *   {"type":"turn_start"}
 *   {"type":"message_start","message":{"role":"user"|"assistant"|"toolResult",...}}
 *   {"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta"|"toolcall_start"|"toolcall_end",...}}
 *   {"type":"message_end","message":{...}}                       # message.usage carries token counts
 *   {"type":"tool_execution_start","toolCallId":"...","toolName":"ls","args":{...}}
 *   {"type":"tool_execution_end","toolCallId":"...","toolName":"ls","result":{"content":[{"type":"text","text":"..."}]},"isError":false}
 *   {"type":"turn_end","message":{...},"toolResults":[...]}
 *   {"type":"agent_end","messages":[...]}
 *
 * SECURITY (verified — see docs/pi.md):
 *   Pi has NO permission popups and NO PI_SKIP_PERMISSIONS. It runs with the
 *   launching user's permissions. djimitflo's policy engine is the SOLE boundary.
 *   Restrict capability per task via PI_TOOLS (drop `bash` for low-risk runs).
 *   File tools (read/ls/edit/write) are cwd-scoped by default; `bash` is the
 *   escape hatch and must be treated as high-risk (containerize for sensitive repos).
 *   Sovereign/zero-egress runs REQUIRE PI_OFFLINE=1 + PI_SKIP_VERSION_CHECK=1 +
 *   PI_TELEMETRY=0, else Pi phones home to pi.dev at startup.
 *
 * Falls back to heuristic parsing only if a stdout line is not valid JSON (rare in
 * --mode json; stderr lines are treated as error/log).
 */

import { Task, ExecutionEventType, LogLevel, ExecutionEventCreateInput } from '@djimitflo/shared';
import { TaskExecutor, ExecutionSession, ExecutionResult, ExecutorOptions, ExecutorKind } from '../types';
import { buildExecutorEnv } from './executor-env';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ── Structured Pi JSON event shapes (subset; the rest pass through as LOG) ────

interface PiUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiContentBlock {
  type: string;
  text?: string;
  // toolCall
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content?: PiContentBlock[];
  usage?: PiUsage;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
}

interface PiAssistantMessageEvent {
  type: string; // text_start | text_delta | toolcall_start | toolcall_delta | toolcall_end | ...
  delta?: string;
  contentIndex?: number;
  toolCall?: { name?: string; id?: string; arguments?: Record<string, unknown> };
  partial?: PiMessage;
}

interface PiEvent {
  type: string;
  // session header
  id?: string;
  version?: number;
  cwd?: string;
  timestamp?: string;
  // message_*
  message?: PiMessage;
  assistantMessageEvent?: PiAssistantMessageEvent;
  // turn_end
  toolResults?: PiMessage[];
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { content?: PiContentBlock[] };
  isError?: boolean;
  [key: string]: unknown;
}

// ── Executor ────────────────────────────────────────────────────────────────

export class PiExecutor implements TaskExecutor {
  readonly kind: ExecutorKind = 'pi' as ExecutorKind;
  private readonly piPath: string;
  private readonly executionTimeoutMs: number;
  private readonly outputFormat: 'json' | 'default';

  constructor(piPath?: string) {
    this.piPath = piPath || process.env.PI_BIN_PATH || 'pi';
    this.executionTimeoutMs = parseInt(process.env.PI_EXECUTION_TIMEOUT_MS || '600000', 10);
    // Pi is json-only in this executor; the knob exists only to allow a future text mode.
    this.outputFormat = (process.env.PI_OUTPUT_FORMAT as 'json' | 'default') || 'json';
  }

  canExecute(_task: Task): boolean {
    return true;
  }

  async start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession> {
    const sessionId = randomUUID();
    const startedAt = new Date();
    const args = this.buildPiArgs(task, options);

    const emitter = new EventEmitter();
    let childProcess: ChildProcess | null = null;

    // Shared metrics accumulator: the event stream writes, the result promise reads.
    const metrics = { tokenUsage: 0, toolCalls: 0, approvalsRequested: 0 };

    const spawnProcess = () => {
      const cwd = options?.workingDirectory || process.cwd();
      const env = buildExecutorEnv(options?.environment);

      const child = spawn(this.piPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      childProcess = child;

      const timeoutHandle = setTimeout(() => {
        if (child && !child.killed) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child && !child.killed) child.kill('SIGKILL');
          }, 5000);
        }
        emitter.emit('error', new Error(`Pi execution timed out after ${this.executionTimeoutMs}ms`));
      }, options?.timeout ?? this.executionTimeoutMs);

      child.stdout?.on('data', (data) => emitter.emit('output', data.toString(), 'stdout'));
      child.stderr?.on('data', (data) => emitter.emit('output', data.toString(), 'stderr'));
      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        emitter.emit('exit', code);
      });
      child.on('error', (error) => emitter.emit('error', error));
    };

    const events = this.createEventStream(task, emitter, spawnProcess, metrics);
    const result = this.createResultPromise(task, emitter, metrics);

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
            if (childProcess && !childProcess.killed) childProcess.kill('SIGKILL');
          }, 5000);
        }
        session.status = 'cancelled';
        session.completedAt = new Date();
      },
    };

    return session;
  }

  // ── CLI argument construction ──────────────────────────────────────────────
  //
  // Working directory is the child-process cwd (Pi has no --dir flag).
  // Model selection: `--model <pattern>` (supports `provider/id` and `:thinking`).
  // Provider: optional `--provider <name>` from PI_PROVIDER env.
  // Sovereign/egress hygiene is controlled by Pi env vars (PI_OFFLINE,
  // PI_SKIP_VERSION_CHECK, PI_TELEMETRY) passed through buildExecutorEnv.

  private buildPiArgs(task: Task, options?: ExecutorOptions): string[] {
    const args: string[] = ['--mode', 'json', '-p', '--no-session'];

    // Deterministic runs: ignore project-local .pi settings/extensions/skills.
    // AGENTS.md context files still load (they load before/without trust) so
    // workspace/project governance is respected. Use PI_NO_APPROVE=0 to allow.
    if ((process.env.PI_NO_APPROVE ?? '1') === '1') args.push('--no-approve');

    // Context files (AGENTS.md/CLAUDE.md): on by default for governance precedence.
    // Set PI_NO_CONTEXT_FILES=1 to disable and inject everything via system prompt.
    if (process.env.PI_NO_CONTEXT_FILES === '1') args.push('--no-context-files');

    // Disable project/user extensions and skills by default to avoid executing
    // arbitrary third-party code during automated runs. Override with env = '0'.
    if ((process.env.PI_NO_EXTENSIONS ?? '1') === '1') args.push('--no-extensions');
    if ((process.env.PI_NO_SKILLS ?? '1') === '1') args.push('--no-skills');

    if (process.env.PI_OFFLINE === '1') args.push('--offline');

    const provider = process.env.PI_PROVIDER;
    if (provider) args.push('--provider', provider);

    if (options?.model) {
      args.push('--model', options.model);
    } else if (process.env.PI_MODEL) {
      args.push('--model', process.env.PI_MODEL);
    }

    const thinking = process.env.PI_THINKING;
    if (thinking) args.push('--thinking', thinking);

    // Tool allowlist — the primary risk-control lever (drop `bash` for low-risk).
    const tools = process.env.PI_TOOLS;
    if (tools) args.push('--tools', tools);
    const excludeTools = process.env.PI_EXCLUDE_TOOLS;
    if (excludeTools) args.push('--exclude-tools', excludeTools);

    // Inject the djimitflo task as the prompt. Pi also reads piped stdin, but a
    // positional prompt is simplest and unambiguous for a spawned child.
    args.push(task.description);

    return args;
  }

  // ── Structured JSON event parsing ──────────────────────────────────────────

  private parseJsonEvent(line: string): PiEvent | null {
    try {
      const event = JSON.parse(line) as PiEvent;
      return typeof event.type === 'string' ? event : null;
    } catch {
      return null;
    }
  }

  private extractText(content?: PiContentBlock[]): string {
    if (!content) return '';
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  }

  private mapJsonEventToExecutionEvent(
    taskId: string,
    event: PiEvent,
    metrics: { tokenUsage: number; toolCalls: number; approvalsRequested: number },
  ): ExecutionEventCreateInput | null {
    switch (event.type) {
      case 'session':
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: 'Pi session started',
          level: LogLevel.INFO,
          metadata: {
            executor: 'pi',
            pi_session_id: event.id,
            pi_version: event.version,
            cwd: event.cwd,
          },
        };

      case 'agent_start':
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TASK_STARTED,
          message: 'Pi agent started',
          level: LogLevel.INFO,
          metadata: { executor: 'pi' },
        };

      case 'turn_start':
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: 'Pi turn started',
          level: LogLevel.DEBUG,
          metadata: { executor: 'pi' },
        };

      case 'tool_execution_start': {
        metrics.toolCalls++;
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TOOL_CALL,
          message: `Pi tool: ${event.toolName || 'unknown'}`,
          level: LogLevel.INFO,
          tool_name: event.toolName,
          tool_input: event.args,
          metadata: { executor: 'pi', toolCallId: event.toolCallId },
        };
      }

      case 'tool_execution_end': {
        const text = this.extractText(event.result?.content);
        if (event.isError) {
          return {
            task_id: taskId,
            event_type: ExecutionEventType.ERROR,
            message: `Pi tool ${event.toolName || 'unknown'} failed`,
            level: LogLevel.ERROR,
            tool_name: event.toolName,
            tool_error: text || undefined,
            metadata: { executor: 'pi', toolCallId: event.toolCallId, isError: true },
          };
        }
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TOOL_RESULT,
          message: `Pi tool ${event.toolName || 'unknown'} result`,
          level: LogLevel.INFO,
          tool_name: event.toolName,
          tool_output: text || undefined,
          metadata: { executor: 'pi', toolCallId: event.toolCallId },
        };
      }

      case 'message_start':
      case 'message_end': {
        const msg = event.message;
        if (!msg) return null;

        // Tool results also arrive as messages — surface them as TOOL_RESULT.
        if (msg.role === 'toolResult') {
          const text = this.extractText(msg.content);
          return {
            task_id: taskId,
            event_type: msg.isError ? ExecutionEventType.ERROR : ExecutionEventType.TOOL_RESULT,
            message: `Pi tool result: ${msg.toolName || 'unknown'}`,
            level: msg.isError ? LogLevel.ERROR : LogLevel.INFO,
            tool_name: msg.toolName,
            tool_output: text || undefined,
            metadata: { executor: 'pi', toolCallId: msg.toolCallId },
          };
        }

        if (msg.role === 'assistant') {
          // Capture token usage for metrics (carried on assistant messages).
          if (msg.usage?.totalTokens) {
            metrics.tokenUsage = Math.max(metrics.tokenUsage, msg.usage.totalTokens);
          }
          // Only emit a LOG on message_end to avoid flooding from text deltas.
          if (event.type === 'message_end') {
            const text = this.extractText(msg.content);
            // If the message is purely tool calls (no text), don't emit an empty log.
            if (text) {
              return {
                task_id: taskId,
                event_type: ExecutionEventType.LOG,
                message: text,
                level: LogLevel.INFO,
                metadata: {
                  executor: 'pi',
                  usage: msg.usage,
                  stopReason: msg.stopReason,
                },
              };
            }
          }
          return null;
        }

        // user messages: not echoed to the audit trail verbatim by default.
        return null;
      }

      case 'message_update': {
        // Surface tool-call decisions as TOOL_CALL; ignore text deltas (noise).
        const ame = event.assistantMessageEvent;
        if (ame && (ame.type === 'toolcall_start' || ame.type === 'toolcall_end')) {
          const name = ame.toolCall?.name || ame.partial?.content?.find((b) => b.type === 'toolCall')?.name;
          if (ame.type === 'toolcall_start' && name) {
            metrics.toolCalls++;
            return {
              task_id: taskId,
              event_type: ExecutionEventType.TOOL_CALL,
              message: `Pi requested tool: ${name}`,
              level: LogLevel.INFO,
              tool_name: name,
              tool_input: ame.toolCall?.arguments,
              metadata: { executor: 'pi', phase: 'toolcall_start' },
            };
          }
        }
        return null;
      }

      case 'turn_end': {
        // turn_end carries the assistant message + toolResults; capture final usage.
        const usage = event.message?.usage;
        if (usage?.totalTokens) {
          metrics.tokenUsage = Math.max(metrics.tokenUsage, usage.totalTokens);
        }
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: 'Pi turn ended',
          level: LogLevel.DEBUG,
          metadata: { executor: 'pi', usage, toolResultCount: event.toolResults?.length ?? 0 },
        };
      }

      case 'agent_end':
        return {
          task_id: taskId,
          event_type: ExecutionEventType.TASK_COMPLETED,
          message: 'Pi agent ended',
          level: LogLevel.INFO,
          metadata: { executor: 'pi' },
        };

      // compaction_*, auto_retry_*, queue_update — informational only.
      default:
        return {
          task_id: taskId,
          event_type: ExecutionEventType.LOG,
          message: `Pi event: ${event.type}`,
          level: LogLevel.DEBUG,
          metadata: { executor: 'pi', raw_type: event.type },
        };
    }
  }

  // ── Heuristic fallback for non-JSON lines (stderr / degraded mode) ────────

  private parseHeuristicLine(line: string, stream: 'stdout' | 'stderr'): ExecutionEventCreateInput {
    const lower = line.toLowerCase();
    if (stream === 'stderr' || lower.includes('error') || lower.includes('failed')) {
      return {
        task_id: '',
        event_type: ExecutionEventType.ERROR,
        message: line,
        level: LogLevel.ERROR,
        metadata: { executor: 'pi', parsing_mode: 'heuristic', stream },
      };
    }
    return {
      task_id: '',
      event_type: ExecutionEventType.LOG,
      message: line,
      level: LogLevel.INFO,
      metadata: { executor: 'pi', parsing_mode: 'heuristic', stream },
    };
  }

  // ── Event stream ───────────────────────────────────────────────────────────

  private async *createEventStream(
    task: Task,
    emitter: EventEmitter,
    spawnProcess: () => void,
    metrics: { tokenUsage: number; toolCalls: number; approvalsRequested: number },
  ): AsyncIterable<ExecutionEventCreateInput> {
    spawnProcess();

    yield {
      task_id: task.id,
      event_type: ExecutionEventType.TASK_STARTED,
      message: 'Pi execution started',
      level: LogLevel.INFO,
      metadata: {
        executor: 'pi',
        pi_path: this.piPath,
        sovereign_egress_hygiene: process.env.PI_OFFLINE === '1',
      },
    };

    // Security note: Pi has no permission popups; djimitflo is the sole boundary.
    yield {
      task_id: task.id,
      event_type: ExecutionEventType.LOG,
      message:
        'SECURITY: Pi has no built-in permission system and runs with user permissions. djimitflo policy engine is the sole approval boundary; capability is restricted via --tools.',
      level: LogLevel.WARNING,
      metadata: { security_note: 'pi_no_permissions', tools_allowlist: process.env.PI_TOOLS ?? null },
    };

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
          metadata: { executor: 'pi', error: error.stack },
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

          if (useJsonParsing && stream === 'stdout') {
            const jsonEvent = this.parseJsonEvent(trimmed);
            if (jsonEvent) {
              const mapped = this.mapJsonEventToExecutionEvent(task.id, jsonEvent, metrics);
              if (mapped) yield mapped;
            } else {
              if (!heuristicWarningEmitted) {
                heuristicWarningEmitted = true;
                useJsonParsing = false;
                yield {
                  task_id: task.id,
                  event_type: ExecutionEventType.LOG,
                  message:
                    'EVIDENCE WARNING: non-JSON line on stdout; falling back to heuristic parsing for subsequent lines.',
                  level: LogLevel.WARNING,
                  metadata: { parsing_mode: 'heuristic_fallback', reason: 'non_json_stdout' },
                };
              }
              const parsed = this.parseHeuristicLine(trimmed, stream);
              parsed.task_id = task.id;
              yield parsed;
            }
          } else {
            const parsed = this.parseHeuristicLine(trimmed, stream);
            parsed.task_id = task.id;
            yield parsed;
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (useJsonParsing) {
        const jsonEvent = this.parseJsonEvent(trimmed);
        if (jsonEvent) {
          const mapped = this.mapJsonEventToExecutionEvent(task.id, jsonEvent, metrics);
          if (mapped) yield mapped;
        }
      } else {
        const parsed = this.parseHeuristicLine(trimmed, 'stdout');
        parsed.task_id = task.id;
        yield parsed;
      }
    }

    if (exitCode === 0) {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_COMPLETED,
        message: 'Pi execution completed successfully',
        level: LogLevel.INFO,
        metadata: { executor: 'pi', exit_code: exitCode, token_usage: metrics.tokenUsage, tool_calls: metrics.toolCalls },
      };
    } else {
      yield {
        task_id: task.id,
        event_type: ExecutionEventType.TASK_FAILED,
        message: `Pi execution failed with exit code ${exitCode}`,
        level: LogLevel.ERROR,
        metadata: { executor: 'pi', exit_code: exitCode, token_usage: metrics.tokenUsage, tool_calls: metrics.toolCalls },
      };
    }
  }

  // ── Result promise ─────────────────────────────────────────────────────────

  private async createResultPromise(
    _task: Task,
    emitter: EventEmitter,
    metrics: { tokenUsage: number; toolCalls: number; approvalsRequested: number },
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      emitter.on('exit', (code: number) => {
        if (code === 0) {
          resolve({
            status: 'completed',
            message: 'Pi execution completed successfully',
            metrics: { executionTimeMs: 0, tokenUsage: metrics.tokenUsage, toolCalls: metrics.toolCalls },
          });
        } else {
          resolve({
            status: 'failed',
            message: `Pi execution failed with exit code ${code}`,
            error: `Process exited with code ${code}`,
            metrics: { executionTimeMs: 0, tokenUsage: metrics.tokenUsage, toolCalls: metrics.toolCalls },
          });
        }
      });
      emitter.on('error', (error: Error) => {
        resolve({
          status: 'failed',
          message: `Pi execution error: ${error.message}`,
          error: error.stack,
          metrics: { executionTimeMs: 0, tokenUsage: metrics.tokenUsage, toolCalls: metrics.toolCalls },
        });
      });
    });
  }
}
