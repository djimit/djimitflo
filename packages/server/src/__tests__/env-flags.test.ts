import { expect, it, vi } from 'vitest';
import { unknownEnvFlags, warnUnknownEnvFlags } from '../services/env-flags';

it('M2c: a set flag-shaped env name that no code reads is reported; known, dynamic and non-flag names are not', () => {
  const env = {
    LOOP_BANDIT_ENABLED: 'true', // EVOLUTION_FLAGS
    CONTENT_SAFETY_MODE: 'shadow', // NON_EVOLUTION_FLAGS
    TYPESAFE_PROPOSAL_PRESCREEN_MODE: 'enforce', // judgmentMode reads TYPESAFE_<id>_MODE dynamically
    LOOP_CHECKER_RUNTIME: 'hermes', // runtime selector nobody reads (prod 29-10: checkers ran opencode 73/77)
    LOOP_CHECKR_ENABLED: 'true', // typo: nobody reads it
    OLD_LANE_MAX_PER_DAY: '3',
  };
  expect(unknownEnvFlags(env)).toEqual(['LOOP_CHECKER_RUNTIME', 'LOOP_CHECKR_ENABLED', 'OLD_LANE_MAX_PER_DAY']);
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

// Codex review #1094: the A-capability-map (29-10) names set in prod that no code path reads. Each must be reported.
const A_MAP_UNREAD = ['LOOP_CHECKER_RUNTIME', 'LOOP_MAKER_RUNTIME', 'DJIMITFLO_HERMES_MODEL', 'DJIMITFLO_HERMES_PROVIDER', 'LITELLM_DEFAULT_MODEL',
  'LITELLM_EXECUTION_TIMEOUT_MS', 'LLM_FALLBACK2_MODEL', 'MODEL_CANDIDATES_FRONTIER_EXPERTS', 'RUFLO_EXECUTION_TIMEOUT_MS'];

it('review #1094: every set-but-unread runtime/model selector from the A capability map is reported', () => {
  const env = Object.fromEntries(A_MAP_UNREAD.map((n) => [n, 'x']));
  expect(unknownEnvFlags(env)).toEqual([...A_MAP_UNREAD].sort());
});

it('review #1094: selectors some code path reads are not reported (literal, allowlisted, passthrough, dynamic)', () => {
  const env = {
    DJIMITFLO_OPENCODE_MODEL: 'x', // literal read + child env allowlist
    LOOP_DAEMON_MAKER_RUNTIME: 'opencode', // literal read (loop-daemon reviewer runtime)
    DJIMITFLO_PI_MODEL: 'x', // leaseIdentity reads DJIMITFLO_<lease runtime>_MODEL
    MODEL_CANDIDATES_PANEL_REVIEW: 'a,b', // model-selector candidates('panel_review')
    CLAUDE_SOCIAL_MODEL: 'x', // commons-runtime-proof reads <RUNTIME>_SOCIAL_MODEL
    LLM_FALLBACK2_OPENAI_URL: 'http://b', LLM_FALLBACK2_MODEL: 'm', // read only together with its endpoint
    RUNTIME_ENV_PASSTHROUGH: 'EXTRA_CHILD_MODEL', EXTRA_CHILD_MODEL: 'x', // passed to every child runtime
  };
  expect(unknownEnvFlags(env)).toEqual([]);
});
