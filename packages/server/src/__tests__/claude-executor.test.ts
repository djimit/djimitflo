import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task } from '@djimitflo/shared';
import { ExecutionEventType } from '@djimitflo/shared';
import type { ExecutorOptions } from '../execution/types';
import { ClaudeExecutor } from '../execution/executors/claude-executor';

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

describe('ClaudeExecutor', () => {
  let executor: ClaudeExecutor;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DJIMITFLO_CLAUDE_MODEL;
    executor = new ClaudeExecutor('/usr/bin/claude');
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  it('builds the headless claude invocation with -p, --output-format json, and the prompt positional', () => {
    const task = makeTask({ description: 'test prompt' });
    const options: ExecutorOptions = { workingDirectory: '/tmp/project', format: 'json' };
    const args = (executor as any).buildClaudeArgs(task, options);

    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('test prompt');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    // claude inherits cwd via spawn — no --cd/--cwd flag
    expect(args).not.toContain('--cd');
    expect(args).not.toContain('--cwd');
    // prompt is the -p value (index 1), not the trailing positional
    expect(args[args.indexOf('-p') + 1]).toBe('test prompt');
  });

  it('uses the bypass flag only when explicitly requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const defaultArgs = (executor as any).buildClaudeArgs(task, {});
    expect(defaultArgs).not.toContain('--dangerously-skip-permissions');

    const bypassArgs = (executor as any).buildClaudeArgs(task, { skipPermissions: true });
    expect(bypassArgs).toContain('--dangerously-skip-permissions');
  });

  it('injects --model from ExecutorOptions or DJIMITFLO_CLAUDE_MODEL', () => {
    const task = makeTask({ description: 'test prompt' });

    const optArgs = (executor as any).buildClaudeArgs(task, { model: 'claude-sonnet-4-6' });
    expect(optArgs).toContain('--model');
    expect(optArgs[optArgs.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');

    process.env.DJIMITFLO_CLAUDE_MODEL = 'claude-opus-4-8';
    const envArgs = (executor as any).buildClaudeArgs(task, {});
    expect(envArgs[envArgs.indexOf('--model') + 1]).toBe('claude-opus-4-8');

    delete process.env.DJIMITFLO_CLAUDE_MODEL;
    const noModelArgs = (executor as any).buildClaudeArgs(task, {});
    expect(noModelArgs).not.toContain('--model');
  });

  it('omits --output-format when default output is requested', () => {
    const task = makeTask({ description: 'test prompt' });
    const args = (executor as any).buildClaudeArgs(task, { format: 'default' });
    expect(args).not.toContain('--output-format');
  });

  it('runs a fake claude bin to completion (exit 0) via start()', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-claude-bin-'));
    const bin = path.join(binDir, 'claude');
    // Fake claude: ignore flags, print one JSON line, exit 0.
    fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-claude 1.0.0'); process.exit(0); }
console.log(JSON.stringify({ type: 'result', text: 'done' }));
process.exit(0);
`);
    fs.chmodSync(bin, 0o755);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-claude-work-'));
    const exec = new ClaudeExecutor(bin);
    const task = makeTask({ id: 'claude-smoke-task', description: 'say hi' });
    const session = await exec.start(task, { workingDirectory: workDir, format: 'json' });

    const events: any[] = [];
    for await (const ev of session.events) events.push(ev);
    const result = await session.result;

    expect(result.status).toBe('completed');
    expect(events.some((e) => e.event_type === ExecutionEventType.TASK_STARTED)).toBe(true);
    expect(events.some((e) => e.event_type === ExecutionEventType.TASK_COMPLETED)).toBe(true);

    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }, 15000);
});