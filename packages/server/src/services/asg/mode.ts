/**
 * ASG-001 (docs/research/asg-001/PREREG.md): Adaptive Skill Granularity for the oracle-lane maker.
 *   ASG_MODE=off|shadow|on (default off). off = no ASG code path runs at all (byte-identical maker; asg-mode-off.test.ts).
 *   shadow = the route decision and the observed effects are recorded on the maker lease; nothing changes.
 *   on = additionally the end state is verified after a bounded runtime failure (exception ≠ incomplete) on runtimes whose
 *        effects are bounded to the worktree. Real runtimes have no macro adapter, so their route is always MICRO.
 * `on` refuses to act while an experiment on the oracle-goal population is on (it would change those arms): it then runs as
 * shadow and records `blocked_by`.
 */
export type AsgMode = 'off' | 'shadow' | 'on';

export function asgMode(env: NodeJS.ProcessEnv = process.env): AsgMode {
  const v = (env.ASG_MODE || '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

/** Oracle-goal population experiments (experiment-registry.ts, population 'oracle_goals') and the value that switches each on. */
export const ASG_BLOCKING_EXPERIMENTS: ReadonlyArray<readonly [string, string]> = [
  ['ACE_001_MODE', 'on'], ['STE_001_MODE', 'on'], ['MAKER_DEPS_001_MODE', 'on'], ['EFFORT_SIBLING_RANDOMISE', 'true'], ['CHECKER_FAMILY_RANDOMISE', 'on'],
];

export interface AsgEffectiveMode { requested: AsgMode; mode: AsgMode; blocked_by: string[] }

export function asgEffectiveMode(env: NodeJS.ProcessEnv = process.env): AsgEffectiveMode {
  const requested = asgMode(env);
  const blocked_by = requested === 'on' ? ASG_BLOCKING_EXPERIMENTS.filter(([k, on]) => env[k] === on).map(([k]) => k) : [];
  return { requested, mode: requested === 'on' && blocked_by.length ? 'shadow' : requested, blocked_by };
}
