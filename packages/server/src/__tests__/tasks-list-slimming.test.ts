import { describe, expect, it } from 'vitest';
import { slimMetadata } from '../routes/tasks';

describe('slimMetadata', () => {
  it('keeps small values and replaces bulky ones with a marker', () => {
    const slim = slimMetadata({ repo: 'djimit/x', n: 3, blob: 'x'.repeat(5_000), nested: { a: 'y'.repeat(600) } }) as Record<string, unknown>;
    expect(slim.repo).toBe('djimit/x');
    expect(slim.n).toBe(3);
    expect(String(slim.blob)).toMatch(/^\[truncated 5002 chars/);
    expect(String(slim.nested)).toMatch(/^\[truncated/);
  });
  it('passes non-objects through', () => {
    expect(slimMetadata(null)).toBeNull();
    expect(slimMetadata('text')).toBe('text');
    expect(slimMetadata([1, 2])).toEqual([1, 2]);
  });
});
