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
