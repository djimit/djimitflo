import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  processGroupExists,
  runtimeProcessClosed,
  runtimeProcessGroupKillEnabled,
  signalRuntimeProcess,
  spawnRuntime,
  stopRuntimeProcess,
} from '../execution/executors/runtime-process';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';
import { createTestDb } from './helpers/test-db';

/**
 * ORCA-PG (docs/research/orca/EVALUATION-REPORT.md). An agent CLI's child (a test runner, a shell, an MCP server)
 * inherits the CLI's stdout pipe. The fixture "agent" spawns such a grandchild and records its pid. Flag off is the
 * legacy behaviour, asserted as a documented gap; flag on must reap the whole process group.
 */

const posix = process.platform !== 'win32';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const previousFlag = process.env.RUNTIME_PROCESS_GROUP_KILL;
const cleanup: Array<() => void> = [];

afterEach(() => {
  if (previousFlag === undefined) delete process.env.RUNTIME_PROCESS_GROUP_KILL;
  else process.env.RUNTIME_PROCESS_GROUP_KILL = previousFlag;
  while (cleanup.length) cleanup.pop()!();
  vi.restoreAllMocks();
});

/** A runtime whose grandchild holds stdout; `ignoreTerm` grandchildren need the SIGKILL escalation. */
function agentFixture(opts: { grandchildLifetimeMs: number; ignoreTerm: boolean; rootExitsAfterMs?: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-pg-'));
  const pidFile = path.join(root, 'grandchild.pid');
  const script = path.join(root, 'agent.js');
  // The grandchild records its own pid only after its SIGTERM handler is installed (no signal-before-boot race).
  const grandchild = `${opts.ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''} require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000); setTimeout(()=>process.exit(0), ${opts.grandchildLifetimeMs})`;
  fs.writeFileSync(script, `
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] });
${opts.rootExitsAfterMs !== undefined ? `setTimeout(() => process.exit(0), ${opts.rootExitsAfterMs});` : 'setInterval(() => {}, 1000);'}
`);
  let grandchildPid: number | undefined;
  cleanup.push(() => {
    if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    command: process.execPath,
    args: [script],
    async grandchild(): Promise<number> {
      await vi.waitFor(() => expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0).toBe(true), { timeout: 5_000, interval: 10 });
      grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      return grandchildPid;
    },
  };
}

function track(child: ChildProcess): ChildProcess {
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  void runtimeProcessClosed(child);
  return child;
}

describe('runtimeProcessGroupKillEnabled', () => {
  it('is off unless explicitly on, and never on Windows', () => {
    expect(runtimeProcessGroupKillEnabled({})).toBe(false);
    expect(runtimeProcessGroupKillEnabled({ RUNTIME_PROCESS_GROUP_KILL: 'true' })).toBe(false);
    expect(runtimeProcessGroupKillEnabled({ RUNTIME_PROCESS_GROUP_KILL: 'on' }, 'linux')).toBe(true);
    expect(runtimeProcessGroupKillEnabled({ RUNTIME_PROCESS_GROUP_KILL: 'on' }, 'win32')).toBe(false);
  });
});

describe.skipIf(!posix)('spawnRuntime / stopRuntimeProcess', () => {
  it('flag off (legacy, documented gap): stop leaves the grandchild running and resolves only when it exits', async () => {
    delete process.env.RUNTIME_PROCESS_GROUP_KILL;
    const fixture = agentFixture({ grandchildLifetimeMs: 1_500, ignoreTerm: true });
    const child = track(spawnRuntime(fixture.command, fixture.args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const gc = await fixture.grandchild();
    const t0 = performance.now();
    const stopped = stopRuntimeProcess(child, { graceMs: 200 }).then(() => performance.now() - t0);
    await sleep(400);
    expect(alive(gc)).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await stopped).toBeGreaterThanOrEqual(1_000);
  });

  it('flag on: stop SIGTERMs then SIGKILLs the whole group, so close fires within the grace', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const fixture = agentFixture({ grandchildLifetimeMs: 30_000, ignoreTerm: true });
    const child = track(spawnRuntime(fixture.command, fixture.args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const gc = await fixture.grandchild();
    const t0 = performance.now();
    await stopRuntimeProcess(child, { graceMs: 300 });
    // ≥ grace: SIGTERM was ignored, so only the SIGKILL escalation to the group explains the reap.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    expect(performance.now() - t0).toBeLessThan(2_000);
    await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 2_000, interval: 20 });
    expect(processGroupExists(child.pid!)).toBe(false);
  });

  it('flag on: a cooperative group dies on SIGTERM without waiting for the escalation', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const fixture = agentFixture({ grandchildLifetimeMs: 30_000, ignoreTerm: false });
    const child = track(spawnRuntime(fixture.command, fixture.args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const gc = await fixture.grandchild();
    const t0 = performance.now();
    await stopRuntimeProcess(child, { graceMs: 5_000 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 2_000, interval: 20 });
  });

  it('flag on: a root that exits on its own does not leave its pipe-holding grandchild behind', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const fixture = agentFixture({ grandchildLifetimeMs: 30_000, ignoreTerm: true, rootExitsAfterMs: 100 });
    const child = track(spawnRuntime(fixture.command, fixture.args, { stdio: ['ignore', 'pipe', 'pipe'] }, 200));
    const gc = await fixture.grandchild();
    const t0 = performance.now();
    await runtimeProcessClosed(child);
    expect(performance.now() - t0).toBeLessThan(3_000);
    await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 2_000, interval: 20 });
  });

  it('flag on: a stop after the root exited still reaps the group (cancel races a finished CLI)', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const fixture = agentFixture({ grandchildLifetimeMs: 30_000, ignoreTerm: true, rootExitsAfterMs: 50 });
    // Long exit grace: only the stop can explain a fast reap.
    const child = track(spawnRuntime(fixture.command, fixture.args, { stdio: ['ignore', 'pipe', 'pipe'] }, 60_000));
    const gc = await fixture.grandchild();
    await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), { timeout: 3_000, interval: 10 });
    expect(alive(gc)).toBe(true);
    await stopRuntimeProcess(child, { graceMs: 200 });
    await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 2_000, interval: 20 });
  });

  it('a duplicate stop joins the first one, and a stop after close resolves at once', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const fixture = agentFixture({ grandchildLifetimeMs: 30_000, ignoreTerm: true });
    const child = track(spawnRuntime(fixture.command, fixture.args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    await fixture.grandchild();
    const first = stopRuntimeProcess(child, { graceMs: 200 });
    expect(stopRuntimeProcess(child, { graceMs: 200 })).toBe(first);
    await first;
    const t0 = performance.now();
    await stopRuntimeProcess(child);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('never group-signals a process it did not spawn as a group leader', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const foreign = track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
    const kill = vi.spyOn(process, 'kill');
    signalRuntimeProcess(foreign, 'SIGTERM');
    await stopRuntimeProcess(foreign, { graceMs: 200 });
    expect(kill.mock.calls.some(([pid]) => typeof pid === 'number' && pid < 0)).toBe(false);
    expect(foreign.signalCode).toBe('SIGTERM');
  });

  it('flag off keeps the caller\'s spawn options untouched (no detached)', async () => {
    delete process.env.RUNTIME_PROCESS_GROUP_KILL;
    const child = track(spawnRuntime(process.execPath, ['-e', ''], { stdio: 'ignore' }));
    await runtimeProcessClosed(child);
    expect(child.spawnargs).toEqual([process.execPath, '-e', '']);
    const kill = vi.spyOn(process, 'kill');
    await stopRuntimeProcess(child);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signalling a group that is already gone falls back to the handle and does not throw', async () => {
    process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
    const child = track(spawnRuntime(process.execPath, ['-e', ''], { stdio: 'ignore' }));
    await runtimeProcessClosed(child);
    expect(processGroupExists(child.pid!)).toBe(false);
    expect(() => signalRuntimeProcess(child, 'SIGKILL')).not.toThrow();
  });
});

