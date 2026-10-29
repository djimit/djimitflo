import { expect, it, vi } from 'vitest';
import { unknownEnvFlags, warnUnknownEnvFlags } from '../services/env-flags';

it('M2c: a set flag-shaped env name that no code reads is reported; known, dynamic and non-flag names are not', () => {
  const env = {
    LOOP_BANDIT_ENABLED: 'true', // EVOLUTION_FLAGS
    CONTENT_SAFETY_MODE: 'shadow', // NON_EVOLUTION_FLAGS
    TYPESAFE_PROPOSAL_PRESCREEN_MODE: 'enforce', // judgmentMode reads TYPESAFE_<id>_MODE dynamically
    LOOP_CHECKER_RUNTIME: 'hermes', // not flag-shaped
    LOOP_CHECKR_ENABLED: 'true', // typo: nobody reads it
    OLD_LANE_MAX_PER_DAY: '3',
  };
  expect(unknownEnvFlags(env)).toEqual(['LOOP_CHECKR_ENABLED', 'OLD_LANE_MAX_PER_DAY']);
});

it('M2c: boot logs one warning line listing the unknown names, and nothing when all are known', () => {
  const warn = vi.fn();
  warnUnknownEnvFlags({ LOOP_CHECKR_ENABLED: 'true', FOO_MODE: 'on', LOOP_BANDIT_ENABLED: 'true' }, warn);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/FOO_MODE, LOOP_CHECKR_ENABLED/);
  warn.mockClear();
  warnUnknownEnvFlags({ LOOP_BANDIT_ENABLED: 'true' }, warn);
  expect(warn).not.toHaveBeenCalled();
});
