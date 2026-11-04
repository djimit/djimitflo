import { describe, expect, it } from 'vitest';
import { bootstrapM1, randomOrderM1, type EvPrediction, type EvOutcome } from '../services/execution-value';

const mkPred = (id: string, p = 0.5, cost = 1): EvPrediction => ({
  id, created_at: '2026-01-01T00:00:00Z', p, sd: 0.1, cost, ev: +(p - cost * 0.1).toFixed(6), n_cell: 1, novel: false,
});

const mkOutcome = (id: string, y: 0 | 1 | null, cost = 1): EvOutcome => ({
  id, y, cost, cost_imputed: false, latency_h: null, merged: false, regressed: false, first_pair: false, pair: `${id}|x`, arms: ['A'],
});

describe('bootstrapM1', () => {
  const ps: EvPrediction[] = [mkPred('a'), mkPred('b'), mkPred('c'), mkPred('d')];
  const outcomes = new Map<string, EvOutcome>([
    ['a', mkOutcome('a', 1)],
    ['b', mkOutcome('b', 0)],
    ['c', mkOutcome('c', 1)],
    ['d', mkOutcome('d', 1)],
  ]);

  it('returns confidence intervals for B−A and C−A differences', () => {
    const r = bootstrapM1(ps, outcomes, 0.8, 200, 42);
    expect(r).toHaveProperty('b_minus_a');
    expect(r).toHaveProperty('c_minus_a');
    expect(Array.isArray(r.b_minus_a)).toBe(true);
    expect(Array.isArray(r.c_minus_a)).toBe(true);
    expect(r.b_minus_a).toHaveLength(2);
    expect(r.c_minus_a).toHaveLength(2);
    expect(r.b_minus_a[0]).toBeLessThanOrEqual(r.b_minus_a[1]);
    expect(r.c_minus_a[0]).toBeLessThanOrEqual(r.c_minus_a[1]);
  });

  it('is deterministic for the same seed', () => {
    const a = bootstrapM1(ps, outcomes, 0.8, 200, 99);
    const b = bootstrapM1(ps, outcomes, 0.8, 200, 99);
    expect(a).toEqual(b);
  });

  it('produces zero-width CIs when all runs succeed with equal cost', () => {
    const uniform: EvPrediction[] = [mkPred('x'), mkPred('y'), mkPred('z')];
    const uOutcomes = new Map<string, EvOutcome>([
      ['x', mkOutcome('x', 1)],
      ['y', mkOutcome('y', 1)],
      ['z', mkOutcome('z', 1)],
    ]);
    const r = bootstrapM1(uniform, uOutcomes, 1, 100, 7);
    // M1 = successes / spent; all y=1 and cost=1 → M1 always 1 → differences always 0
    expect(r.b_minus_a).toEqual([0, 0]);
    expect(r.c_minus_a).toEqual([0, 0]);
  });
});

describe('randomOrderM1', () => {
  const ps: EvPrediction[] = [mkPred('a'), mkPred('b'), mkPred('c'), mkPred('d')];
  const outcomes = new Map<string, EvOutcome>([
    ['a', mkOutcome('a', 1)],
    ['b', mkOutcome('b', 0)],
    ['c', mkOutcome('c', 1)],
    ['d', mkOutcome('d', 0)],
  ]);

  it('returns mean, band95, and share_beaten with valid ranges', () => {
    const r = randomOrderM1(ps, outcomes, 0.8, 0.5, 200, 42);
    expect(typeof r.mean).toBe('number');
    expect(Array.isArray(r.band95)).toBe(true);
    expect(r.band95).toHaveLength(2);
    expect(r.band95[0]).toBeLessThanOrEqual(r.band95[1]);
    expect(typeof r.share_beaten).toBe('number');
    expect(r.share_beaten).toBeGreaterThanOrEqual(0);
    expect(r.share_beaten).toBeLessThanOrEqual(1);
  });

  it('is deterministic for the same seed', () => {
    const a = randomOrderM1(ps, outcomes, 0.8, 0.5, 200, 77);
    const b = randomOrderM1(ps, outcomes, 0.8, 0.5, 200, 77);
    expect(a).toEqual(b);
  });

  it('share_beaten is 1 when m1 exceeds all permutation values (full budget)', () => {
    // f=1 → all 4 selected regardless of order; M1 = 2/4 = 0.5 always
    const r = randomOrderM1(ps, outcomes, 1, 0.6, 100, 5);
    expect(r.mean).toBe(0.5);
    expect(r.share_beaten).toBe(1);
  });

  it('share_beaten is 0 when m1 is below all permutation values (full budget)', () => {
    const r = randomOrderM1(ps, outcomes, 1, -1, 100, 5);
    expect(r.share_beaten).toBe(0);
  });
});
