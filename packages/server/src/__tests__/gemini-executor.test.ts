import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import type { ExecutorOptions } from '../execution/types';
import { GeminiExecutor } from '../execution/executors/gemini-executor';

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

describe('GeminiExecutor', () => {
  let executor: GeminiExecutor;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DJIMITFLO_GEMINI_MODEL;
    executor = new GeminiExecutor('/usr/bin/gemini');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('builds the headless gemini invocation with -p, -o json, and the prompt positional', () => {
    const task = makeTask({ description: 'test prompt' });
    const options: ExecutorOptions = { workingDirectory: '/tmp/project', format: 'json' };
    const args = (executor as any).buildGeminiArgs(task, options);

    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('test prompt');
    expect(args).toContain('-o');
    expect(args[args.indexOf('-o') + 1]).toBe('json');
    // gemini inherits cwd via spawn — no --cwd/--dir flag
    expect(args).not.toContain('--cwd');
    expect(args).not.toContain('--dir');
    // prompt is the -p value (index 1), not the trailing positional
    expect(args[args.indexOf('-p') + 1]).toBe('test prompt');
  });

  it('uses the -y bypass flag only when explicitly requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const defaultArgs = (executor as any).buildGeminiArgs(task, {});
    expect(defaultArgs).not.toContain('-y');

    const bypassArgs = (executor as any).buildGeminiArgs(task, { skipPermissions: true });
    expect(bypassArgs).toContain('-y');
  });

  it('injects -m model from ExecutorOptions or DJIMITFLO_GEMINI_MODEL', () => {
    const task = makeTask({ description: 'test prompt' });

    const optArgs = (executor as any).buildGeminiArgs(task, { model: 'gemini-2.5-pro' });
    expect(optArgs).toContain('-m');
    expect(optArgs[optArgs.indexOf('-m') + 1]).toBe('gemini-2.5-pro');

    process.env.DJIMITFLO_GEMINI_MODEL = 'gemini-2.5-flash';
    const envArgs = (executor as any).buildGeminiArgs(task, {});
    expect(envArgs[envArgs.indexOf('-m') + 1]).toBe('gemini-2.5-flash');

    delete process.env.DJIMITFLO_GEMINI_MODEL;
    const noModelArgs = (executor as any).buildGeminiArgs(task, {});
    expect(noModelArgs).not.toContain('-m');
  });

  it('omits -o json when default output is requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const args = (executor as any).buildGeminiArgs(task, { format: 'default' });
    expect(args).not.toContain('-o');
  });
});