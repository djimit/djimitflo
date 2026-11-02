import type { Database } from 'better-sqlite3';
import { ace001Evidence, aceAnalysisSince, ACE_001_STOP_BY, ACE_001_TARGET_PER_ARM } from './ace-001';
import { ste001Evidence, STE_001_TARGET_PER_ARM } from './ste-001';
import { makerDeps001Evidence, MAKER_DEPS_001_TARGET_PER_ARM } from './maker-deps-001';
import { effortX1Evidence } from './effort-controller';
import { checkerFamilyEvidence, CHECKER_FAMILY_TARGET_DEFAULT } from './checker-family';
import { tg001Evidence, TG_TASKS } from './tg-001';
import { d5NoEvidence, D5NO_ANALYSIS_N } from './d5-no';
import { jevChallengerEvidence } from './jev-challenger';
import { PL_MAX_DAYS, PL_PAIRS, PL_PROTOCOL, plFirstAttempt, plManifest, plManifestValidity, plState } from './pl-001';
import { fisherExact, memoryHoldoutEvidence } from './evolution-evidence';

/**
 * Know when to stop (SOUL.md): one read-only list of the running experiments, each with its registered target n and the
 * stop date its pre-registration (or a dated stop-condition amendment, stop_source) fixes. stop_by null = no date registered (an
 * estimate such as "≈ 45 days" is not a stop date) — that experiment could run forever, which the stall watch reports. The
 * 2026-10-19 amendments gave every experiment one: min(start + 1.25 × target ÷ slowest-arm accrual rate, start + 90 d), or
 * today + 30 d to decide extend vs close INCONCLUSIVE where accrual is ~0. status() reuses the experiment's own
 * evidence function, counting from started_at (not the evidence window), so n is the whole experiment. Nothing here
 * changes an experiment: no flag, no assignment, no prompt.
 */
/** an effect the experiment's own evidence function already computes; null fields = not computed there (never a new statistic) */
export interface ExperimentEffect { metric: string; estimate: number | null; ci: [number, number] | null; p: number | null;
  /** why the estimate is null although data exist (a protocol that forbids interim looks) */
  withheld?: string | null }
export interface ExperimentStatus { n_per_arm: Record<string, number> | null; verdict: string | null;
  /** per learning mechanism (learning-ledger.ts keys) the experiment measures */
  effects?: Record<string, ExperimentEffect> }
/** who an experiment randomises: the oracle-goal population is shared, so its concurrent experiments compete for the same goals */
export type ExperimentPopulation = 'oracle_goals' | 'gym_tasks' | 'prescreen_proposals' | 'judgments';
/** G1.5: at most this many experiments randomise on the oracle-goal population at once (Phase G, operator 2026-10-19) */
export const EXPERIMENT_WIP_LIMIT = 4;
/** accrual window for the 'power left' projection */
export const ACCRUAL_WINDOW_DAYS = 14;
export interface ExperimentDef {
  id: string; flag: string; protocol: string;
  /** when outcomes start counting (protocol / analysis_since); day precision where the protocol gives only a day */
  started_at: string;
  /** registered n per arm; null = the protocol registers none */
  target_n: number | null;
  /** the date the protocol stops at whatever n was reached; null = none registered */
  stop_by: string | null;
  stop_note: string;
  /** the document (and section) that registers stop_by and target_n */
  stop_source: string;
  population: ExperimentPopulation;
  /** G1.5: the reason this oracle-population experiment may run above EXPERIMENT_WIP_LIMIT; absent = it counts against the limit */
  approved_over_limit?: string;
  /** A18: env names (as its protocol names them; its own flag first) whose change alters this experiment's treatment or
   *  population. A change between boots writes a period boundary (recordTreatmentEnvBoundaries); analyses never pool across one */
  treatment_env?: string[];
  /** n counted from `since` (started_at for the whole experiment; later for the accrual window). A status that cannot window
   *  returns n_per_arm null for since ≠ started_at — its accrual is unknown, never 0 */
  status: (db: Database, env: NodeJS.ProcessEnv, now: number, since: string) => ExperimentStatus;
  /** an explicit operator close recorded in the protocol (dated amendment); its verdict is the experiment's verdict */
  closed?: ExperimentClose;
  /** a stop rule relative to the experiment's own data (PL-001: day 14 after the first attempt). A value replaces started_at and
   *  stop_by in the report; null (not started) keeps the registered dates */
  schedule?: (db: Database) => { started_at: string; stop_by: string } | null;
}
export interface ExperimentClose { verdict: string; decided_on: string; source: string }

