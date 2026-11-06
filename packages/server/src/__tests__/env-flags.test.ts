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

it('FLAG_NAME_PATTERN end anchors: _MAX_PER_DAY$ and _SHARE$ reject trailing suffixes', () => {
  expect(unknownEnvFlags({ OLD_LANE_MAX_PER_DAY_X: '3', FOO_SHARED: 'x' })).toEqual([]);
});

it('SELECTOR_NAME_PATTERN end anchors: trailing suffixes after each selector stem are not flag-shaped', () => {
  expect(unknownEnvFlags({
    FOO_RUNTIME_X: 'x', FOO_MODEL_X: 'x', FOO_PROVIDER_X: 'x',
    FOO_TIMEOUT_MS_X: 'x', FOO_SPECIES_X: 'x',
  })).toEqual([]);
});

it('SELECTOR_NAME_PATTERN start anchor: ^MODEL_CANDIDATES_ rejects a leading prefix', () => {
  expect(unknownEnvFlags({ FOO_MODEL_CANDIDATES_X: 'x' })).toEqual([]);
});

it('SELECTOR_NAME_PATTERN: a name extending MODEL_CANDIDATES_PANEL_REVIEW past the end is reported (not the dynamic read)', () => {
  expect(unknownEnvFlags({ MODEL_CANDIDATES_PANEL_REVIEWX: 'x' })).toEqual(['MODEL_CANDIDATES_PANEL_REVIEWX']);
});

it('DYNAMIC_FLAGS TYPESAFE regex: a multi-char id is read dynamically, not reported', () => {
  expect(unknownEnvFlags({ TYPESAFE_FOO_MODE: 'x' })).toEqual([]);
});

it('DYNAMIC_FLAGS TYPESAFE regex anchors: a leading prefix or trailing suffix is reported', () => {
  expect(unknownEnvFlags({ X_TYPESAFE_FOO_MODE: 'x' })).toEqual(['X_TYPESAFE_FOO_MODE']);
  expect(unknownEnvFlags({ TYPESAFE_FOO_MODE_BAR: 'x' })).toEqual(['TYPESAFE_FOO_MODE_BAR']);
});

it('DYNAMIC_FLAGS SOCIAL_MODEL regex anchors: a leading prefix or trailing suffix is reported', () => {
  expect(unknownEnvFlags({ X_CLAUDE_SOCIAL_MODEL: 'x' })).toEqual(['X_CLAUDE_SOCIAL_MODEL']);
  expect(unknownEnvFlags({ AA_SOCIAL_MODEL_RUNTIME: 'x' })).toEqual(['AA_SOCIAL_MODEL_RUNTIME']);
});

it('conditionallyRead: LLM_FALLBACK_MODEL (no digit) is read when its OPENAI_URL is set', () => {
  expect(unknownEnvFlags({ LLM_FALLBACK_MODEL: 'm', LLM_FALLBACK_OPENAI_URL: 'http://x' })).toEqual([]);
});

it('conditionallyRead: a leading prefix is reported even with a matching OPENAI_URL set', () => {
  expect(unknownEnvFlags({ XLLM_FALLBACK_MODEL: 'm', LLM_FALLBACK_OPENAI_URL: 'http://x' })).toEqual(['XLLM_FALLBACK_MODEL']);
});

it('conditionallyRead: a trailing suffix is reported even with a matching OPENAI_URL set', () => {
  expect(unknownEnvFlags({ LLM_FALLBACK2_MODEL_RUNTIME: 'm', LLM_FALLBACK2_OPENAI_URL: 'http://x' })).toEqual(['LLM_FALLBACK2_MODEL_RUNTIME']);
});

it('conditionallyRead: a whitespace-only OPENAI_URL does not count as set', () => {
  expect(unknownEnvFlags({ LLM_FALLBACK2_MODEL: 'm', LLM_FALLBACK2_OPENAI_URL: '   ' })).toEqual(['LLM_FALLBACK2_MODEL']);
});

it('passthrough: surrounding whitespace is trimmed so a flag-shaped passthrough name is not reported', () => {
  expect(unknownEnvFlags({ RUNTIME_ENV_PASSTHROUGH: '  FOO_MODE  ', FOO_MODE: 'on' })).toEqual([]);
});
