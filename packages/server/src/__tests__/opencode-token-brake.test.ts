import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '@djimitflo/shared';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-brake-'));
afterEach(() => { delete process.env.OPENCODE_MAX_RUN_TOKENS; });

it('A4: stops a run whose summed step tokens pass OPENCODE_MAX_RUN_TOKENS', async () => {
  // a fake opencode that keeps finishing expensive steps for 20 s
  const bin = path.join(dir, 'fake-opencode');
  fs.writeFileSync(bin, `#!/usr/bin/env node
let i = 0; const t = setInterval(() => { process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', tokens: { total: 400000 } } }) + '\\n'); if (++i > 200) clearInterval(t); }, 50);`, { mode: 0o755 });
  process.env.OPENCODE_MAX_RUN_TOKENS = '1000000';
  const started = Date.now();
  const session = await new OpenCodeExecutor(bin).start({ id: 't', title: 't', description: 'x' } as unknown as Task, { workingDirectory: dir, timeout: 20_000 });
  const drain = (async () => { for await (const _event of session.events) { /* the stream starts the process */ } })();
  const result = await session.result;
  await drain.catch(() => undefined);
  expect(result.status).toBe('failed');
  expect(result.message).toContain('token budget exceeded');
  expect(Date.now() - started).toBeLessThan(5_000); // stopped after ~3 steps, not at the 20 s timeout
});

// Prod 7 d to 2026-11-07: 15 of 31 opencode makers ended maker_runtime_exit_zero, stopped by the 1 M brake; ~92 % of what it
// counted were cache reads (e.g. total 1 009 869, cache.read 932 503, input 50 517). A prod-shaped stream: 25 steps of
// 40 395 tokens of which 37 300 cache reads = 1 009 875 total, 932 500 cache.read; 24 steps stay under the cap.
const PROD_STEP = { total: 40_395, input: 2_021, output: 1_074, reasoning: 0, cache: { read: 37_300, write: 0 } };
function fakeOpencode(name: string, steps: number, tokens: object): string {
  const bin = path.join(dir, name);
  const line = JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', tokens } });
  fs.writeFileSync(bin, `#!/usr/bin/env node
let i = 0; const t = setInterval(() => { process.stdout.write(${JSON.stringify(line)} + '\\n'); if (++i >= ${steps}) { clearInterval(t); setTimeout(() => process.exit(0), 50); } }, 5);`, { mode: 0o755 });
  return bin;
}
async function run(bin: string) {
  const session = await new OpenCodeExecutor(bin).start({ id: 't', title: 't', description: 'x' } as unknown as Task, { workingDirectory: dir, timeout: 20_000 });
  const drain = (async () => { for await (const _event of session.events) { /* the stream starts the process */ } })();
  const result = await session.result;
  await drain.catch(() => undefined);
  return result;
}
afterEach(() => { delete process.env.OPENCODE_BRAKE_CACHE_READ_WEIGHT; });

it('cache-read weight unset or 1: the prod-shaped stream brakes exactly as before', async () => {
  process.env.OPENCODE_MAX_RUN_TOKENS = '1000000';
  for (const weight of [undefined, '1']) {
    if (weight === undefined) delete process.env.OPENCODE_BRAKE_CACHE_READ_WEIGHT; else process.env.OPENCODE_BRAKE_CACHE_READ_WEIGHT = weight;
    const result = await run(fakeOpencode(`prod-w${weight ?? 'unset'}`, 25, PROD_STEP));
    expect(result.status, weight).toBe('failed');
    expect(result.message, weight).toBe('OpenCode execution error: OpenCode token budget exceeded: 1009875 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)');
    expect(result.metrics?.tokenUsage, weight).toBe(40_395);
  }
});

it('cache-read weight 0.1: the prod-shaped stream is not braked at the 1 M cap; reported tokens stay the provider numbers', async () => {
  process.env.OPENCODE_MAX_RUN_TOKENS = '1000000';
  process.env.OPENCODE_BRAKE_CACHE_READ_WEIGHT = '0.1';
  const result = await run(fakeOpencode('prod-w0.1', 25, PROD_STEP)); // brake sum 25 × (40 395 − 0.9 × 37 300) = 170 625
  expect(result.message).not.toContain('token budget exceeded');
  expect(result.status).toBe('completed');
  expect(result.metrics?.tokenUsage).toBe(40_395);
});

it('cache-read weight 0.1 still brakes runaway fresh work, and names the weighted and the provider sum', async () => {
  process.env.OPENCODE_MAX_RUN_TOKENS = '1000000';
  process.env.OPENCODE_BRAKE_CACHE_READ_WEIGHT = '0.1';
  const result = await run(fakeOpencode('fresh-w0.1', 50, { total: 400_000, input: 390_000, output: 10_000 })); // no cache: counts fully
  expect(result.status).toBe('failed');
  expect(result.message).toBe('OpenCode execution error: OpenCode token budget exceeded: 1200000 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS, cache reads weighted 0.1; provider total 1200000)');
});

it('an invalid cache-read weight brakes as weight 1', async () => {
  process.env.OPENCODE_MAX_RUN_TOKENS = '1000000';
  process.env.OPENCODE_BRAKE_CACHE_READ_WEIGHT = '1.5';
  const result = await run(fakeOpencode('prod-w-invalid', 25, PROD_STEP));
  expect(result.message).toBe('OpenCode execution error: OpenCode token budget exceeded: 1009875 > 1000000 tokens (OPENCODE_MAX_RUN_TOKENS)');
});
