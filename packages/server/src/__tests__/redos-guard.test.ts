import { describe, expect, it } from 'vitest';
import { ReDoSGuard } from '../services/redos-guard';

describe('ReDoSGuard', () => {
  it('rejects obvious nested quantifiers and accepts simple patterns', () => {
    expect(ReDoSGuard.compile('(a+)+')).toBeNull();
    expect(ReDoSGuard.safeTest('allowed', '{"action":"allowed"}')).toBe(true);
  });
});