const AMENDED = 'stop condition added 2026-10-19; verdict rules unchanged';
/**
 * C8 (re-20261030 A18: LOOP_BANDIT_MAX_SHARE 0.8 → 0.1 at 10-30 09:42 wrote 0 boundaries): the env names loop-daemon maker
 * selection reads — the explicit maker runtime, the species bandit (runtime-bandit.ts), the remote species (remote-maker-queue.ts)
 * and the meta tuner's maker concurrency / wall-clock (meta-orchestration-service.ts). Each changes which makers (or how many)
 * serve the shared oracle-goal population, so it is a treatment variable of every running oracle-population experiment
 * (pinned by experiment-registry.test.ts against those sources).
 */
const MAKER_SELECTION_ENV = ['LOOP_DAEMON_MAKER_RUNTIME', 'LOOP_BANDIT_ENABLED', 'LOOP_BANDIT_SPECIES', 'LOOP_BANDIT_MAX_SHARE', 'REMOTE_MAKER_ENABLED', 'META_TUNING_MIN_CONFIDENCE'];
/** TG-001 closed by the operator: INCONCLUSIVE at 20 tasks, no extension to 40 (task supply). INCONCLUSIVE from the evidence
 *  alone is not a closing verdict (the stopping rule extends once to 40); this explicit operator close is what makes it one. */
export const TG_001_CLOSED: ExperimentClose = { verdict: 'INCONCLUSIVE', decided_on: '2026-10-26',
  source: 'docs/research/ace/TG-001_PROTOCOL.md#amendment-2026-10-26-closed-inconclusive-at-20-tasks' };
/** EXP-3 (memory-holdout) read out once at its registered horizon (2026-10-27): falsifier met. Rules arm 66/88 = 0.75 vs
 *  withheld 34/42 = 0.81; CMH by lane OR 0.60, two-sided p 0.40 (not a harm finding, not evidence of no effect). Action
 *  taken: LOOP_MEMORY_RULES_ENABLED=false since 2026-10-27T05:52:42Z. A verdict the evidence function does not compute
 *  (it is a single registered readout), so this close is what records it. */
export const MEMORY_HOLDOUT_CLOSED: ExperimentClose = { verdict: 'FALSIFIED (rules not above withheld)', decided_on: '2026-10-27',
  source: 'docs/research/intelligence-metrics/EXP-3_RESULT.md#decision-under-the-registered-rules' };
const X1_STARTED = '2026-10-09T00:00:00.000Z';
/** PL-001 runner amendment (2026-10-26): registered, not started; decide start or close by PL_DECIDE_START_BY (registered + 30 d) */
const PL_REGISTERED_AT = '2026-10-26T00:00:00.000Z';
const PL_DECIDE_START_BY = '2026-11-25T00:00:00.000Z';

/** Literal dates (pinned against their source constants in experiment-registry.test.ts): X1 = start + 28 d, D5-NO = cutoff + 90 d.
 *  A function, not a constant: the imported targets are read at call time (stall-watch ↔ d5-no import cycle). */
