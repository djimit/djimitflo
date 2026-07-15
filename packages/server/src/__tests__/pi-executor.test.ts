import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { ExecutionEventType, LogLevel } from '@djimitflo/shared';
import { PiExecutor } from '../execution/executors/pi-executor';
import { buildPiArgs, mapPiEvent } from '../execution/executors/pi-shared';

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

const PI_ENV_KEYS = [
  'PI_NO_APPROVE', 'PI_NO_CONTEXT_FILES', 'PI_NO_EXTENSIONS', 'PI_NO_SKILLS',
  'PI_OFFLINE', 'PI_PROVIDER', 'PI_MODEL', 'PI_THINKING', 'PI_TOOLS', 'PI_EXCLUDE_TOOLS',
];

describe('buildPiArgs', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    for (const key of PI_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('builds the headless json invocation with deterministic flags on by default', () => {
    const args = buildPiArgs(makeTask({ description: 'test prompt' }));

    expect(args.slice(0, 4)).toEqual(['--mode', 'json', '-p', '--no-session']);
    // default-on hygiene flags (PI_NO_APPROVE / PI_NO_EXTENSIONS / PI_NO_SKILLS default to '1')
    expect(args).toContain('--no-approve');
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--no-skills');
    // default-off flags
    expect(args).not.toContain('--no-context-files');
    expect(args).not.toContain('--offline');
    // prompt is the trailing positional
    expect(args[args.length - 1]).toBe('test prompt');
  });

  it('allows disabling the default-on flags via env', () => {
    process.env.PI_NO_APPROVE = '0';
    process.env.PI_NO_EXTENSIONS = '0';
    process.env.PI_NO_SKILLS = '0';
    const args = buildPiArgs(makeTask());

    expect(args).not.toContain('--no-approve');
    expect(args).not.toContain('--no-extensions');
    expect(args).not.toContain('--no-skills');
  });

  it('prefers options.model over PI_MODEL env', () => {
    process.env.PI_MODEL = 'env-model';
    const optArgs = buildPiArgs(makeTask(), { model: 'option-model' });
    expect(optArgs[optArgs.indexOf('--model') + 1]).toBe('option-model');

    const envArgs = buildPiArgs(makeTask());
    expect(envArgs[envArgs.indexOf('--model') + 1]).toBe('env-model');

    delete process.env.PI_MODEL;
    expect(buildPiArgs(makeTask())).not.toContain('--model');
  });

  it('passes provider, thinking, tools allowlist, and offline flag from env', () => {
    process.env.PI_PROVIDER = 'ollama';
    process.env.PI_THINKING = 'high';
    process.env.PI_TOOLS = 'read,ls';
    process.env.PI_EXCLUDE_TOOLS = 'bash';
    process.env.PI_OFFLINE = '1';
    const args = buildPiArgs(makeTask());

    expect(args[args.indexOf('--provider') + 1]).toBe('ollama');
    expect(args[args.indexOf('--thinking') + 1]).toBe('high');
    expect(args[args.indexOf('--tools') + 1]).toBe('read,ls');
    expect(args[args.indexOf('--exclude-tools') + 1]).toBe('bash');
    expect(args).toContain('--offline');
  });
});

describe('mapPiEvent', () => {
  const metrics = () => ({ tokenUsage: 0, toolCalls: 0, approvalsRequested: 0 });

  it('maps the lifecycle events to execution events', () => {
    const start = mapPiEvent('t1', { type: 'agent_start' }, metrics());
    expect(start?.event_type).toBe(ExecutionEventType.TASK_STARTED);

    const end = mapPiEvent('t1', { type: 'agent_end' }, metrics());
    expect(end?.event_type).toBe(ExecutionEventType.TASK_COMPLETED);

    const session = mapPiEvent('t1', { type: 'session', id: 's1', version: 3, cwd: '/w' }, metrics());
    expect(session?.event_type).toBe(ExecutionEventType.LOG);
    expect(session?.metadata).toMatchObject({ pi_session_id: 's1', cwd: '/w' });
  });

  it('maps tool execution events and flags tool errors', () => {
    const call = mapPiEvent('t1', { type: 'tool_execution_start', toolName: 'ls', toolCallId: 'c1' }, metrics());
    expect(call?.event_type).toBe(ExecutionEventType.TOOL_CALL);
    expect(call?.metadata).toMatchObject({ tool_name: 'ls' });

    const ok = mapPiEvent('t1', { type: 'tool_execution_end', toolName: 'ls', isError: false }, metrics());
    expect(ok?.event_type).toBe(ExecutionEventType.TOOL_RESULT);
    expect(ok?.level).toBe(LogLevel.INFO);

    const failed = mapPiEvent('t1', { type: 'tool_execution_end', toolName: 'bash', isError: true }, metrics());
    expect(failed?.level).toBe(LogLevel.ERROR);
  });

  it('returns null for events that should not reach the audit trail', () => {
    expect(mapPiEvent('t1', { type: 'message_update' }, metrics())).toBeNull();
    expect(mapPiEvent('t1', { type: 'turn_start' }, metrics())).toBeNull();
  });
});

describe('PiExecutor', () => {
  it('parses only valid typed JSON lines', () => {
    const executor = new PiExecutor('/usr/bin/pi');
    expect((executor as any).parseJsonEvent('{"type":"agent_start"}')).toMatchObject({ type: 'agent_start' });
    expect((executor as any).parseJsonEvent('{"no_type":true}')).toBeNull();
    expect((executor as any).parseJsonEvent('not json at all')).toBeNull();
  });

  it('captures token usage from assistant message_end and maps toolResult messages', () => {
    const executor = new PiExecutor('/usr/bin/pi');
    const metrics = { tokenUsage: 0, toolCalls: 0, approvalsRequested: 0 };

    const logEvent = (executor as any).mapJsonEventToExecutionEvent('t1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { totalTokens: 123 } },
    }, metrics);
    expect(metrics.tokenUsage).toBe(123);
    expect(logEvent?.event_type).toBe(ExecutionEventType.LOG);
    expect(logEvent?.message).toBe('done');

    const toolResult = (executor as any).mapJsonEventToExecutionEvent('t1', {
      type: 'message_end',
      message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] },
    }, metrics);
    expect(toolResult?.event_type).toBe(ExecutionEventType.TOOL_RESULT);
    expect(toolResult?.tool_output).toBe('file contents');
  });

  it('classifies stderr and error-like lines in heuristic fallback', () => {
    const executor = new PiExecutor('/usr/bin/pi');
    expect((executor as any).parseHeuristicLine('anything', 'stderr').event_type).toBe(ExecutionEventType.ERROR);
    expect((executor as any).parseHeuristicLine('operation failed', 'stdout').event_type).toBe(ExecutionEventType.ERROR);
    expect((executor as any).parseHeuristicLine('all good', 'stdout').event_type).toBe(ExecutionEventType.LOG);
  });
});
