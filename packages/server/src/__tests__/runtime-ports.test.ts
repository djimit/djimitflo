import { it, expect, vi } from 'vitest';
import { execFile } from 'child_process';
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn() };
});
import { scanListeningPorts } from '../routes';

it('bounds native inventory and yields while waiting for the child process', async () => {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    setImmediate(() => callback(null, { stdout: process.platform === 'darwin'
      ? 'tcp4 0 0 127.0.0.1.3187 *.* LISTEN 0 0 131072 131072 node:123 00000\ntcp6 0 0 *.8080 *.* LISTEN 0 0 131072 131072 Google Chrome He:456 00000\ntcp4 0 0 127.0.0.1.9999 127.0.0.1.1234 ESTABLISHED 0 0 131072 131072 node:123 00000\n'
      : 'LISTEN 0 128 127.0.0.1:3187 0.0.0.0:* users:(("node",pid=123,fd=7))\n', stderr: '' }));
  }) as any);
  const pending = scanListeningPorts();
  expect(pending).toBeInstanceOf(Promise);
  expect(mock).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 5000, killSignal: 'SIGKILL' }), expect.any(Function));
  expect(await pending).toEqual([
    { address: '127.0.0.1', port: 3187, pid: 123, process: 'node', bind: 'Localhost' },
    ...(process.platform === 'darwin' ? [{ address: '*', port: 8080, pid: 456, process: 'Google Chrome He', bind: 'LAN' }] : []),
  ]);
  // Best-effort local introspection: a scan failure (missing binary, timeout,
  // unsupported platform) degrades to an empty list instead of rejecting, so
  // a slim production container without netstat/ss doesn't 503 the route.
  mock.mockImplementation(((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    setImmediate(() => callback(new Error('scan timed out')));
  }) as any);
  await expect(scanListeningPorts()).resolves.toEqual([]);
});