export const experimentDefs = (): ExperimentDef[] => [
  { id: 'ACE-001', flag: 'ACE_001_MODE', protocol: 'docs/research/ace/ACE-001_PROTOCOL.md', started_at: '2026-10-12T00:00:00.000Z',
    target_n: ACE_001_TARGET_PER_ARM, stop_by: ACE_001_STOP_BY,
    stop_note: `${AMENDED}: start + 1.25 × 50 ÷ 1.87/day (slowest arm, 13 in 6.9 d)`, stop_source: 'docs/research/ace/ACE-001_PROTOCOL.md#amendment-2-2026-10-19', population: 'oracle_goals',
    treatment_env: ['ACE_001_MODE', 'LOOP_MEMORY_RULES_ENABLED', 'MEMORY_HOLDOUT_RATE', 'PROPOSAL_DEDUPE_MODE', 'LOOP_DAEMON_CHECK_SCRIPTS', ...MAKER_SELECTION_ENV],
    // ace001Evidence counts from max(since, analysis_since)
    status: (db, env, now, since) => { const e = ace001Evidence(db, since > aceAnalysisSince(env) ? since : aceAnalysisSince(env), env, now);
      const main = (m: { diff: number | null; withheld: string | null }): ExperimentEffect => ({ metric: 'verified rate, factor on − off (at the readout only)', estimate: m.diff, ci: null, p: null, withheld: m.withheld });
      return { n_per_arm: Object.fromEntries(Object.entries(e.arms).map(([a, v]) => [a, v.n])), verdict: null,
        effects: { kb_retrieval: main(e.main_effects.retrieval), example_selection: main(e.main_effects.examples) } }; } },
  { id: 'STE-001', flag: 'STE_001_MODE', protocol: 'docs/research/ace/STE-001_PROTOCOL.md', started_at: '2026-10-11T00:00:00.000Z',
    target_n: STE_001_TARGET_PER_ARM, stop_by: '2026-11-14T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 1.25 × 100 ÷ 3.78/day (slowest arm, 30 in 7.9 d)`, stop_source: 'docs/research/ace/STE-001_PROTOCOL.md#amendment-1-2026-10-19', population: 'oracle_goals',
    treatment_env: ['STE_001_MODE', 'LOOP_MEMORY_RULES_ENABLED', 'TEST_ONLY_DIFF_MAX', ...MAKER_SELECTION_ENV],
    status: (db, env, _now, since) => { const e = ste001Evidence(db, since, env);
      return { n_per_arm: { 0: e.arms['0'].n, 1: e.arms['1'].n }, verdict: null,
        effects: { maker_template: { metric: 'verified rate, STE − current template (interim, descriptive)', estimate: e.diff, ci: null, p: null } } }; } },
  { id: 'MAKER-DEPS-001', flag: 'MAKER_DEPS_001_MODE', protocol: 'docs/research/di-001/MAKER_DEPS_001_PREREG.md', started_at: '2026-10-14T00:00:00.000Z',
    target_n: MAKER_DEPS_001_TARGET_PER_ARM, stop_by: '2026-12-16T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 1.25 × 141 ÷ 2.83/day (slowest arm, 14 in 4.9 d)`, stop_source: 'docs/research/di-001/MAKER_DEPS_001_AMENDMENT_1.md#amendment-1-2026-10-19', population: 'oracle_goals',
    treatment_env: ['MAKER_DEPS_001_MODE', 'LOOP_MEMORY_RULES_ENABLED', 'LOOP_MAKER_PREPARE_DEPS', 'OPENCODE_MAX_RUN_TOKENS', ...MAKER_SELECTION_ENV],
    approved_over_limit: 'running before the G1.5 WIP limit existed (2026-10-19); finishes under its registered stop_by, no successor starts until the oracle population is ≤ 4',
    status: (db, env, _now, since) => { const e = makerDeps001Evidence(db, since, env);
      return { n_per_arm: { A: e.arms.A.terminal, B: e.arms.B.terminal }, verdict: null,
        effects: { deps_prep: { metric: 'ITT verified rate, B (deps prepared) − A; cluster-bootstrap 95 % CI (descriptive)', estimate: e.diff, ci: e.diff_ci_descriptive, p: null } } }; } },
  { id: 'X1', flag: 'EFFORT_SIBLING_RANDOMISE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-2', started_at: X1_STARTED,
    target_n: 94, stop_by: '2026-11-06T00:00:00.000Z', stop_note: 'EXP-2 registration: 4 weeks, ~94 settled per arm', stop_source: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-2', population: 'oracle_goals',
    // makers on the shared oracle-goal population: the memory-rules switch (EXPERIMENT_PROTOCOL.md amendment 2026-10-27) alters them too
    treatment_env: ['EFFORT_SIBLING_RANDOMISE', 'LOOP_MEMORY_RULES_ENABLED', ...MAKER_SELECTION_ENV],
    status: (db, env, _now, since) => { const e = effortX1Evidence(db, since, env, fisherExact);
      return { n_per_arm: { on: e.on.verified + e.on.regressed, off: e.off.verified + e.off.regressed }, verdict: null,
        effects: { effort_siblings: { metric: 'verified / settled, evolve siblings on vs off (Fisher exact; no effect size computed)', estimate: null, ci: null, p: e.fisher_p } } }; } },
  { id: 'F2', flag: 'CHECKER_FAMILY_RANDOMISE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-1', started_at: '2026-10-17T00:00:00.000Z',
    target_n: CHECKER_FAMILY_TARGET_DEFAULT, stop_by: '2027-01-15T00:00:00.000Z',
    stop_note: `${AMENDED}: start + 90 d cap (v2; 1 settled per arm in 1.9 d projects past the cap)`, stop_source: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#amendment-2026-10-19-stop-conditions', population: 'oracle_goals',
    treatment_env: ['CHECKER_FAMILY_RANDOMISE', 'CHECKER_FAMILY_VERSION', 'LOOP_MEMORY_RULES_ENABLED', ...MAKER_SELECTION_ENV],
    approved_over_limit: 'running before the G1.5 WIP limit existed (2026-10-19); finishes under its registered stop_by, no successor starts until the oracle population is ≤ 4',
    status: (db, env, now, since) => { const e = checkerFamilyEvidence(db, since, env, fisherExact, now);
      return { n_per_arm: { same: e.primary.n.same, cross: e.primary.n.cross }, verdict: e.stop.verdict === 'collecting' ? null : e.stop.verdict,
        effects: { checker_family: { metric: `Δkappa cross − same on ${e.primary.endpoint} (${e.primary.read}); seeded bootstrap 95 % CI`,
          estimate: e.primary.delta_kappa, ci: e.primary.delta_kappa_ci, p: e.primary.fisher_p } } }; } },
  { id: 'TG-001', flag: 'TG_001_MODE', protocol: 'docs/research/ace/TG-001_PROTOCOL.md', started_at: '2026-10-11T23:20:22.000Z',
    target_n: TG_TASKS, stop_by: '2026-11-18T00:00:00.000Z',
    stop_note: `${AMENDED}: 20-task result INCONCLUSIVE, the extension to 40 waits on task supply (accrual ~0) → today + 30 d: decide extend or close INCONCLUSIVE`,
    stop_source: 'docs/research/ace/TG-001_PROTOCOL.md#amendment-2026-10-19-stop-condition', population: 'gym_tasks', closed: TG_001_CLOSED,
    // INCONCLUSIVE at 20 tasks is not a closing verdict by itself (the stopping rule extends once to 40); the explicit operator
    // close (TG_001_CLOSED, amendment 2026-10-26) is what makes it one, so the stop date no longer applies
    status: (db, env, _now, since) => { if (since !== '2026-10-11T23:20:22.000Z') return { n_per_arm: null, verdict: TG_001_CLOSED.verdict }; // cannot window
      const e = tg001Evidence(db, env);
      const arms = 'arms' in e && Array.isArray(e.arms) ? e.arms as Array<{ arm: string; n: number }> : [];
      return { n_per_arm: arms.length ? Object.fromEntries(arms.map((a) => [a.arm, a.n])) : null, verdict: TG_001_CLOSED.verdict }; } },
  { id: 'PL-001', flag: 'PL_001_MODE', protocol: PL_PROTOCOL, started_at: PL_REGISTERED_AT,
    target_n: PL_PAIRS, stop_by: PL_DECIDE_START_BY,
    stop_note: `protocol stop rule: ${PL_PAIRS} completed pairs or day ${PL_MAX_DAYS} after the first attempt (stop_by = first attempt + ${PL_MAX_DAYS} d once one exists); before the first attempt the runner amendment registers a decide-start-or-close date; verdict rules unchanged`,
    stop_source: 'docs/research/procedure-loop/PL-001_PROTOCOL.md#amendment-2026-10-26-runner', population: 'gym_tasks',
    treatment_env: ['PL_001_MODE', 'PL_001_CAP_SHARE', 'PROCEDURE_SELECTOR_MODE', 'GYM_PROD_GATES', 'GYM_MAKER_TIMEOUT_MS', 'GENOME_APPLY_MODE', 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY'],
    schedule: (db) => { const f = plFirstAttempt(db); return f ? { started_at: f, stop_by: new Date(Date.parse(f) + PL_MAX_DAYS * 86_400_000).toISOString() } : null; },
    // n = completed pairs (both arms observed or censored), counted over the whole experiment; it cannot window
    status: (db, _env, now, since) => {
      const m = plManifest(db); const first = plFirstAttempt(db);
      if (!m || !plManifestValidity(db, m).valid) return { n_per_arm: null, verdict: null };
      const s = plState(db, m, now);
      if (since !== (first ?? PL_REGISTERED_AT)) return { n_per_arm: null, verdict: s.verdict };
      return { n_per_arm: { pairs: s.completed.length }, verdict: s.verdict }; } },
  { id: 'D5-NO', flag: 'TYPESAFE_PROPOSAL_PRESCREEN_MODE', protocol: 'docs/research/eco/D5NO_PROTOCOL.md', started_at: '2026-10-11T21:00:00.000Z',
    target_n: D5NO_ANALYSIS_N, stop_by: '2027-01-09T21:00:00.000Z', stop_note: 'cutoff + 90 days → INSUFFICIENT_EVIDENCE', stop_source: 'docs/research/eco/D5NO_PROTOCOL.md', population: 'prescreen_proposals',
    status: (db, _env, now, since) => { if (since !== '2026-10-11T21:00:00.000Z') return { n_per_arm: null, verdict: null }; // cannot window
      const e = d5NoEvidence(db, now);
      if (!('confident_no' in e) || !e.confident_no) return { n_per_arm: null, verdict: null };
      return { n_per_arm: { confident_no: e.confident_no.analysis_n_reached }, verdict: e.status === 'collecting' ? null : e.status }; } },
  { id: 'JEV-114', flag: 'JEV_CHALLENGER_MODEL', protocol: 'docs/runbooks/self-improvement-loop-operations.md', started_at: '2026-10-16T00:00:00.000Z',
    target_n: 100, stop_by: '2027-01-14T00:00:00.000Z',
    stop_note: `${AMENDED}: target 100 paired judgments with ground truth (operator default); start + 90 d cap (2 in 2.9 d projects past it)`,
    stop_source: 'docs/research/eco/JEV-114_PROTOCOL.md#amendment-1-2026-10-19', population: 'judgments',
    // one arm: the paired judgments that carry a ground-truth label (per judgment the label source with the most pairs, so a pair
    // labelled by two sources counts once), summed over judgments
    status: (db, env, _now, since) => { if (since !== '2026-10-16T00:00:00.000Z') return { n_per_arm: null, verdict: null }; // cannot window
      const pairs = jevChallengerEvidence(db, env).by_judgment.reduce((sum, j) => sum + Math.max(0,
      ...Object.values(j.ground_truth).map((t) => (t ? t.primary.n + (t.abstained?.primary ?? 0) : 0))), 0);
      return { n_per_arm: { with_ground_truth: pairs }, verdict: null }; } },
  { id: 'memory-holdout', flag: 'MEMORY_HOLDOUT_RATE', protocol: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#exp-3', started_at: '2026-10-08T00:00:00.000Z',
    target_n: 30, stop_by: '2026-10-27T00:00:00.000Z',
    stop_note: `${AMENDED}: target 30 outcomes per arm (operator default); start + 1.25 × 30 ÷ 2.01/day (holdout arm, 22 in 10.9 d)`,
    stop_source: 'docs/research/intelligence-metrics/EXPERIMENT_PROTOCOL.md#amendment-2026-10-19-stop-conditions', population: 'oracle_goals',
    closed: MEMORY_HOLDOUT_CLOSED,
    status: (db, env, _now, since) => { const e = memoryHoldoutEvidence(db, since, env);
      return { n_per_arm: { rules: e.rules.n, holdout: e.holdout.n }, verdict: MEMORY_HOLDOUT_CLOSED.verdict,
        effects: { memory_rules: { metric: 'verified / settled, rules vs held out (Fisher exact; no effect size computed)', estimate: null, ci: null, p: e.fisher_p } } }; } },
];

/** G1.5 'power left': n so far vs target per arm, days to stop_by and the n each arm reaches by then at its last-14-day accrual.
 *  null = unknown (no stop date, no target, a status that cannot window, or < 1 day of accrual) — never 0 */
export interface ExperimentPower {
  n_so_far: number | null; target_per_arm: number | null; days_to_stop: number | null;
  accrual_window_days: number | null; accrual_per_day: Record<string, number> | null;
  projected_min_arm_n: number | null; projected_reaches_target: boolean | null;
}
export interface ExperimentRow extends Omit<ExperimentDef, 'status' | 'schedule'> {
  n_per_arm: Record<string, number> | null; min_arm_n: number | null; verdict: string | null; effects?: Record<string, ExperimentEffect>;
  /** past stop_by, or every arm at the target, and no verdict recorded */
  overdue: boolean; overdue_reason: string | null; power: ExperimentPower; error?: string;
  /** A18: treatment-env changes recorded at boot since the registry started watching; the periods are never pooled silently */
  period_boundaries: Array<{ at: string; env: string; from: string | null; to: string | null }>;
}

export interface PeriodBoundary { experiment_id: string; env_name: string; previous: string | null; current: string | null; at: string }
const ENV_SNAPSHOT_KEY = 'experiment_treatment_env';
/**
 * A18 (re-20261029): at boot, compare the values of every declared treatment_env name with the previous boot's snapshot
 * (system_state). Each changed name writes one period-boundary row per experiment that declares it. A process's env is fixed
 * for its life, so this boot is the boundary instant. A name missing from the previous snapshot (first boot, newly declared)
 * is a baseline, not a change. Values are flag settings, capped at 200 characters.
 */
export function recordTreatmentEnvBoundaries(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), defs: ExperimentDef[] = experimentDefs()): PeriodBoundary[] {
  const names = [...new Set(defs.flatMap((d) => d.treatment_env ?? []))];
  const current: Record<string, string | null> = Object.fromEntries(names.map((n) => [n, env[n] === undefined ? null : String(env[n]).slice(0, 200)]));
  let previous: Record<string, string | null> | null = null;
  try { const r = db.prepare('SELECT value FROM system_state WHERE key = ?').get(ENV_SNAPSHOT_KEY) as { value: string } | undefined; previous = r ? JSON.parse(r.value) : null; } catch { /* unreadable: a baseline */ }
  const at = new Date(now).toISOString();
  const rows: PeriodBoundary[] = !previous ? [] : defs.flatMap((d) => (d.treatment_env ?? [])
    .filter((n) => n in previous! && previous![n] !== current[n])
    .map((n) => ({ experiment_id: d.id, env_name: n, previous: previous![n], current: current[n], at })));
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO experiment_period_boundaries (experiment_id, env_name, previous, current, at) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.experiment_id, r.env_name, r.previous, r.current, r.at);
    db.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(ENV_SNAPSHOT_KEY, JSON.stringify(current), at);
  })();
  return rows;
}

