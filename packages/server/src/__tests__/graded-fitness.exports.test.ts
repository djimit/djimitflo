import { describe, expect, it } from 'vitest';
import { roundGraded, leaseGraded } from '../services/graded-fitness';

describe('roundGraded', () => {
  it('clamps below 0 to 0', () => {
    expect(roundGraded(-0.5)).toBe(0);
  });

  it('clamps above 1 to 1', () => {
    expect(roundGraded(1.5)).toBe(1);
  });

  it('rounds to 3 decimals', () => {
    expect(roundGraded(0.123456)).toBe(0.123);
  });

  it('keeps a value already in range with 3 decimals', () => {
    expect(roundGraded(0.834)).toBe(0.834);
  });

  it('returns a number, not a string', () => {
    expect(typeof roundGraded(0.5)).toBe('number');
  });
});

describe('leaseGraded', () => {
  it('returns a graded entry with a valid score and kind', () => {
    const out = leaseGraded({ graded: { score: 0.666, kind: 'mutant_kill', ms: 10 } });
    expect(out).toEqual({ score: 0.666, kind: 'mutant_kill' });
  });

  it('rounds the score via roundGraded', () => {
    const out = leaseGraded({ graded: { score: 0.66666, kind: 'mutant_kill', ms: 1 } });
    expect(out?.score).toBe(0.667);
  });

  it('preserves the lane when present', () => {
    const out = leaseGraded({ graded: { score: 1, kind: 'mutant_kill', lane: 'exports', ms: 1 } });
    expect(out).toEqual({ score: 1, kind: 'mutant_kill', lane: 'exports' });
  });

  it('returns null when graded is absent', () => {
    expect(leaseGraded({})).toBeNull();
  });

  it('returns null when score is missing', () => {
    expect(leaseGraded({ graded: { kind: 'mutant_kill', ms: 1 } })).toBeNull();
  });

  it('returns null when kind is missing', () => {
    expect(leaseGraded({ graded: { score: 0.5, ms: 1 } })).toBeNull();
  });

  it('returns null when score is not finite', () => {
    expect(leaseGraded({ graded: { score: Number.NaN, kind: 'mutant_kill', ms: 1 } })).toBeNull();
  });

  it('returns null when graded is not an object', () => {
    expect(leaseGraded({ graded: 'nope' })).toBeNull();
  });
});