import { describe, expect, it } from 'vitest';
import { LOOP_CATALOG, canonicalWorkerRole, isCanonicalLoopName } from './loop-catalog';

describe('loop terminology', () => {
  it('keeps runtime loops distinct from imported worker roles', () => {
    expect(LOOP_CATALOG).toHaveLength(7);
    expect(isCanonicalLoopName('doc-drift-and-small-fix-loop')).toBe(true);
    expect(isCanonicalLoopName('test_engineer')).toBe(false);
    expect(canonicalWorkerRole('test_engineer')).toBe('test-engineer');
  });
});
