import { expect, it } from 'vitest';
import { runtimeConfigView } from '../services/runtime-config-view';

it('lists flags, masks secrets by name and by value, and skips system variables', () => {
  const { entries, masked } = runtimeConfigView({
    LOOP_EVOLVE_SPECIES: 'remote@workstation/atomic@llama-router', STALL_WATCH_ENABLED: 'true',
    NVIDIA_API_KEY: 'nvapi-abcdefghijklmnop', GITHUB_TOKEN: 'ghp_x', SOCIAL_COMPAT_BASE_URL: 'https://ollama.com/v1',
    LITELLM_URL_WITH_CREDS: 'http://user:pass@host:4000', SOME_NOTE: 'sk-abcdefghijklmnopqrst',
    PATH: '/usr/bin', lower_case: 'x',
  });
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  expect(by.LOOP_EVOLVE_SPECIES).toMatchObject({ value: 'remote@workstation/atomic@llama-router', masked: false, group: 'LOOP' });
  expect(by.SOCIAL_COMPAT_BASE_URL.masked).toBe(false);
  for (const n of ['NVIDIA_API_KEY', 'GITHUB_TOKEN', 'LITELLM_URL_WITH_CREDS', 'SOME_NOTE']) {
    expect(by[n].masked).toBe(true); expect(by[n].value).toMatch(/^set \(\d+ chars\)$/);
  }
  expect(JSON.stringify(entries)).not.toMatch(/nvapi-|ghp_x|user:pass|sk-abc/);
  expect(by.PATH).toBeUndefined(); expect(by.lower_case).toBeUndefined();
  expect(masked).toBe(4);
});

// DF-08: per key source / default / overridden / takes_effect / area, and the running artifact identity
const BUILD = 'b'.repeat(40);
const view = (env: Record<string, string>) => {
  const v = runtimeConfigView(env);
  return { ...v, by: Object.fromEntries(v.entries.map((e) => [e.name, e])) };
};

it('never exposes a secret value, whatever metadata the key gets', () => {
  const secrets = { NVIDIA_API_KEY: 'nvapi-abcdefghijklmnop', TELEGRAM_BOT_TOKEN: '123456:ABCdefGHIjklMNOpqr', DJIMITFLO_PUBLIC_URL: 'https://op:hunter2pass@flo.example' };
  const { by, entries } = view({ ...secrets, DJIMITFLO_BUILD_COMMIT: BUILD });
  for (const name of Object.keys(secrets)) {
    expect(by[name]).toMatchObject({ masked: true, source: 'env', overridden: null });
    expect(by[name].value).toMatch(/^set \(\d+ chars\)$/);
  }
  // DJIMITFLO_PUBLIC_URL has a runbook default; masking still wins and no comparison is reported
  expect(by.DJIMITFLO_PUBLIC_URL.default).toBe('unset');
  const json = JSON.stringify(entries);
  for (const v of Object.values(secrets)) expect(json).not.toContain(v);
  expect(json).not.toContain('hunter2');
});

it('computes overridden against the runbook default, per key kind', () => {
  const { by } = view({
    LOOP_BANDIT_MAX_SHARE: '0.2', EVOLUTION_GYM_REMOTE_MAX_PER_DAY: '24', LOOP_EVOLVE_ENABLED: 'true', DREAM_TRIAL_MUTANTS: 'false',
    DREAM_TRIAL_MUTANT_TIERS: '2,3', PANEL_FALLBACK_MODEL: 'sonnet', SCHEDULER_SELF_HEAL_MODE: 'shadow', LOOP_AUTO_MERGE_REPOS: 'a/b',
    SOME_UNREGISTERED_FLAG: 'x',
  });
  expect(by.LOOP_BANDIT_MAX_SHARE).toMatchObject({ source: 'env', default: '0.1', overridden: true });
  expect(by.EVOLUTION_GYM_REMOTE_MAX_PER_DAY).toMatchObject({ default: '24', overridden: false });
  expect(by.LOOP_EVOLVE_ENABLED).toMatchObject({ default: 'off', overridden: true });
  expect(by.DREAM_TRIAL_MUTANTS).toMatchObject({ default: 'off', overridden: false });
  expect(by.DREAM_TRIAL_MUTANT_TIERS).toMatchObject({ default: '2,3', overridden: false });
  expect(by.PANEL_FALLBACK_MODEL).toMatchObject({ default: 'haiku', overridden: true });
  expect(by.SCHEDULER_SELF_HEAL_MODE).toMatchObject({ default: 'shadow', overridden: false });
  // prose default the code cannot compare: shown, overridden unknown
  expect(by.LOOP_AUTO_MERGE_REPOS.default).toMatch(/primary repo/);
  expect(by.LOOP_AUTO_MERGE_REPOS.overridden).toBeNull();
  expect(by.SOME_UNREGISTERED_FLAG).toMatchObject({ source: 'env', default: null, overridden: null, area: 'other' });
  // process.env is read once at boot (nothing in the server writes it later): every key takes effect on restart
  expect(new Set(Object.values(by).map((e) => e.takes_effect))).toEqual(new Set(['restart']));
});

it('lists an unset registry key with its default, and areas by task', () => {
  const { by } = view({ OLLAMA_URL: 'http://x:11434', LOOP_DAEMON_INTERVAL_MS: '60000', OIDC_ISSUER: 'https://idp' });
  expect(by.DREAM_PROMOTION_ALPHA).toMatchObject({ value: null, source: 'default', default: '0.05', overridden: false, masked: false });
  expect(by.LOOP_BANDIT_SPECIES).toMatchObject({ value: null, source: 'default', default: 'unset' });
  // a scheduler gating flag without a runbook default is still listed, as unset
  expect(by.STALL_WATCH_ENABLED).toMatchObject({ value: null, source: 'unset', default: null, overridden: null, area: 'schedulers' });
  expect(by.OLLAMA_URL.area).toBe('models/routing');
  expect(by.EVOLUTION_GYM_REMOTE_MAX_PER_DAY.area).toBe('budgets/caps');
  expect(by.LOOP_DAEMON_INTERVAL_MS.area).toBe('schedulers');
  expect(by.OIDC_ISSUER.area).toBe('security/auth');
  expect(by.DREAM_PROMOTION_ALPHA.area).toBe('experiments');
});

it('reports the running build identity and flags a stale DJIMITFLO_COMMIT_SHA env value', () => {
  const stale = view({ DJIMITFLO_COMMIT_SHA: 'a'.repeat(40), DJIMITFLO_BUILD_COMMIT: BUILD, DJIMITFLO_BUILD_TIME: '2026-10-23T10:00:00Z' });
  expect(stale.build).toMatchObject({ built_commit: BUILD, commit: 'a'.repeat(40), commit_matches_build: false, build_time: '2026-10-23T10:00:00Z' });
  expect(stale.by.DJIMITFLO_COMMIT_SHA.stale).toBe(true);

  const fresh = view({ DJIMITFLO_COMMIT_SHA: BUILD.slice(0, 12), DJIMITFLO_BUILD_COMMIT: BUILD });
  expect(fresh.by.DJIMITFLO_COMMIT_SHA.stale).toBe(false);

  // no baked build commit: the env value proves nothing, stale is unknown rather than false
  const unknown = view({ DJIMITFLO_COMMIT_SHA: 'a'.repeat(40), DJIMITFLO_BUILD_COMMIT: 'unknown' });
  expect(unknown.build.built_commit).toBeNull();
  expect(unknown.by.DJIMITFLO_COMMIT_SHA.stale).toBeNull();
});
