import { ExecutionEventType, LogLevel, type ExecutionEventCreateInput } from '@djimitflo/shared';

type RuntimeKind = 'claude' | 'gemini' | 'editor' | 'codex' | 'opencode' | 'pi';

function usageOf(value: any): Record<string, number> | undefined {
  const usage = value?.usage ?? value?.tokens ?? value?.stats ?? value?.metrics;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? usage.totalTokens ?? input + output),
    cost_usd: Number(usage.cost_usd ?? usage.cost ?? value?.cost_usd ?? value?.cost ?? 0),
  };
}

export function structuredRuntimeEvent(executor: RuntimeKind, taskId: string, value: any): ExecutionEventCreateInput {
  const block = Array.isArray(value?.message?.content)
    ? value.message.content.find((part: any) => ['tool_use', 'tool_result', 'text'].includes(part?.type)) ?? value
    : value?.part ?? value;
  const type = String(block?.type ?? value?.type ?? '').toLowerCase().replaceAll('-', '_');
  const usage = usageOf(value) ?? usageOf(block);
  const metadata = { executor, parsing_mode: 'json', ...(usage ? { usage } : {}), raw: value };

  if (type.includes('tool_use') || type === 'tool_call' || type === 'tool' || type === 'ask') {
    const tool = String(block?.name ?? block?.tool ?? block?.ask ?? 'tool');
    return { task_id: taskId, event_type: ExecutionEventType.TOOL_CALL, message: `Tool call: ${tool}`, level: LogLevel.INFO, tool_name: tool, tool_input: block?.input ?? block?.arguments ?? block, metadata };
  }
  if (type.includes('tool_result') || type === 'tool_response') {
    const tool = String(block?.name ?? block?.tool ?? 'tool');
    return { task_id: taskId, event_type: ExecutionEventType.TOOL_RESULT, message: `Tool result: ${tool}`, level: block?.is_error ? LogLevel.ERROR : LogLevel.INFO, tool_name: tool, tool_output: block?.content ?? block?.output ?? block, metadata };
  }
  if (type.includes('error') || value?.error) {
    return { task_id: taskId, event_type: ExecutionEventType.ERROR, message: String(value?.error?.message ?? value?.error ?? block?.message ?? 'Runtime error'), level: LogLevel.ERROR, metadata };
  }

  const message = block?.text ?? value?.response ?? value?.result ?? value?.text ?? value?.message ?? `JSON event: ${type || 'object'}`;
  return { task_id: taskId, event_type: ExecutionEventType.LOG, message: typeof message === 'string' ? message : JSON.stringify(message), level: LogLevel.INFO, metadata };
}
