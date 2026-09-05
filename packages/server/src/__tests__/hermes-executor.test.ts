import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HermesExecutor } from '../execution/executors/hermes-executor';
import type { Task } from '@djimitflo/shared';

const tempDirs: string[] = [];

function task(description = 'inspect the repository'): Task {
  return {
    id: 'task-hermes', title: 'Hermes test', description, status: 'pending', priority: 'low',
    risk_level: 'low', execution_mode: 'local', agent_id: null, parent_task_id: null,
    repository_id: null, instruction_profile_id: null, started_at: null, completed_at: null,
    failed_at: null, execution_time_ms: null, token_usage: null, created_by: null,
    owner_user_id: null, updated_by: null, tags: [], metadata: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('HermesExecutor', () => {
  it('builds a non-bypassing programmatic command by default', () => {
    const executor = new HermesExecutor('/bin/hermes');
    expect(executor.buildCommand(task())).toEqual({
      command: '/bin/hermes',
      args: ['chat', '-q', 'inspect the repository', '--oneshot', '--quiet'],
    });
  });

  it('only adds --yolo when the executor is explicitly armed', () => {
    const executor = new HermesExecutor('/bin/hermes');
    expect(executor.buildCommand(task(), { skipPermissions: true }).args).toContain('--yolo');
  });

  it('runs a fake Hermes binary and captures plain output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-hermes-'));
    tempDirs.push(dir);
    const bin = path.join(dir, 'hermes');
    fs.writeFileSync(bin, '#!/bin/sh\nprintf "answer\\n"\n');
    fs.chmodSync(bin, 0o755);
    const session = await new HermesExecutor(bin).start(task(), { workingDirectory: dir, timeout: 5_000 });
    const events = [];
    for await (const event of session.events) events.push(event);
    const result = await session.result;
    expect(result.status).toBe('completed');
    expect(result.stdout).toContain('answer');
    expect(events.some(event => event.message === 'answer')).toBe(true);
  });
});
