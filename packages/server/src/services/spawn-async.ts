import { spawn, type SpawnOptions } from 'child_process';

/**
 * Event-loop-freeze plan (2026-11-18): `spawnSync` for minutes-long commands (npm checks, npm ci) froze the whole server —
 * prod 00:08–00:17Z: a 7m40s test:changed, /health timing out, no request served. This is the non-blocking twin with the
 * result shape the callers already read from spawnSync: `status` (null when killed/not started), `stdout`, `stderr`, and
 * `error` whose message contains ETIMEDOUT on a timeout. Output beyond `maxBuffer` is dropped (spawnSync would kill instead).
 */
export interface SpawnAsyncResult { status: number | null; stdout: string; stderr: string; error?: Error }

export function spawnAsync(command: string, args: readonly string[], opts: SpawnOptions & { timeout?: number; maxBuffer?: number } = {}): Promise<SpawnAsyncResult> {
  const { timeout, maxBuffer = 5 * 1024 * 1024, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let stdout = '', stderr = '', error: Error | undefined, timer: NodeJS.Timeout | undefined;
    const append = (cur: string, chunk: Buffer) => (cur.length >= maxBuffer ? cur : (cur + chunk.toString('utf8')).slice(0, maxBuffer));
    let child;
    try { child = spawn(command, [...args], { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      resolve({ status: null, stdout, stderr, error: e instanceof Error ? e : new Error(String(e)) }); return;
    }
    child.stdout?.on('data', (c: Buffer) => { stdout = append(stdout, c); });
    child.stderr?.on('data', (c: Buffer) => { stderr = append(stderr, c); });
    if (timeout && timeout > 0) timer = setTimeout(() => { error = new Error(`spawnAsync ${command} ETIMEDOUT`); child.kill('SIGTERM'); }, timeout);
    let done = false;
    const finish = (code: number | null) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ status: error ? null : code, stdout, stderr, error }); };
    child.once('error', (e) => { error ??= e; if (child.pid === undefined) finish(null); }); // not started (ENOENT): no 'close' guaranteed
    child.once('close', (code) => finish(code));
  });
}
