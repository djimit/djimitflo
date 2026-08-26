import { spawn, type ChildProcess } from 'child_process';

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
  stop(): void;
}

export function startRuntimeProcess(options: RuntimeProcessOptions): RuntimeProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let forceKill: NodeJS.Timeout | undefined;
  const stop = () => {
    if (child.killed) return;
    child.kill('SIGTERM');
    forceKill = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5_000);
    forceKill.unref();
  };
  const timeout = options.timeoutMs > 0 ? setTimeout(() => {
    stop();
    options.onTimeout?.();
  }, options.timeoutMs) : undefined;
  timeout?.unref();
  const clear = () => {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  };

  child.stdout?.on('data', data => options.onOutput(data.toString(), 'stdout'));
  child.stderr?.on('data', data => options.onOutput(data.toString(), 'stderr'));
  child.on('close', (code, signal) => { clear(); options.onExit(code, signal); });
  child.on('error', error => { clear(); options.onError(error); });
  return { child, stop };
}
