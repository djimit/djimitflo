import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';
import type { Task } from '@djimitflo/shared';
import type { ExecutorOptions } from '../execution/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-id',
    title: 'Test task',
    description: 'echo hello world',
    status: 'pending' as any,
    priority: 'medium' as any,
    risk_level: 'low' as any,
    execution_mode: 'local' as any,
    agent_id: null,
    parent_task_id: null,
    repository_id: null,
    instruction_profile_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    execution_time_ms: null,
    token_usage: null,
    tags: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('OpenCodeExecutor', () => {
  let executor: OpenCodeExecutor;

  beforeEach(() => {
    executor = new OpenCodeExecutor('/usr/bin/opencode');
  });

  describe('canExecute', () => {
    it('returns true for any task', () => {
      expect(executor.canExecute(makeTask())).toBe(true);
    });
  });

  describe('buildOpenCodeArgs — correct flags', () => {
    it('includes run command and --format json by default', () => {
      const task = makeTask({ description: 'test prompt' });
      const args = (executor as any).buildOpenCodeArgs(task, {});
      expect(args[0]).toBe('run');
      expect(args).toContain('--format');
      expect(args[args.indexOf('--format') + 1]).toBe('json');
    });

    it('uses --dir for working directory instead of --cwd', () => {
      const task = makeTask({ description: 'test prompt' });
      const options: ExecutorOptions = { workingDirectory: '/tmp/project' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).toContain('--dir');
      expect(args).not.toContain('--cwd');
      expect(args[args.indexOf('--dir') + 1]).toBe('/tmp/project');
    });

    it('uses --model for model selection', () => {
      const task = makeTask({ description: 'test prompt' });
      const options: ExecutorOptions = { model: 'anthropic/claude-sonnet-4-20250514' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-20250514');
    });

    it('uses --agent for agent selection', () => {
      const task = makeTask({ description: 'test prompt' });
      const options: ExecutorOptions = { agentKind: 'build' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).toContain('--agent');
      expect(args[args.indexOf('--agent') + 1]).toBe('build');
    });

    it('places task description as last positional argument', () => {
      const task = makeTask({ description: 'fix the bug' });
      const args = (executor as any).buildOpenCodeArgs(task, {});
      expect(args[args.length - 1]).toBe('fix the bug');
    });
  });

  describe('buildOpenCodeArgs — invalid flags NOT generated', () => {
    it('never generates --cwd', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = { workingDirectory: '/tmp' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).not.toContain('--cwd');
    });

    it('never generates --temperature', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = {};
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).not.toContain('--temperature');
    });

    it('never generates --max-tokens', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = {};
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).not.toContain('--max-tokens');
    });
  });

  describe('buildOpenCodeArgs — skip permissions', () => {
    it('does NOT include --dangerously-skip-permissions when skipPermissions is false', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = { skipPermissions: false };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('does NOT include --dangerously-skip-permissions when skipPermissions is undefined', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = {};
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('includes --dangerously-skip-permissions when skipPermissions is true', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = { skipPermissions: true };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('respects OPENCODE_SKIP_PERMISSIONS env var when options not provided', () => {
      const originalEnv = process.env.OPENCODE_SKIP_PERMISSIONS;
      process.env.OPENCODE_SKIP_PERMISSIONS = 'true';
      const envExecutor = new OpenCodeExecutor('/usr/bin/opencode');
      const task = makeTask({ description: 'test' });
      const args = (envExecutor as any).buildOpenCodeArgs(task, {});
      expect(args).toContain('--dangerously-skip-permissions');
      process.env.OPENCODE_SKIP_PERMISSIONS = originalEnv;
    });

    it('defaults skip permissions to false when env var is not "true"', () => {
      const originalEnv = process.env.OPENCODE_SKIP_PERMISSIONS;
      delete process.env.OPENCODE_SKIP_PERMISSIONS;
      const envExecutor = new OpenCodeExecutor('/usr/bin/opencode');
      const task = makeTask({ description: 'test' });
      const args = (envExecutor as any).buildOpenCodeArgs(task, {});
      expect(args).not.toContain('--dangerously-skip-permissions');
      if (originalEnv !== undefined) process.env.OPENCODE_SKIP_PERMISSIONS = originalEnv;
    });
  });

  describe('buildOpenCodeArgs — format', () => {
    it('uses --format json when format is json', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = { format: 'json' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).toContain('--format');
      expect(args[args.indexOf('--format') + 1]).toBe('json');
    });

    it('omits --format when format is default', () => {
      const task = makeTask({ description: 'test' });
      const options: ExecutorOptions = { format: 'default' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args).not.toContain('--format');
    });
  });

  describe('buildOpenCodeArgs — systemPrompt (AGENTS.md injection)', () => {
    it('prepends AGENTS.md context with delimiters to task description', () => {
      const task = makeTask({ description: 'fix the bug' });
      const options: ExecutorOptions = { systemPrompt: '# Repo Rules\n- Use npm test' };
      const args = (executor as any).buildOpenCodeArgs(task, options);
      expect(args[args.length - 1]).toBe('[CONTEXT FROM AGENTS.md]\n# Repo Rules\n- Use npm test\n[END CONTEXT]\n\nfix the bug');
    });

    it('uses task description as-is when systemPrompt is not provided', () => {
      const task = makeTask({ description: 'fix the bug' });
      const args = (executor as any).buildOpenCodeArgs(task, {});
      expect(args[args.length - 1]).toBe('fix the bug');
    });

    it('handles empty systemPrompt gracefully', () => {
      const task = makeTask({ description: 'fix the bug' });
      const args = (executor as any).buildOpenCodeArgs(task, { systemPrompt: '' });
      expect(args[args.length - 1]).toBe('fix the bug');
    });
  });

  describe('parseJsonEvent — structured JSON parsing', () => {
    it('parses step_start event', () => {
      const line = JSON.stringify({ type: 'step_start', sessionID: 'ses_123', timestamp: 1234, part: { type: 'step-start', id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_123' } });
      const result = (executor as any).parseJsonEvent(line);
      expect(result).not.toBeNull();
      expect(result.type).toBe('step_start');
      expect(result.sessionID).toBe('ses_123');
    });

    it('parses tool_use event', () => {
      const line = JSON.stringify({ type: 'tool_use', sessionID: 'ses_123', timestamp: 1234, part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed' }, id: 'prt_2', messageID: 'msg_1', sessionID: 'ses_123' } });
      const result = (executor as any).parseJsonEvent(line);
      expect(result).not.toBeNull();
      expect(result.type).toBe('tool_use');
      expect(result.part.tool).toBe('bash');
    });

    it('parses text event', () => {
      const line = JSON.stringify({ type: 'text', sessionID: 'ses_123', timestamp: 1234, part: { type: 'text', text: 'hello world', id: 'prt_3', messageID: 'msg_1', sessionID: 'ses_123' } });
      const result = (executor as any).parseJsonEvent(line);
      expect(result).not.toBeNull();
      expect(result.type).toBe('text');
      expect(result.part.text).toBe('hello world');
    });

    it('parses step_finish event', () => {
      const line = JSON.stringify({ type: 'step_finish', sessionID: 'ses_123', timestamp: 1234, part: { type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, id: 'prt_4', messageID: 'msg_1', sessionID: 'ses_123' } });
      const result = (executor as any).parseJsonEvent(line);
      expect(result).not.toBeNull();
      expect(result.type).toBe('step_finish');
    });

    it('returns null for blank lines', () => {
      expect((executor as any).parseJsonEvent('')).toBeNull();
      expect((executor as any).parseJsonEvent('   ')).toBeNull();
    });

    it('returns null for non-JSON lines', () => {
      expect((executor as any).parseJsonEvent('Using tool: bash')).toBeNull();
      expect((executor as any).parseJsonEvent('some random text')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect((executor as any).parseJsonEvent('{invalid json')).toBeNull();
    });

    it('returns null for JSON without type field', () => {
      expect((executor as any).parseJsonEvent('{"foo":"bar"}')).toBeNull();
    });
  });

  describe('mapJsonEventToExecutionEvent — step_start', () => {
    it('maps step_start to TASK_STARTED', () => {
      const event = { type: 'step_start', sessionID: 'ses_123', timestamp: 1234, part: { type: 'step-start', id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_123' } };
      const result = (executor as any).mapJsonEventToExecutionEvent('task-1', event);
      expect(result).not.toBeNull();
      expect(result.event_type).toBe('task.started');
      expect(result.metadata.executor).toBe('opencode');
    });
  });

  describe('mapJsonEventToExecutionEvent — tool_use', () => {
    it('maps tool_use to TOOL_CALL with tool name', () => {
      const event = { type: 'tool_use', sessionID: 'ses_123', timestamp: 1234, part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'ls' } }, id: 'prt_2', messageID: 'msg_1', sessionID: 'ses_123' } };
      const result = (executor as any).mapJsonEventToExecutionEvent('task-1', event);
      expect(result).not.toBeNull();
      expect(result.event_type).toBe('tool.call');
      expect(result.tool_name).toBe('bash');
    });
  });

  describe('mapJsonEventToExecutionEvent — text', () => {
    it('maps text event to LOG with message text', () => {
      const event = { type: 'text', sessionID: 'ses_123', timestamp: 1234, part: { type: 'text', text: 'result text', id: 'prt_3', messageID: 'msg_1', sessionID: 'ses_123' } };
      const result = (executor as any).mapJsonEventToExecutionEvent('task-1', event);
      expect(result).not.toBeNull();
      expect(result.event_type).toBe('log');
      expect(result.message).toBe('result text');
    });
  });

  describe('mapJsonEventToExecutionEvent — step_finish', () => {
    it('maps step_finish with reason "stop" to TASK_COMPLETED', () => {
      const event = { type: 'step_finish', sessionID: 'ses_123', timestamp: 1234, part: { type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, id: 'prt_4', messageID: 'msg_1', sessionID: 'ses_123' } };
      const result = (executor as any).mapJsonEventToExecutionEvent('task-1', event);
      expect(result).not.toBeNull();
      expect(result.event_type).toBe('task.completed');
      expect(result.metadata.tokens).toEqual({ total: 100, input: 80, output: 20 });
    });

    it('maps step_finish with reason "error" to TASK_FAILED', () => {
      const event = { type: 'step_finish', sessionID: 'ses_123', timestamp: 1234, part: { type: 'step-finish', reason: 'error', id: 'prt_4', messageID: 'msg_1', sessionID: 'ses_123' } };
      const result = (executor as any).mapJsonEventToExecutionEvent('task-1', event);
      expect(result).not.toBeNull();
      expect(result.event_type).toBe('task.failed');
    });
  });

  describe('mapJsonEventToExecutionEvent — unknown event type', () => {
    it('maps unknown event type to LOG with raw type in metadata', () => {
      const event = { type: 'custom_event', sessionID: 'ses_123', part: { type: 'custom', data: 'test' } };
      const result = (executor as any).mapJsonEventToExecutionEvent('task-1', event);
      expect(result).not.toBeNull();
      expect(result.event_type).toBe('log');
      expect(result.metadata.raw_type).toBe('custom_event');
    });
  });

  describe('parseHeuristicLine — fallback parsing', () => {
    it('detects tool calls from "Using tool:" pattern', () => {
      const result = (executor as any).parseHeuristicLine('Using tool: bash', 'stdout');
      expect(result.type).toBe('tool_call');
    });

    it('detects tool calls from "Tool:" pattern', () => {
      const result = (executor as any).parseHeuristicLine('Tool: Read', 'stdout');
      expect(result.type).toBe('tool_call');
    });

    it('detects tool results from "Tool result:" pattern', () => {
      const result = (executor as any).parseHeuristicLine('Tool result: success', 'stdout');
      expect(result.type).toBe('tool_result');
    });

    it('detects errors from stderr stream', () => {
      const result = (executor as any).parseHeuristicLine('some output', 'stderr');
      expect(result.type).toBe('error');
    });

    it('detects errors from "error" keyword', () => {
      const result = (executor as any).parseHeuristicLine('Error: permission denied', 'stdout');
      expect(result.type).toBe('error');
    });

    it('defaults to log for unknown patterns', () => {
      const result = (executor as any).parseHeuristicLine('some regular output', 'stdout');
      expect(result.type).toBe('log');
    });
  });

  describe('extractToolName — heuristic extraction', () => {
    it('extracts tool name from "Using tool:" pattern', () => {
      expect((executor as any).extractToolName('Using tool: bash')).toBe('bash');
    });

    it('extracts tool name from "Tool:" pattern', () => {
      expect((executor as any).extractToolName('Tool: Read')).toBe('Read');
    });

    it('returns undefined for non-matching lines', () => {
      expect((executor as any).extractToolName('some random text')).toBeUndefined();
    });
  });

  describe('constructor — environment variables', () => {
    it('uses OPENCODE_BIN_PATH from environment', () => {
      const original = process.env.OPENCODE_BIN_PATH;
      process.env.OPENCODE_BIN_PATH = '/custom/path/opencode';
      const customExecutor = new OpenCodeExecutor();
      expect((customExecutor as any).opencodePath).toBe('/custom/path/opencode');
      if (original !== undefined) process.env.OPENCODE_BIN_PATH = original;
      else delete process.env.OPENCODE_BIN_PATH;
    });

    it('uses default binary path when env var not set', () => {
      const original = process.env.OPENCODE_BIN_PATH;
      delete process.env.OPENCODE_BIN_PATH;
      const defaultExecutor = new OpenCodeExecutor();
      expect((defaultExecutor as any).opencodePath).toBe('opencode');
      if (original !== undefined) process.env.OPENCODE_BIN_PATH = original;
    });

    it('uses constructor argument over env var', () => {
      process.env.OPENCODE_BIN_PATH = '/env/path/opencode';
      const overrideExecutor = new OpenCodeExecutor('/arg/path/opencode');
      expect((overrideExecutor as any).opencodePath).toBe('/arg/path/opencode');
      delete process.env.OPENCODE_BIN_PATH;
    });

    it('uses OPENCODE_EXECUTION_TIMEOUT_MS from environment', () => {
      const original = process.env.OPENCODE_EXECUTION_TIMEOUT_MS;
      process.env.OPENCODE_EXECUTION_TIMEOUT_MS = '300000';
      const timeoutExecutor = new OpenCodeExecutor();
      expect((timeoutExecutor as any).executionTimeoutMs).toBe(300000);
      if (original !== undefined) process.env.OPENCODE_EXECUTION_TIMEOUT_MS = original;
      else delete process.env.OPENCODE_EXECUTION_TIMEOUT_MS;
    });

    it('defaults timeout to 600000ms', () => {
      const original = process.env.OPENCODE_EXECUTION_TIMEOUT_MS;
      delete process.env.OPENCODE_EXECUTION_TIMEOUT_MS;
      const defaultExecutor = new OpenCodeExecutor();
      expect((defaultExecutor as any).executionTimeoutMs).toBe(600000);
      if (original !== undefined) process.env.OPENCODE_EXECUTION_TIMEOUT_MS = original;
    });
  });
});