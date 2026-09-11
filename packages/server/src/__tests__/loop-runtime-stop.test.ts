import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExecutionEngine } from '../execution/execution-engine';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { LoopService } from '../services/loop-service';
import { SwarmStatusService } from '../services/swarm-status-service';
import { RuntimeLeaseRegistry } from '../services/loop-recovery-service';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';

it.each(['loop', 'worker'])('%s stop reaches an engine-owned child across service instances', async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-stop-chain-'));
  const binary = path.join(root, 'worker');
  const pidFile = path.join(root, 'pid');
  fs.writeFileSync(binary, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(2), 10000);
`);
  fs.chmodSync(binary, 0o755);
  const db = new Database(':memory:');
  db.exec(schema); runMigrations(db);
  let pid: number | undefined;
  try {
    const engine = new ExecutionEngine(db);
    engine.registerExecutor(new CodexExecutor(binary));
    const loops = new LoopService(db, path.join(root, 'evidence'));
    db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('stop-run', 'doc-drift-and-small-fix-loop', 'closed', 'running')").run();
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES ('stop-lease', 'stop-run', 'maker', 'codex', 'running', ?)").run(JSON.stringify({ execution_task_id: 'stop-task' }));
    db.prepare("INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, metadata) VALUES ('stop-task', 'Observe fixture', 'echo hello', 'pending', 'medium', 'low', 'local', ?)")
      .run(JSON.stringify({ lease_id: 'stop-lease', workingDirectory: root }));
    const execution = await engine.executeTask('stop-task', 'codex');
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(RuntimeLeaseRegistry.isLive('stop-lease')).toBe(true);
    expect(loops.recoverInterruptedRuns()).toMatchObject({ failedLeases: 0, interruptedRuns: 0 });
    const cancelledAt = performance.now();
    if (mode === 'loop') await loops.stopLoopRun('stop-run');
    else await new SwarmStatusService(db).stopWorkerLease('stop-lease');
    await execution.completion;
    expect(performance.now() - cancelledAt).toBeLessThan(7_000);
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(RuntimeLeaseRegistry.isLive('stop-lease')).toBe(false);
    expect((db.prepare("SELECT status FROM tasks WHERE id = 'stop-task'").get() as any).status).toBe('cancelled');
    expect((db.prepare("SELECT status FROM worker_leases WHERE id = 'stop-lease'").get() as any).status).toBe('cancelled');
    if (mode === 'loop') expect(loops.getLoopRun('stop-run').status).toBe('cancelled');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    RuntimeLeaseRegistry.unregister('stop-lease');
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it('holds task and capacity until child close, then fences late cleanup from a new attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-stop-race-'));
  const binary = path.join(root, 'worker');
  const pidFile = path.join(root, 'pid');
  fs.writeFileSync(binary, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(2), 15000);
`);
  fs.chmodSync(binary, 0o755);
  const db = new Database(':memory:');
  db.exec(schema); runMigrations(db);
  const pids: number[] = [];
  let releaseOldResult!: () => void;
  const oldResultGate = new Promise<void>(resolve => { releaseOldResult = resolve; });
  const initialCapacity = runtimeConcurrencySemaphore.activeCount;
  try {
    const engine = new ExecutionEngine(db);
    const executor = new CodexExecutor(binary);
    let attempts = 0;
    engine.registerExecutor({ kind: 'codex', canExecute: task => executor.canExecute(task), start: async (task, options) => {
      const session = await executor.start(task, options);
      if (attempts++ === 0) session.result = session.result.then(async result => { await oldResultGate; return result; });
      return session;
    } });
    db.prepare("INSERT INTO loop_runs (id,loop_name,mode,status) VALUES ('race-run','fixture','closed','running')").run();
    db.prepare("INSERT INTO worker_leases (id,loop_run_id,role,runtime,status,metadata) VALUES ('race-lease','race-run','maker','codex','running',?)")
      .run(JSON.stringify({ execution_task_id: 'race-task' }));
    db.prepare("INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,metadata) VALUES ('race-task','Read fixture','echo hello','pending','low','low','local',?)")
      .run(JSON.stringify({ lease_id: 'race-lease', workingDirectory: root }));
    const first = await engine.executeTask('race-task', 'codex');
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    pids.push(Number(fs.readFileSync(pidFile, 'utf8')));
    let stopped = false;
    const cancelling = engine.cancelTask('race-task').then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    expect(engine.isTaskRunning('race-task')).toBe(true);
    expect(runtimeConcurrencySemaphore.activeCount).toBe(initialCapacity + 1);
    expect((db.prepare("SELECT status FROM tasks WHERE id='race-task'").get() as any).status).toBe('running');
    await expect(engine.executeTask('race-task', 'codex')).rejects.toThrow('already running');
    await cancelling;
    expect(() => process.kill(pids[0], 0)).toThrow();
    expect(runtimeConcurrencySemaphore.activeCount).toBe(initialCapacity);
    const second = await engine.executeTask('race-task', 'codex');
    await vi.waitFor(() => expect(Number(fs.readFileSync(pidFile, 'utf8'))).not.toBe(pids[0]));
    pids.push(Number(fs.readFileSync(pidFile, 'utf8')));
    releaseOldResult();
    await first.completion;
    await new Promise(resolve => setImmediate(resolve));
    expect(RuntimeLeaseRegistry.isLive('race-lease')).toBe(true);
    expect(engine.isTaskRunning('race-task')).toBe(true);
    expect(runtimeConcurrencySemaphore.activeCount).toBe(initialCapacity + 1);
    expect(await RuntimeLeaseRegistry.stop('race-lease')).toBe(true);
    await second.completion;
    expect(() => process.kill(pids[1], 0)).toThrow();
    expect(runtimeConcurrencySemaphore.activeCount).toBe(initialCapacity);
  } finally {
    releaseOldResult();
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ } }
    await new Promise(resolve => setTimeout(resolve, 50));
    RuntimeLeaseRegistry.unregister('race-lease');
    runtimeConcurrencySemaphore.release('execution:race-task');
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it('does not release execution ownership when timeout result precedes child close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-timeout-close-'));
  const binary = path.join(root, 'worker');
  const pidFile = path.join(root, 'pid');
  fs.writeFileSync(binary, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(2), 10000);
