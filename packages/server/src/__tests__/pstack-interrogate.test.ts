import { describe, expect, it } from 'vitest';
import {
  PSTACK_INTERROGATE_POLICY_HASH,
  PSTACK_INTERROGATE_SOURCE,
  PSTACK_INTERROGATE_SOURCE_SHA,
  PSTACK_INTERROGATE_VERSION,
  pstackInterrogatePolicy,
} from '../services/pstack-interrogate';

describe('pstack interrogate policy', () => {
  it('is immutable, provenance-pinned and asks for reproducible findings', () => {
    const policy = pstackInterrogatePolicy().join('\n');
    expect(PSTACK_INTERROGATE_VERSION).toBe('cursor-pstack@50b3a323');
    expect(PSTACK_INTERROGATE_SOURCE).toContain('/pstack/skills/interrogate');
    expect(PSTACK_INTERROGATE_SOURCE_SHA).toMatch(/^[a-f0-9]{64}$/);
    expect(PSTACK_INTERROGATE_POLICY_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(policy).toContain('exact check');
    expect(policy).toContain('Drop hypotheses');
  });
});
