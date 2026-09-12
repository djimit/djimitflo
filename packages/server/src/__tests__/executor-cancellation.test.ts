import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '@djimitflo/shared';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';
import { ClaudeExecutor } from '../execution/executors/claude-executor';
import { GeminiExecutor } from '../execution/executors/gemini-executor';
import { EditorExecutor } from '../execution/executors/editor-executor';
import { PiExecutor } from '../execution/executors/pi-executor';
import { HermesExecutor } from '../execution/executors/hermes-executor';

describe('real subprocess cancellation', () => {
  it.each([CodexExecutor, OpenCodeExecutor, ClaudeExecutor, GeminiExecutor, EditorExecutor, PiExecutor, HermesExecutor].map(Executor => ({ name: Executor.name, Executor })))(
    '$name terminates a TERM-resistant worker and closes its event stream', async ({ Executor }) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'djimitflo-cancel-'));
      const binary = path.join(directory, 'worker');
      writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fault-injection 1.0'); process.exit(0); }
process.on('SIGTERM', () => {});
console.error('ready pid=' + process.pid);
setInterval(() => {}, 1000);
setTimeout(() => process.exit(2), 7500);
`);
      chmodSync(binary, 0o755);
      let pid: number | undefined;
      let cancelledAt = 0;
      try {
        const session = await new Executor(binary).start({
          id: 'cancel-fixture', description: 'cancellation fault injection', metadata: {},
        } as Task, { workingDirectory: directory, timeout: 20_000 });
        const events = [];
        for await (const event of session.events) {
          events.push(event);
          const ready = /ready pid=(\d+)/.exec(JSON.stringify(event));
          if (ready && !pid) {
            pid = Number(ready[1]);
            cancelledAt = performance.now();
            const cancelling = session.cancel();
            expect(session.status).toBe('cancelled');
            await Promise.all([cancelling, session.cancel()]);
            expect(() => process.kill(pid!, 0)).toThrow();
            await session.closed;
          }
        }
        expect(pid).toBeDefined();
        expect(performance.now() - cancelledAt).toBeLessThan(7_000);
        expect((await session.result).status).toBe('failed');
        expect(events.some(event => event.event_type === 'task.failed')).toBe(true);
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
        rmSync(directory, { recursive: true, force: true });
      }
    }, 9_000,
  );
});
