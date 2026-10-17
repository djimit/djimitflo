import { describe, expect, it } from 'vitest';
import { wilson } from '../services/evolution-estimators';

describe('evolution-estimators exports — wilson', () => {
  it('returns [0, 1] when n is 0 (insufficient sample)', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('returns [0, 1] when n is negative', () => {
    expect(wilson(0, -3)).toEqual([0, 1]);
  });

  it('returns a valid 95% interval for k=0 of n=10', () => {
    const [lo, hi] = wilson(0, 10);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeLessThan(0.5);
  });

  it('returns a valid 95% interval for k=n=10 (all successes)', () => {
    const [lo, hi] = wilson(10, 10);
    expect(hi).toBe(1);
    expect(lo).toBeLessThan(1);
    expect(lo).toBeGreaterThan(0.5);
  });

  it('returns a symmetric-ish interval around 0.5 for k=n/2', () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
    expect(hi - lo).toBeLessThanOrEqual(0.7);
    expect(lo + hi).toBeCloseTo(1, 1);
  });

  it('respects a custom z value (tighter interval for smaller z)', () => {
    const [lo95, hi95] = wilson(5, 20, 1.96);
    const [lo50, hi50] = wilson(5, 20, 0.674); // ~50% interval
    expect(hi50 - lo50).toBeLessThan(hi95 - lo95);
  });

  it('rounds the bounds to 4 decimal places', () => {
    const [lo, hi] = wilson(7, 12);
    const round4 = (v: number) => +v.toFixed(4);
    expect(lo).toBe(round4(lo));
    expect(hi).toBe(round4(hi));
  });

  it('keeps the interval within [0, 1] for an extreme proportion', () => {
    const [lo, hi] = wilson(1, 1000);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(hi);
  });
});