const DAY = 86_400_000;
function powerLeft(d: Omit<ExperimentDef, 'status'>, n: Record<string, number> | null, recent: Record<string, number> | null, windowDays: number, now: number): ExperimentPower {
  const ns = n ? Object.values(n) : [];
  const n_so_far = ns.length ? Math.min(...ns) : null;
  const days_to_stop = d.stop_by === null ? null : +((Date.parse(d.stop_by) - now) / DAY).toFixed(1);
  const rates = recent && n && windowDays >= 1 ? Object.fromEntries(Object.entries(recent).map(([a, k]) => [a, +(k / windowDays).toFixed(3)])) : null;
  const projected = rates && n && days_to_stop !== null
    ? Math.floor(Math.min(...Object.keys(n).map((a) => n[a] + (rates[a] ?? 0) * Math.max(0, days_to_stop)))) : null;
  return { n_so_far, target_per_arm: d.target_n, days_to_stop, accrual_window_days: rates ? +windowDays.toFixed(1) : null, accrual_per_day: rates,
    projected_min_arm_n: projected, projected_reaches_target: projected === null || d.target_n === null ? null : projected >= d.target_n };
}

/** G1.5 CI guard (static, over the registered definitions): oracle-population experiments that count against the limit.
 *  An approved_over_limit reason shorter than 20 characters is no reason. */
