import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, reloadOnceForChunkError } from './chunk-reload';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('chunk reload after a deploy', () => {
  it('recognises Safari, Chromium and Firefox chunk-load errors, not other errors', () => {
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('reloads once, then not again within 10 s (no reload loop when the server is down)', () => {
    const storage = memory();
    const reload = vi.fn();
    expect(reloadOnceForChunkError(storage, reload, 100_000)).toBe(true);
    expect(reloadOnceForChunkError(storage, reload, 105_000)).toBe(false);
    expect(reloadOnceForChunkError(storage, reload, 111_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
