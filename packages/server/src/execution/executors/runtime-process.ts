import { spawn, type ChildProcess } from 'child_process';

const closedProcesses = new WeakMap<ChildProcess, Promise<void>>();
const stoppingProcesses = new WeakMap<ChildProcess, Promise<void>>();

/** Register immediately after spawn: result/error/exit are not stream closure. */
export function runtimeProcessClosed(child: ChildProcess): Promise<void> {
  let closed = closedProcesses.get(child);
  if (!closed) {
    closed = new Promise(resolve => child.once('close', () => resolve()));
    closedProcesses.set(child, closed);
  }
  return closed;
}

export function stopRuntimeProcess(child: ChildProcess | null): Promise<void> {
  if (!child) return Promise.resolve();
  const stopping = stoppingProcesses.get(child);
  if (stopping) return stopping;
  const closed = runtimeProcessClosed(child);
  if (child.exitCode !== null || child.signalCode !== null) return closed;
  // killed records a signal request, not actual termination or closed streams.
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 5_000);
  forceKill.unref();
  const completion = closed.then(() => { clearTimeout(forceKill); });
  stoppingProcesses.set(child, completion);
  if (!child.killed) child.kill('SIGTERM');
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
  const child = spawn(options.command, options.args, {
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
