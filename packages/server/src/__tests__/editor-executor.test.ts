import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import type { ExecutorOptions } from '../execution/types';
import { EditorExecutor } from '../execution/executors/editor-executor';

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

describe('EditorExecutor (cline)', () => {
  let executor: EditorExecutor;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DJIMITFLO_CLINE_MODEL;
    delete process.env.DJIMITFLO_CLINE_THINKING;
    executor = new EditorExecutor('/usr/bin/cline');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('builds the headless cline invocation with --json, --auto-approve, -c <worktree>, --thinking, and the prompt positional', () => {
    const task = makeTask({ description: 'test prompt' });
    const options: ExecutorOptions = { workingDirectory: '/tmp/project', format: 'json' };
    const args = (executor as any).buildEditorArgs(task, options);

    expect(args).toContain('--json');
    expect(args).toContain('--auto-approve');
    expect(args[args.indexOf('--auto-approve') + 1]).toBe('false');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('/tmp/project');
    expect(args).toContain('--thinking');
    expect(args[args.indexOf('--thinking') + 1]).toBe('medium');
    expect(args[args.length - 1]).toBe('test prompt');
  });

  it('flips --auto-approve to true only when skipPermissions is armed', () => {
    const task = makeTask({ description: 'test prompt' });

    const defaultArgs = (executor as any).buildEditorArgs(task, { workingDirectory: '/tmp/project' });
    expect(defaultArgs[defaultArgs.indexOf('--auto-approve') + 1]).toBe('false');

    const bypassArgs = (executor as any).buildEditorArgs(task, {
      workingDirectory: '/tmp/project',
      skipPermissions: true,
    });
    expect(bypassArgs[bypassArgs.indexOf('--auto-approve') + 1]).toBe('true');
  });

  it('uses DJIMITFLO_CLINE_THINKING for the --thinking level', () => {
    const task = makeTask({ description: 'test prompt' });
    process.env.DJIMITFLO_CLINE_THINKING = 'high';
    const args = (executor as any).buildEditorArgs(task, { workingDirectory: '/tmp/project' });
    expect(args[args.indexOf('--thinking') + 1]).toBe('high');
  });

  it('injects -m model from ExecutorOptions or DJIMITFLO_CLINE_MODEL', () => {
    const task = makeTask({ description: 'test prompt' });

    const optArgs = (executor as any).buildEditorArgs(task, {
      workingDirectory: '/tmp/project',
      model: 'claude-sonnet-4-6',
    });
    expect(optArgs).toContain('-m');
    expect(optArgs[optArgs.indexOf('-m') + 1]).toBe('claude-sonnet-4-6');

    process.env.DJIMITFLO_CLINE_MODEL = 'gpt-5.5';
    const envArgs = (executor as any).buildEditorArgs(task, { workingDirectory: '/tmp/project' });
    expect(envArgs[envArgs.indexOf('-m') + 1]).toBe('gpt-5.5');

    delete process.env.DJIMITFLO_CLINE_MODEL;
    const noModelArgs = (executor as any).buildEditorArgs(task, { workingDirectory: '/tmp/project' });
    expect(noModelArgs).not.toContain('-m');
  });
});