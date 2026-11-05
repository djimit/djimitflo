import { it, expect } from 'vitest';
import { slug } from '../src/normalize';

it('slug: unchanged output for ordinary names', () => {
  expect(slug('engineering/Secure Coder')).toBe('engineering-secure-coder');
  expect(slug('  --Café Crème!!  ')).toBe('cafe-creme');
  expect(slug('Ops/SRE — On-Call (v2)')).toBe('ops-sre-on-call-v2');
  expect(slug('')).toBe('');
  expect(slug(undefined as unknown as string)).toBe('');
  expect(slug('---')).toBe('');
});

it('slug: a long adversarial input is bounded before the regex chain and returns fast', () => {
  for (const evil of ['a-'.repeat(500_000), '-'.repeat(1_000_000) + 'a', 'a' + ' -'.repeat(500_000) + '!']) {
    const t = performance.now();
    const out = slug(evil);
    expect(performance.now() - t).toBeLessThan(100);
    expect(out.length).toBeLessThanOrEqual(256);
    expect(out).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/); // well-formed (may be empty; normalizeAgent then falls back)
  }
});
