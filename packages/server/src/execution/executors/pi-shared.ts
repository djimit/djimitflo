/**
 * Shared Pi helpers — extracted from pi-executor.ts for reuse by the loop runtime.
 * No behavior change: the executor imports these instead of defining them privately.
 */
import { Task, ExecutionEventType, ExecutionEventCreateInput, LogLevel } from '@djimitflo/shared';

export interface PiEvent {
  type: string;
  id?: string;
  version?: number;
  cwd?: string;
  message?: {
    role?: string;
    content?: any[];
    usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
    stopReason?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { content: Array<{ type: string; text?: string }>; isError?: boolean };
  isError?: boolean;
  toolResults?: any[];
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    partial?: any;
    toolCall?: { type: string; id: string; name: string; arguments: Record<string, unknown> };
    delta?: string;
  };
}

export interface PiExecutorOptions {
  model?: string;
  workingDirectory?: string;
}

/**
 * Build Pi CLI args from a task and options.
 * Uses PI_* environment variables for provider, model, tools, and deterministic flags.
 */
export function buildPiArgs(task: Task, options?: PiExecutorOptions): string[] {
  const args: string[] = ['--mode', 'json', '-p', '--no-session'];

  if ((process.env.PI_NO_APPROVE ?? '1') === '1') args.push('--no-approve');
  if (process.env.PI_NO_CONTEXT_FILES === '1') args.push('--no-context-files');
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

  const tools = process.env.PI_TOOLS;
  if (tools) args.push('--tools', tools);
  const excludeTools = process.env.PI_EXCLUDE_TOOLS;
  if (excludeTools) args.push('--exclude-tools', excludeTools);

  args.push(task.description);
  return args;
}

/**
 * Map a Pi NDJSON event to a djimitflo ExecutionEvent.
 * Returns null for events that don't produce an execution event (e.g. text deltas).
 */
export function mapPiEvent(
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
        metadata: { executor: 'pi', pi_session_id: event.id, pi_version: event.version, cwd: event.cwd },
      };
    case 'agent_start':
      return {
        task_id: taskId,
        event_type: ExecutionEventType.TASK_STARTED,
        message: 'Pi agent started',
        level: LogLevel.INFO,
        metadata: { executor: 'pi' },
      };
    case 'agent_end':
      return {
        task_id: taskId,
        event_type: ExecutionEventType.TASK_COMPLETED,
        message: 'Pi agent completed',
        level: LogLevel.INFO,
        metadata: { executor: 'pi', token_usage: metrics.tokenUsage, tool_calls: metrics.toolCalls },
      };
    case 'tool_execution_start':
      return {
        task_id: taskId,
        event_type: ExecutionEventType.TOOL_CALL,
        message: `Pi tool: ${event.toolName}`,
        level: LogLevel.INFO,
        metadata: { executor: 'pi', tool_name: event.toolName, tool_call_id: event.toolCallId },
      };
    case 'tool_execution_end':
      return {
        task_id: taskId,
        event_type: ExecutionEventType.TOOL_RESULT,
        message: `Pi tool result: ${event.toolName}`,
        level: event.isError ? LogLevel.ERROR : LogLevel.INFO,
        metadata: { executor: 'pi', tool_name: event.toolName, is_error: event.isError },
      };
    default:
      return null;
  }
}
