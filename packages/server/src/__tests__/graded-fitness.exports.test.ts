import { expect, it } from 'vitest';
import { roundGraded, leaseGraded } from '../services/graded-fitness';

// --- roundGraded ---
it('roundGraded clamps below 0 up to 0', () => {
  expect(roundGraded(-0.5)).toBe(0);
});

it('roundGraded clamps above 1 down to 1', () => {
  expect(roundGraded(1.7)).toBe(1);
});

it('roundGraded rounds to 3 decimals', () => {
  expect(roundGraded(0.123456)).toBe(0.123);
  expect(roundGraded(2 / 3)).toBe(0.667);
});

it('roundGraded keeps 0 and 1 intact', () => {
  expect(roundGraded(0)).toBe(0);
  expect(roundGraded(1)).toBe(1);
});

// --- leaseGraded ---
it('leaseGraded returns null when graded is absent', () => {
  expect(leaseGraded({})).toBeNull();
  expect(leaseGraded({ graded: undefined })).toBeNull();
});

it('leaseGraded returns null when score is missing or non-finite', () => {
  expect(leaseGraded({ graded: { kind: 'mutant_kill', ms: 1 } })).toBeNull();
  expect(leaseGraded({ graded: { score: NaN, kind: 'mutant_kill', ms: 1 } })).toBeNull();
  expect(leaseGraded({ graded: { score: Infinity, kind: 'mutant_kill', ms: 1 } })).toBeNull();
});

it('leaseGraded returns null when kind is missing', () => {
  expect(leaseGraded({ graded: { score: 0.5, ms: 1 } })).toBeNull();
});

it('leaseGraded returns the rounded score, kind and omits lane when absent', () => {
  expect(leaseGraded({ graded: { score: 0.1239, kind: 'mutation_score', ms: 5 } })).toEqual({
    score: 0.124,
    kind: 'mutation_score',
  });
});

it('leaseGraded clamps the score into [0, 1]', () => {
  expect(leaseGraded({ graded: { score: -1, kind: 'binary', ms: 1 } })).toEqual({ score: 0, kind: 'binary' });
  expect(leaseGraded({ graded: { score: 2, kind: 'tests_green', ms: 1 } })).toEqual({ score: 1, kind: 'tests_green' });
});

it('leaseGraded includes lane only when present', () => {
  expect(leaseGraded({ graded: { score: 0.5, kind: 'mutant_kill', lane: 'exports', ms: 1 } })).toEqual({
    score: 0.5,
    kind: 'mutant_kill',
    lane: 'exports',
  });
  expect(leaseGraded({ graded: { score: 0.5, kind: 'mutant_kill', ms: 1 } })).not.toHaveProperty('lane');
});