export function wipCheck(defs: Array<Pick<ExperimentDef, 'id' | 'population' | 'approved_over_limit'>>, limit = EXPERIMENT_WIP_LIMIT) {
  const oracle = defs.filter((d) => d.population === 'oracle_goals');
  const approved = oracle.filter((d) => (d.approved_over_limit ?? '').trim().length >= 20);
  const counted = oracle.filter((d) => !approved.includes(d)).map((d) => d.id);
  return { limit, oracle_population: oracle.map((d) => d.id), counted, approved_over_limit: approved.map((d) => ({ id: d.id, reason: d.approved_over_limit as string })),
    ok: counted.length <= limit };
}

export function experimentsReport(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), defs: ExperimentDef[] = experimentDefs()) {
  let boundaries: PeriodBoundary[] = [];
  try { boundaries = db.prepare('SELECT experiment_id, env_name, previous, current, at FROM experiment_period_boundaries ORDER BY at, env_name').all() as PeriodBoundary[]; } catch { /* no table yet */ }
  const experiments: ExperimentRow[] = defs.map(({ status, schedule, ...registered }) => {
    let d = registered;
    try { const at = schedule?.(db); if (at) d = { ...registered, ...at }; } catch { /* unreadable: the registered dates stand */ }
    let s: ExperimentStatus = { n_per_arm: null, verdict: null }; let error: string | undefined;
    try { s = status(db, env, now, d.started_at); } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 200); }
    const recentSince = new Date(Math.max(Date.parse(d.started_at), now - ACCRUAL_WINDOW_DAYS * DAY)).toISOString();
    let recent: Record<string, number> | null = null;
    // started < 14 d ago: the window is the whole experiment, the same n
    if (!error) try { recent = recentSince === d.started_at ? s.n_per_arm : status(db, env, now, recentSince).n_per_arm; } catch { /* unknown accrual */ }
    const ns = s.n_per_arm ? Object.values(s.n_per_arm) : [];
    const min_arm_n = ns.length ? Math.min(...ns) : null;
    const past = d.stop_by !== null && now > Date.parse(d.stop_by);
    const reached = d.target_n !== null && min_arm_n !== null && min_arm_n >= d.target_n;
    const overdue = s.verdict === null && (past || reached);
    const overdue_reason = !overdue ? null : past ? `past stop_by ${d.stop_by} without a verdict (n per arm ${JSON.stringify(s.n_per_arm)})`
      : `every arm reached target ${d.target_n} without a verdict`;
    const power = powerLeft(d, s.n_per_arm, recent, (now - Date.parse(recentSince)) / DAY, now);
    const period_boundaries = boundaries.filter((b) => b.experiment_id === d.id).map((b) => ({ at: b.at, env: b.env_name, from: b.previous, to: b.current }));
    return { ...d, ...s, min_arm_n, overdue, overdue_reason, power, period_boundaries, ...(error ? { error } : {}) };
  });
  // G1.5 (report-only): active = registered and no verdict yet; over_wip_limit counts every active oracle-population experiment,
  // guard_ok (the CI guard) only those without an approved_over_limit reason
  const active = experiments.filter((e) => e.population === 'oracle_goals' && e.verdict === null);
  const guard = wipCheck(active);
  const wip = { population: 'oracle_goals' as const, limit: EXPERIMENT_WIP_LIMIT, active: active.map((e) => e.id), active_count: active.length,
    over_wip_limit: active.length > EXPERIMENT_WIP_LIMIT, counted: guard.counted, approved_over_limit: guard.approved_over_limit, guard_ok: guard.ok };
  return { experiments, overdue: experiments.filter((e) => e.overdue).map((e) => e.id), no_stop_date: experiments.filter((e) => e.stop_by === null).map((e) => e.id), wip,
    note: 'Report-only. stop_by = the date the pre-registration stops at (null = none registered); overdue = past stop_by or every arm at target_n with no verdict. n counts from started_at. power: projected n per arm at stop_by from the last-14-day accrual (null = unknown). wip: G1.5 limit of concurrent experiments on the oracle-goal population; a new one starts only when one reads out.' };
}
