import { describe, expect, it } from 'vitest';
import { spawnAsync } from '../services/spawn-async';

describe('spawnAsync (event-loop-freeze plan)', () => {
  it('returns exit status and output like spawnSync', async () => {
    const r = await spawnAsync(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    expect(r).toMatchObject({ status: 3, stdout: 'out', stderr: 'err' });
    expect(r.error).toBeUndefined();
  });
  it('a timeout kills the child, status null, error mentions ETIMEDOUT', async () => {
    const r = await spawnAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 });
    expect(r.status).toBeNull();
    expect(r.error?.message).toContain('ETIMEDOUT');
  });
  it('a missing binary resolves (status null + error) instead of throwing', async () => {
    const r = await spawnAsync('definitely-not-a-binary-xyz', []);
    expect(r.status).toBeNull();
    expect(r.error).toBeDefined();
  });
  it('keeps the event loop free while the child runs', async () => {
    let ticks = 0; const iv = setInterval(() => { ticks++; }, 20);
    await spawnAsync(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(5);
  });
  it('caps output at maxBuffer', async () => {
    const r = await spawnAsync(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBuffer: 100 });
    expect(r.stdout.length).toBe(100);
  });
});