`);
  fs.chmodSync(binary, 0o755);
  const db = new Database(':memory:');
  db.exec(schema); runMigrations(db);
  const initialCapacity = runtimeConcurrencySemaphore.activeCount;
  let pid: number | undefined;
  try {
    const engine = new ExecutionEngine(db);
    engine.registerExecutor(new CodexExecutor(binary));
    db.prepare("INSERT INTO tasks (id,title,description,status,priority,risk_level,execution_mode,metadata) VALUES ('timeout-close-task','Read fixture','echo hello','pending','low','low','local',?)")
      .run(JSON.stringify({ workingDirectory: root, timeoutMs: 500 }));
    const execution = await engine.executeTask('timeout-close-task', 'codex');
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const session = engine.getSession('timeout-close-task')!;
    expect((await session.result).status).toBe('failed');
    expect(() => process.kill(pid!, 0)).not.toThrow();
    let completed = false;
    void execution.completion!.then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(engine.isTaskRunning('timeout-close-task')).toBe(true);
    expect(runtimeConcurrencySemaphore.activeCount).toBe(initialCapacity + 1);
    expect((db.prepare("SELECT status FROM tasks WHERE id='timeout-close-task'").get() as any).status).toBe('running');
    await expect(engine.executeTask('timeout-close-task', 'codex')).rejects.toThrow('already running');
    await execution.completion;
    await vi.waitFor(() => expect(engine.isTaskRunning('timeout-close-task')).toBe(false));
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(runtimeConcurrencySemaphore.activeCount).toBe(initialCapacity);
    expect((db.prepare("SELECT status FROM tasks WHERE id='timeout-close-task'").get() as any).status).toBe('failed');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ } }
    await new Promise(resolve => setTimeout(resolve, 50));
    runtimeConcurrencySemaphore.release('execution:timeout-close-task');
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 12_000);
