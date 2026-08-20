import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildPiArgs, mapPiEvent, type PiEvent } from '../execution/executors/pi-shared';
import { Task, ExecutionEventType, LogLevel } from '@djimitflo/shared';

function mockTask(): Task {
  return { id: 't1', description: 'Fix the bug' } as unknown as Task;
}

describe('buildPiArgs', () => {
  afterEach(() => {
    delete process.env.PI_NO_APPROVE;
    delete process.env.PI_NO_CONTEXT_FILES;
    delete process.env.PI_NO_EXTENSIONS;
    delete process.env.PI_NO_SKILLS;
    delete process.env.PI_OFFLINE;
    delete process.env.PI_PROVIDER;
    delete process.env.PI_MODEL;
    delete process.env.PI_THINKING;
    delete process.env.PI_TOOLS;
    delete process.env.PI_EXCLUDE_TOOLS;
  });

  it('includes base flags and task description', () => {
    const args = buildPiArgs(mockTask());
    expect(args).toContain('--mode');
    expect(args).toContain('json');
    expect(args).toContain('--no-approve');
    expect(args).toContain('--no-extensions');
    expect(args.at(-1)).toBe('Fix the bug');
  });

  it('respects PI_NO_APPROVE=0 (skips --no-approve)', () => {
    process.env.PI_NO_APPROVE = '0';
    const args = buildPiArgs(mockTask());
    expect(args).not.toContain('--no-approve');
  });

  it('uses options.model over PI_MODEL env', () => {
    process.env.PI_MODEL = 'env-model';
    const args = buildPiArgs(mockTask(), { model: 'opt-model' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opt-model');
  });

  it('falls back to PI_MODEL when no options.model', () => {
    process.env.PI_MODEL = 'env-model';
    const args = buildPiArgs(mockTask());
    expect(args[args.indexOf('--model') + 1]).toBe('env-model');
  });

  it('adds --offline when PI_OFFLINE=1', () => {
    process.env.PI_OFFLINE = '1';
    const args = buildPiArgs(mockTask());
    expect(args).toContain('--offline');
  });
});

describe('mapPiEvent', () => {
  const metrics = { tokenUsage: 100, toolCalls: 3, approvalsRequested: 0 };

  it('maps session event to LOG', () => {
    const event: PiEvent = { type: 'session', id: 's1', version: 1, cwd: '/repo' };
    const result = mapPiEvent('t1', event, metrics);
    expect(result?.event_type).toBe(ExecutionEventType.LOG);
    expect(result?.level).toBe(LogLevel.INFO);
  });

  it('maps agent_start to TASK_STARTED', () => {
    const result = mapPiEvent('t1', { type: 'agent_start' }, metrics);
    expect(result?.event_type).toBe(ExecutionEventType.TASK_STARTED);
  });

  it('maps agent_end to TASK_COMPLETED with metrics', () => {
    const result = mapPiEvent('t1', { type: 'agent_end' }, metrics);
    expect(result?.event_type).toBe(ExecutionEventType.TASK_COMPLETED);
    expect(result?.metadata).toHaveProperty('token_usage', 100);
  });

  it('maps tool_execution_start to TOOL_CALL', () => {
    const result = mapPiEvent('t1', { type: 'tool_execution_start', toolName: 'read_file', toolCallId: 'tc1' }, metrics);
    expect(result?.event_type).toBe(ExecutionEventType.TOOL_CALL);
    expect(result?.message).toContain('read_file');
  });

  it('maps tool_execution_end with isError to ERROR level', () => {
    const result = mapPiEvent('t1', { type: 'tool_execution_end', toolName: 'write_file', isError: true }, metrics);
    expect(result?.event_type).toBe(ExecutionEventType.TOOL_RESULT);
    expect(result?.level).toBe(LogLevel.ERROR);
  });

  it('returns null for unknown event types', () => {
    const result = mapPiEvent('t1', { type: 'text_delta' }, metrics);
    expect(result).toBeNull();
  });
});