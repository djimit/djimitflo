import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionEventCreateInput, Task } from '@djimitflo/shared';
import { OpenCodeExecutor } from '../execution/executors/opencode-executor';

/**
 * DF-03: an OpenCode `step_finish` is a per-step marker, never the task outcome. A `tool-calls` step (the model hands
 * off to a tool and the run continues) used to be persisted as task.failed/ERROR (6.7 k rows in prod). The terminal
 * event is emitted exactly once, from the process result.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-step-'));
const line = (o: unknown) => JSON.stringify(o);
const stepStart = line({ type: 'step_start', sessionID: 's', part: { type: 'step-start', id: 'p1', messageID: 'm', sessionID: 's' } });
const stepFinish = (reason: string) => line({ type: 'step_finish', sessionID: 's', part: { type: 'step-finish', reason, tokens: { total: 10 }, id: 'p2', messageID: 'm', sessionID: 's' } });
const tool = (tool: string, state: Record<string, unknown>) => line({ type: 'tool_use', sessionID: 's', part: { type: 'tool', tool, callID: 'c1', state, id: 'p3', messageID: 'm', sessionID: 's' } });
const text = (t: string) => line({ type: 'text', sessionID: 's', part: { type: 'text', text: t, id: 'p4', messageID: 'm', sessionID: 's' } });

/** a full tool round trip: step 1 asks for a tool (tool-calls), the tool result comes back, step 2 answers (stop) */
const toolRoundTrip = [
  stepStart,
  tool('read', { status: 'completed', input: { filePath: 'README.md' }, output: 'hello' }),
  stepFinish('tool-calls'),
  stepStart,
  text('done'),
  stepFinish('stop'),
];

async function run(lines: string[], exitCode: number, name: string) {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/usr/bin/env node
for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + '\\n');
process.exitCode = ${exitCode};`, { mode: 0o755 });
  const session = await new OpenCodeExecutor(bin).start({ id: 't', title: 't', description: 'x' } as unknown as Task, { workingDirectory: dir, timeout: 20_000 });
  const events: ExecutionEventCreateInput[] = [];
  for await (const event of session.events) events.push(event);
  const result = await session.result;
  const of = (type: string) => events.filter((e) => e.event_type === type);
  return { events, result, completed: of('task.completed'), failed: of('task.failed'), errors: events.filter((e) => e.level === 'error') };
}

describe('OpenCode step progress vs terminal outcome (DF-03)', () => {
  it('tool-call → tool-result → stop with exit 0 yields one terminal task.completed and no failure', async () => {
    const r = await run(toolRoundTrip, 0, 'ok');
    expect(r.result.status).toBe('completed');
    expect(r.completed).toHaveLength(1);
    expect(r.failed).toHaveLength(0);
    expect(r.errors).toHaveLength(0); // review error_count / interaction board count level=error
    expect(r.events.at(-1)?.event_type).toBe('task.completed'); // the terminal event is the last one
    const steps = r.events.filter((e) => e.metadata?.step_finish === true);
    expect(steps.map((e) => [e.event_type, e.metadata?.reason, e.metadata?.terminal])).toEqual([
      ['log', 'tool-calls', false], ['log', 'stop', false],
    ]);
  });

  it('a real failing exit yields exactly one task.failed and no task.completed, even after a stop step', async () => {
    const r = await run(toolRoundTrip, 1, 'fail');
    expect(r.result.status).toBe('failed');
    expect(r.failed).toHaveLength(1);
    expect(r.completed).toHaveLength(0);
    expect(r.failed[0].metadata).toMatchObject({ exit_code: 1, terminal: true });
  });

  it('exit 0 with a failed verification emits the failed result as the single terminal event', async () => {
    const r = await run([stepStart, tool('bash', { status: 'error', input: { command: 'npm run type-check' }, error: 'rejected' }), stepFinish('tool-calls'), stepStart, stepFinish('stop')], 0, 'verify');
    expect(r.result.status).toBe('failed');
    expect(r.failed).toHaveLength(1);
    expect(r.completed).toHaveLength(0);
    expect(r.failed[0].metadata).toMatchObject({ failure_code: 'VERIFICATION_FAILED' });
  });

  it('an unknown step reason is kept as a diagnostic, never as success or as a terminal failure', async () => {
    const executor = new OpenCodeExecutor('/usr/bin/opencode');
    for (const reason of ['mystery', undefined]) {
      const mapped = (executor as any).mapJsonEventToExecutionEvent('t', { type: 'step_finish', part: { type: 'step-finish', ...(reason ? { reason } : {}) } });
      expect(mapped).toMatchObject({ event_type: 'log', level: 'warning', metadata: { step_finish: true, terminal: false, step_outcome: 'unrecognized' } });
    }
    const r = await run([stepStart, stepFinish('mystery')], 1, 'unknown');
    expect(r.completed).toHaveLength(0);
    expect(r.failed).toHaveLength(1); // the outcome comes from the exit code only
  });
});
