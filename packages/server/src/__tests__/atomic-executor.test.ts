import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '@djimitflo/shared';
import { AtomicExecutor, atomicConfig } from '../execution/executors/atomic-executor';
import { parseSpecies } from '../services/evolve-selection';

const tempDirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

function task(description = 'fix calc.mjs'): Task {
  return {
    id: 'task-atomic', title: 'Atomic test', description, status: 'pending', priority: 'low',
    risk_level: 'low', execution_mode: 'local', agent_id: null, parent_task_id: null,
    repository_id: null, instruction_profile_id: null, started_at: null, completed_at: null,
    failed_at: null, execution_time_ms: null, token_usage: null, created_by: null,
    owner_user_id: null, updated_by: null, tags: [], metadata: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

it('only passes --no-approval when Djimitflo already approved (skipPermissions)', () => {
  const executor = new AtomicExecutor('/bin/atomic-agent');
  expect(executor.buildCommand(task(), { workingDirectory: '/wt' }).args).toEqual(['run', '--cwd', '/wt', '--max-steps', '40']);
  expect(executor.buildCommand(task(), { workingDirectory: '/wt', skipPermissions: true }).args).toContain('--no-approval');
});

it('provider config keeps local-llama (default embedding provider) and reads the key from OLLAMA_API_KEY', () => {
  const cfg = JSON.parse(atomicConfig({}, 'glm-5.2'));
  expect(cfg.llm.activeTextProvider).toBe('djimitflo-cloud');
  expect(cfg.llm.providers.map((p: { id: string }) => p.id)).toEqual(['local-llama', 'djimitflo-cloud']);
  expect(cfg.llm.providers[1]).toMatchObject({ kind: 'openai-compatible', baseUrl: 'https://ollama.com/v1', apiKeyEnvVar: 'OLLAMA_API_KEY', defaultChatModel: 'glm-5.2' });
  expect(JSON.stringify(cfg)).not.toMatch(/apiKey"\s*:/); // the key itself is never written
});

it('writes its config into its own state dir, sends the goal on stdin and runs in the worktree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-atomic-')); tempDirs.push(dir);
  const bin = path.join(dir, 'atomic-agent');
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "config" ]; then printf "%s" "$3" > "$ATOMIC_AGENT_STATE_DIR/config.json"; exit 0; fi\nprintf "cwd=%s goal=" "$3"; cat\n');
  fs.chmodSync(bin, 0o755);
  vi.stubEnv('DJIMITFLO_ATOMIC_STATE_DIR', path.join(dir, 'state'));
  const session = await new AtomicExecutor(bin).start(task('make node test.mjs pass'), { workingDirectory: dir, timeout: 5_000 });
  for await (const _ of session.events) { /* drain */ }
  const result = await session.result;
  expect(result.status).toBe('completed');
  expect(result.stdout).toContain(`cwd=${dir} goal=make node test.mjs pass`);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'config.json'), 'utf8')).llm.activeTextProvider).toBe('djimitflo-cloud');
});

it('gym-only species parse like evolve species', () => {
  expect(parseSpecies('atomic, opencode@ollama/kimi-k3:cloud')).toEqual([{ runtime: 'atomic' }, { runtime: 'opencode', model: 'ollama/kimi-k3:cloud' }]);
  expect(parseSpecies(undefined)).toEqual([]);
});