describe.skipIf(!posix)('RuntimeCommandService timeout with a pipe-holding grandchild (lease + runtime permit)', () => {
  async function run(flag: 'on' | undefined) {
    if (flag) process.env.RUNTIME_PROCESS_GROUP_KILL = flag; else delete process.env.RUNTIME_PROCESS_GROUP_KILL;
    const db = createTestDb();
    const { LoopService } = await import('../services/loop-service');
    const { RuntimeCommandService } = await import('../services/runtime-command-service');
    const runtime = new RuntimeCommandService(db, new LoopService(db));
    const fixture = agentFixture({ grandchildLifetimeMs: 4_000, ignoreTerm: true });
    const before = runtimeConcurrencySemaphore.activeCount;
    const t0 = performance.now();
    try {
      const result = await runtime.executeRuntimeCommand(`orca-pg-${flag ?? 'off'}`, fixture.command, fixture.args, { timeoutMs: 1_000 });
      return { result, elapsedMs: performance.now() - t0, permitsLeaked: runtimeConcurrencySemaphore.activeCount - before, gc: await fixture.grandchild() };
    } finally { db.close(); }
  }

  it('flag off (legacy, documented gap): the timed-out lease holds its permit until the grandchild exits', async () => {
    const { result, elapsedMs, permitsLeaked } = await run(undefined);
    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(3_500);
    expect(permitsLeaked).toBe(0);
  });

  it('flag on: the timed-out lease finalises at the timeout and the grandchild is gone', async () => {
    const { result, elapsedMs, permitsLeaked, gc } = await run('on');
    expect(result.timedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(2_500);
    expect(permitsLeaked).toBe(0);
    await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 2_000, interval: 20 });
  });
});

describe.skipIf(!posix)('server shutdown takes its detached runtime groups along (restart)', () => {
  const modulePath = path.resolve(__dirname, '../execution/executors/runtime-process.ts');
  const tsx = (() => { try { return require.resolve('tsx'); } catch { return null; } })();

  it.skipIf(!tsx).each([
    ['SIGINT (no listener: relay, then default termination)', 'signal'],
    ['process.exit (SIGTERM handler in index.ts ends this way)', 'exit'],
  ])('%s', async (_label, how) => {
    const fixture = agentFixture({ grandchildLifetimeMs: 30_000, ignoreTerm: true });
    const server = `
      process.env.RUNTIME_PROCESS_GROUP_KILL = 'on';
      const { spawnRuntime } = await import(${JSON.stringify(modulePath)});
      spawnRuntime(${JSON.stringify(fixture.command)}, ${JSON.stringify(fixture.args)}, { stdio: ['ignore', 'pipe', 'pipe'] });
      ${how === 'exit' ? "process.stdin.once('data', () => process.exit(0)); process.stdin.resume();" : 'setInterval(() => {}, 1000);'}
    `;
    const host = track(spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', server], { stdio: ['pipe', 'ignore', 'inherit'] }));
    const gc = await fixture.grandchild();
    expect(alive(gc)).toBe(true);
    if (how === 'exit') host.stdin!.write('x'); else host.kill('SIGINT');
    await runtimeProcessClosed(host);
    if (how === 'signal') expect(host.signalCode).toBe('SIGINT');
    await vi.waitFor(() => expect(alive(gc)).toBe(false), { timeout: 3_000, interval: 20 });
  }, 20_000);
});
