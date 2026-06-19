import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import type { ExecutorOptions } from '../execution/types';
import { CodexExecutor } from '../execution/executors/codex-executor';

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

describe('CodexExecutor', () => {
  let executor: CodexExecutor;

  beforeEach(() => {
    executor = new CodexExecutor('/usr/bin/codex');
  });

  it('uses the current Codex JSON and working-directory flags', () => {
    const task = makeTask({ description: 'test prompt' });
    const options: ExecutorOptions = { workingDirectory: '/tmp/project', format: 'json' };
    const args = (executor as any).buildCodexArgs(task, options);

    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--cd');
    expect(args[args.indexOf('--cd') + 1]).toBe('/tmp/project');
    expect(args).not.toContain('--format');
    expect(args).not.toContain('--dir');
    expect(args[args.length - 1]).toBe('test prompt');
  });

  it('uses the current Codex bypass flag only when explicitly requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const defaultArgs = (executor as any).buildCodexArgs(task, {});
    expect(defaultArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(defaultArgs).not.toContain('--dangerously-skip-permissions');

    const bypassArgs = (executor as any).buildCodexArgs(task, { skipPermissions: true });
    expect(bypassArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(bypassArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('omits JSON flag when default output is requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const args = (executor as any).buildCodexArgs(task, { format: 'default' });
    expect(args).not.toContain('--json');
  });
});
