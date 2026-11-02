import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

const closedProcesses = new WeakMap<ChildProcess, Promise<void>>();
const stoppingProcesses = new WeakMap<ChildProcess, Promise<void>>();

/**
 * ORCA-PG (docs/research/orca): an agent CLI's own children (test runners, shells, MCP servers) inherit its stdout pipe.
 * Signalling only the CLI leaves them running after a cancel or timeout, and `close` (which finalises the lease and
 * frees the runtime permit) waits until the last of them exits. With RUNTIME_PROCESS_GROUP_KILL=on each runtime is
 * spawned as the leader of its own POSIX process group and a stop signals the whole group. Default off: unchanged.
 */
export function runtimeProcessGroupKillEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && env.RUNTIME_PROCESS_GROUP_KILL === 'on';
}

/** Only children spawned here as group leaders are ever group-signalled; everything else keeps the handle-only kill. */
const groupLeaders = new WeakSet<ChildProcess>();
/** Live process-group ids, so a server exit can take its runtimes with it (detached groups miss the terminal's SIGINT). */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killLiveGroups(): void {
  for (const pgid of liveGroups) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* group already gone */ }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', killLiveGroups);
  // A signal without a listener kills node without 'exit' (index.ts handles only SIGTERM). Only where nobody else
  // listens: take the groups down, then re-raise so the default disposition still terminates the server.
  for (const signal of ['SIGINT', 'SIGHUP'] as const) {
    if (process.listenerCount(signal) > 0) continue;
    const relay = () => {
      killLiveGroups();
      process.removeListener(signal, relay);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, relay);
  }
}

/** After the root exits, descendants get this long to finish (Orca's PROCESS_EXIT_GRACE_MS) before the group is killed. */
export const RUNTIME_GROUP_EXIT_GRACE_MS = 2_000;

/** Drop-in for `spawn` at every runtime call site. Flag off: identical options, identical behaviour. */
export function spawnRuntime(command: string, args: readonly string[], options: SpawnOptions, exitGraceMs = RUNTIME_GROUP_EXIT_GRACE_MS): ChildProcess {
  const grouped = runtimeProcessGroupKillEnabled();
  const child = spawn(command, args, grouped ? { ...options, detached: true } : options);
  if (grouped && child.pid) {
    const pgid = child.pid;
    groupLeaders.add(child);
    liveGroups.add(pgid);
    installExitHook();
    // The group's lifetime is bound to its root: whatever the runtime left behind is reaped, so `close` can fire.
    // Safe against PID reuse: the kernel does not hand out a PID while it is still in use as a process-group id.
    child.once('exit', () => {
      const reap = setTimeout(() => {
        if (processGroupExists(pgid)) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* raced */ } }
        liveGroups.delete(pgid);
      }, exitGraceMs);
      reap.unref();
      // A member that closed its stdio can outlive `close`; only an empty group cancels the reap.
      void runtimeProcessClosed(child).then(() => {
        if (!processGroupExists(pgid)) { clearTimeout(reap); liveGroups.delete(pgid); }
      });
    });
  }
  return child;
}

/** ESRCH = no process left in the group. EPERM means it exists (and is not ours to probe) — treat as present. */
export function processGroupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

/** Group-signal a leader spawned by spawnRuntime; otherwise (or when the group is already gone) signal the handle. */
export function signalRuntimeProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (groupLeaders.has(child) && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* ESRCH: fall back to the handle */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Register immediately after spawn: result/error/exit are not stream closure. */
export function runtimeProcessClosed(child: ChildProcess): Promise<void> {
  let closed = closedProcesses.get(child);
  if (!closed) {
    closed = new Promise(resolve => child.once('close', () => resolve()));
    closedProcesses.set(child, closed);
  }
  return closed;
}

export function stopRuntimeProcess(child: ChildProcess | null, options: { graceMs?: number } = {}): Promise<void> {
  if (!child) return Promise.resolve();
  const stopping = stoppingProcesses.get(child);
  if (stopping) return stopping;
  const closed = runtimeProcessClosed(child);
  const grouped = groupLeaders.has(child) && !!child.pid;
  const rootExited = child.exitCode !== null || child.signalCode !== null;
  // A grouped root that already exited can still have descendants holding the pipe; only the legacy path stops here.
  if (rootExited && (!grouped || !processGroupExists(child.pid!))) return closed;
  const graceMs = options.graceMs ?? 5_000;
  // killed records a signal request, not actual termination or closed streams.
  const forceKill = setTimeout(() => {
    if (grouped) { if (processGroupExists(child.pid!)) signalRuntimeProcess(child, 'SIGKILL'); }
    else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, graceMs);
  forceKill.unref();
  const completion = closed.then(() => { clearTimeout(forceKill); });
  stoppingProcesses.set(child, completion);
  if (grouped) signalRuntimeProcess(child, 'SIGTERM');
  else if (!child.killed) child.kill('SIGTERM');
  return completion;
}

interface RuntimeProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput: (text: string, stream: 'stdout' | 'stderr') => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
  onTimeout?: () => void;
}

export interface RuntimeProcess {
  child: ChildProcess;
  stop(): Promise<void>;
}

export function startRuntimeProcess(options: RuntimeProcessOptions): RuntimeProcess {
  const child = spawnRuntime(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  void runtimeProcessClosed(child);
  const stop = () => stopRuntimeProcess(child);
  const timeout = options.timeoutMs > 0 ? setTimeout(() => {
    stop();
    options.onTimeout?.();
  }, options.timeoutMs) : undefined;
  timeout?.unref();
  const clear = () => {
    if (timeout) clearTimeout(timeout);
  };

  child.stdout?.on('data', data => options.onOutput(data.toString(), 'stdout'));
  child.stderr?.on('data', data => options.onOutput(data.toString(), 'stderr'));
  child.on('close', (code, signal) => { clear(); options.onExit(code, signal); });
  child.on('error', error => { clear(); options.onError(error); });
  return { child, stop };
}
