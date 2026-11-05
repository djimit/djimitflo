import { expect, it } from 'vitest';
import { gymGraded } from '../services/remote-gym-service';

// re-20261105 E9 / SYNTHESIS P1-11: a write_test result without a killed_mutants list scored mutant_kill 0 (remote-gym-service:110),
// which fed graded fitness and PL-001; a missing count is unknown, never a kill share of 0
it('write_test: a missing killed count is no graded score; a reported empty list is a real 0', () => {
  const gym = { kind: 'write_test', mutant_keys: ['m1', 'm2', 'm3'] };
  expect(gymGraded(gym, { status: 'success' } as never, undefined)).toBeNull();
  expect(gymGraded(gym, { status: 'success' } as never, [])).toEqual({ graded: 0, graded_kind: 'mutant_kill' });
  expect(gymGraded(gym, { status: 'success' } as never, ['m1'])).toEqual({ graded: 0.333, graded_kind: 'mutant_kill' });
  // repair tasks keep their binary fallback
  expect(gymGraded({ kind: 'repair' }, { status: 'failure' } as never)).toEqual({ graded: 0, graded_kind: 'binary' });
});
