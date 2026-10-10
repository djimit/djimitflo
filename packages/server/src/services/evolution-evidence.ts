import type { Database } from 'better-sqlite3';
import { failureTaskEvidence } from './gym-failure-tasks';
import { forecastScoresV2 } from './forecast-scoring';
import { parseRuntimeSpec } from './social-runtime-providers';
import { modelEvidence } from './model-selector';
import { commonsYield, oracleAgreement } from './honest-numbers';
import { banditOpe } from './bandit-propensity';
import { egressEvidence } from './egress-classification';
import { embeddingDimMismatch, vectorStrictDim } from './embedding-dims';
import { autoMergeEvidence } from './loop-auto-merge-state';
import { nonMakerRunSql } from './outcome-attribution';
import { effortX1Evidence } from './effort-controller';
import { gradedEvidence } from './graded-fitness';
import { wilson } from './evolution-estimators';
import { intelligenceEvidence } from './intelligence-metrics';
import type { ForecasterScoreV2 } from './forecast-scoring';
import { BASELINE_GENOME, holdoutEpoch } from './genome-registry';

/**
 * RX-1 (Phase F, operator 2026-10-04): one read-only snapshot of the evolution loop's evidence — the flags that steer it,
 * outcomes per signal source, loop draft PRs and their settlement, genomes and holdouts, gym difficulty per tier, and the
 * four Realm Gates. Every query is fail-soft (missing table → empty/null) and every gate states why it is not green.
 * Aggregates only: no prompts, diffs, tokens or hosts.
 */
export const EVOLUTION_FLAGS: Array<{ name: string; acting: boolean }> = [
  { name: 'LOOP_BANDIT_ENABLED', acting: true }, { name: 'LOOP_BANDIT_SPECIES', acting: true }, { name: 'LOOP_BANDIT_MAX_SHARE', acting: true },
  { name: 'LOOP_EVOLVE_ENABLED', acting: true }, { name: 'LOOP_EVOLVE_SPECIES', acting: true },
  { name: 'FITNESS_SHADOW_ENABLED', acting: false }, { name: 'MERGE_SURVIVAL_ENABLED', acting: false }, { name: 'MERGE_SURVIVAL_V2', acting: false }, { name: 'LOOP_EVIDENCE_FRESHNESS_MODE', acting: true },
  { name: 'DREAM_EVOLUTION_ENABLED', acting: true }, { name: 'DREAM_TRIAL_MUTANTS', acting: true }, { name: 'DREAM_TRIAL_MUTANT_TIERS', acting: true },
  { name: 'DREAM_PROMOTION_ALPHA', acting: true }, { name: 'TRIAL_DIAGNOSTICS_ENABLED', acting: false }, { name: 'TRIAL_HEADROOM_PRECHECK', acting: true }, { name: 'DREAM_PROMOTION_RULE', acting: false }, { name: 'DREAM_TRIAL_WRITE_TEST_HOLDOUT', acting: true }, { name: 'DREAM_EVIDENCE_MUTATIONS', acting: true }, { name: 'GYM_HOLDOUT_EPOCH', acting: true }, { name: 'GENOME_APPLY_MODE', acting: false },
  { name: 'ARENA_GATE_ENABLED', acting: true }, { name: 'DISCOVERY_RELEVANCE_SOURCES', acting: true }, { name: 'COMMITTEE_SWARM_ENABLED', acting: true }, { name: 'COMMONS_GROUNDING_APPLY', acting: true }, { name: 'SOCIAL_AUTOPILOT_FORECAST_ONLY', acting: true },
  { name: 'LOOP_AUTO_DRAFT_PR_ENABLED', acting: true }, { name: 'LOOP_AUTO_MERGE_TEST_ONLY', acting: true }, { name: 'LOOP_AUTO_MERGE_MAX_PER_DAY', acting: true }, { name: 'LOOP_AUTO_APPROVE_TEST_GAP', acting: true }, { name: 'ORACLE_LANES_AUTO_APPROVE', acting: true },
  { name: 'LOOP_MEMORY_RULES_ENABLED', acting: true }, { name: 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', acting: true }, { name: 'DJIMITFLO_PUBLIC_URL', acting: false },
  { name: 'GYM_TIER_PROBE_ENABLED', acting: false }, { name: 'GYM_TIER_PROBE_TIERS', acting: false }, { name: 'GYM_TIER_PROBE_EVERY', acting: false },
  { name: 'HACK_DETECTOR_MODE', acting: false }, { name: 'GYM_CANARY_RATE', acting: false }, { name: 'GYM_FAILURE_TASKS_ENABLED', acting: false },
  { name: 'MODEL_SELECTOR_MODE', acting: true }, { name: 'EVOLUTION_ESTIMATORS_ENABLED', acting: false }, { name: 'GYM_IRT_SELECTION', acting: true },
  { name: 'DEPENDENCY_LANE_MODE', acting: true }, { name: 'DEPENDENCY_LANE_MAX_PER_DAY', acting: true },
  { name: 'DEAD_CODE_LANE_ENABLED', acting: true }, { name: 'DEAD_CODE_MAX_PER_DAY', acting: true },
  { name: 'GYM_PROD_GATES', acting: false },
  { name: 'GENOME_FIRE_CHECK', acting: true }, { name: 'MEMORY_HOLDOUT_RATE', acting: true },
  { name: 'TYPESAFE_PROPOSAL_PRESCREEN_MODE', acting: true },
  { name: 'RESOURCE_LEDGER_ENABLED', acting: false },
  { name: 'OUTCOME_ATTRIBUTION_ENABLED', acting: true },
  { name: 'EFFORT_CONTROLLER_MODE', acting: false }, { name: 'EFFORT_LAMBDA_TOK', acting: false }, { name: 'EFFORT_LAMBDA_KWH', acting: false }, { name: 'EFFORT_EXPLORATION', acting: false },
  { name: 'EFFORT_SIBLING_RANDOMISE', acting: true },
  { name: 'GRADED_FITNESS_MODE', acting: false }, { name: 'GRADED_CONTEST_MODE', acting: true },
  { name: 'SHIPPED_CODE_SCAN_MODE', acting: false },
  { name: 'GYM_STORE_DIFFS', acting: false }, { name: 'WEAK_ASSERTION_CHECK_MODE', acting: true },
  { name: 'POLICY_VIOLATION_LOG', acting: false },
];

/** Two-sided Fisher exact test on [[a, b], [c, d]]: the summed probability of every table with the same margins that is no more likely than this one. */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const lf = (n: number): number => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const r1 = a + b; const r2 = c + d; const c1 = a + c; const n = r1 + r2;
  if (!n) return 1;
  const logP = (x: number) => lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x);
  const observed = logP(a); let p = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const lp = logP(x); if (lp <= observed + 1e-7) p += Math.exp(lp); }
  return Math.min(1, p);
}

/**
 * S7 (operator 09-10): RX-11 hack-detector flags per maker genome (gym.genome — the `genome:` ref on the gym outcome;
 * 'none' = no trial genome) and per gym task kind over the last 14 days, plus canary outcomes. scored = success/failure;
 * checked = scored with gym_result.hack_flags present (HACK_DETECTOR_MODE=shadow was on); flagged = ≥ 1 flag. A canary
 * that passes means the oracle or sandbox is compromised. Rates with a Wilson 95 % interval; 'insufficient' below n = 10.
 */
export function hackRateEvidence(db: Database, env: NodeJS.ProcessEnv, now: number) {
  const since = new Date(now - 14 * 86_400_000).toISOString();
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all(since) as T[]; } catch { return []; } };
  const rate = (k: number, n: number) => (n < 10 ? { rate: null, ci: null, status: 'insufficient' as const } : { rate: +(k / n).toFixed(4), ci: wilson(k, n), status: 'ok' as const });
  const counts = `COALESCE(SUM(json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')), 0) AS scored,
      COALESCE(SUM(json_extract(metadata, '$.gym_result.status') IN ('success', 'failure') AND json_type(metadata, '$.gym_result.hack_flags') = 'array'), 0) AS checked,
      COALESCE(SUM(json_extract(metadata, '$.gym_result.status') IN ('success', 'failure') AND json_array_length(json_extract(metadata, '$.gym_result.hack_flags')) > 0), 0) AS flagged
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ?`;
  type Row = { scored: number; checked: number; flagged: number };
  const by_genome = all<Row & { genome: string }>(`SELECT COALESCE(json_extract(metadata, '$.gym.genome'), 'none') AS genome, ${counts}
      AND json_extract(metadata, '$.gym.canary') IS NULL GROUP BY 1 HAVING scored > 0 ORDER BY 1`).map((r) => ({ ...r, ...rate(r.flagged, r.checked) }));
  const by_kind = all<Row & { kind: string }>(`SELECT CASE WHEN json_extract(metadata, '$.gym.canary') = 1 THEN 'canary' WHEN json_extract(metadata, '$.gym.probe') = 1 THEN 'probe'
      WHEN json_extract(metadata, '$.gym.kind') = 'write_test' THEN 'write_test' WHEN json_extract(metadata, '$.gym.commit') LIKE 'mut:%' THEN 'mutant' ELSE 'mined' END AS kind, ${counts}
      GROUP BY 1 HAVING scored > 0 ORDER BY 1`).map((r) => ({ ...r, ...rate(r.flagged, r.checked) }));
  const c = all<{ served: number; scored: number; passed: number }>(`SELECT COUNT(*) AS served,
      COALESCE(SUM(json_extract(metadata, '$.gym_result.status') IN ('success', 'failure')), 0) AS scored,
      COALESCE(SUM(json_extract(metadata, '$.gym_result.status') = 'success'), 0) AS passed
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') = 1 AND created_at >= ?`)[0] ?? { served: 0, scored: 0, passed: 0 };
  return { window_days: 14, mode: env.HACK_DETECTOR_MODE ?? null, canary_rate: env.GYM_CANARY_RATE ?? null, by_genome, by_kind,
    canary: { served: c.served, scored: c.scored, passed: c.passed, ...rate(c.passed, c.scored), compromised: c.passed > 0 },
    note: 'rate = flagged / checked (hack detector ran: HACK_DETECTOR_MODE=shadow); canary rate = passed / scored — any passed canary means a compromised oracle or sandbox. Wilson 95 %; insufficient below n = 10.' };
}

export type GateState = 'green' | 'red' | 'unknown';
export interface Gate { state: GateState; reason: string }

/**
 * §16 step 7 (§16.11: never optimise against a repeatedly exposed locked holdout). Per frozen holdout epoch: how many distinct
 * candidate genomes it has been used for — ran a completed, non-canary gym attempt on one of its tasks, or had a trial decided
 * on it (genome_trial_results; tier_set 'mined' = the mined holdout, else the mutant holdout) — plus the decisions and
 * evaluations behind that. The parent (baseline) is not a candidate. `reuse_risk` once candidates exceed the contract limit
 * (METRIC_CONTRACTS.yaml VIG holdout_reuse_limit): introduce a fresh epoch (GYM_HOLDOUT_EPOCH, an operator action). Read-only:
 * nothing here rotates an epoch.
 */
export const HOLDOUT_REUSE_LIMIT = 10;
export function holdoutExposure(db: Database, env: NodeJS.ProcessEnv = process.env, limit = HOLDOUT_REUSE_LIMIT) {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const tables = [['mined', 'gym_holdout', 'commit_sha'], ['mutant', 'gym_mutant_holdout', 'key'], ['write_test', 'gym_write_test_holdout', 'key']] as const;
  const epochs = tables.flatMap(([holdout, table, key]) => {
    const frozen = all<{ epoch: number; tasks: number; frozen_at: string }>(`SELECT epoch, COUNT(*) AS tasks, MIN(created_at) AS frozen_at FROM ${table} GROUP BY epoch ORDER BY epoch`);
    if (!frozen.length) return [];
    const runs = all<{ epoch: number; genome: string | null; n: number }>(`SELECT h.epoch, json_extract(r.metadata, '$.gym.genome') AS genome, COUNT(*) AS n
      FROM loop_runs r JOIN ${table} h ON h.${key} = json_extract(r.metadata, '$.gym.commit')
      WHERE r.loop_name = 'evolution-gym' AND r.status = 'completed' AND json_extract(r.metadata, '$.gym.canary') IS NULL GROUP BY 1, 2`);
    const decided = holdout === 'write_test' ? [] : all<{ epoch: number; trial_id: string }>(
      `SELECT COALESCE(epoch, 0) AS epoch, trial_id FROM genome_trial_results WHERE tier_set IS NOT NULL AND (tier_set = 'mined') = ?`, holdout === 'mined' ? 1 : 0);
    const current = (() => { try { return holdoutEpoch(db, table, env); } catch { return null; } })();
    return frozen.map((f) => {
      const ran = runs.filter((r) => r.epoch === f.epoch);
      const dec = decided.filter((d) => d.epoch === f.epoch);
      const candidates = new Set([...ran.map((r) => r.genome).filter((g): g is string => Boolean(g) && g !== BASELINE_GENOME), ...dec.map((d) => d.trial_id)]).size;
      return { holdout, epoch: f.epoch, tasks: f.tasks, frozen_at: f.frozen_at, current: f.epoch === current, candidates, decisions: dec.length,
        evaluations: ran.reduce((a, r) => a + r.n, 0), reuse_risk: candidates > limit };
    });
  });
  return { limit, epochs, reuse_risk: epochs.some((e) => e.current && e.reuse_risk), write_test_enabled: env.DREAM_TRIAL_WRITE_TEST_HOLDOUT === 'true',
    note: `candidates = distinct genomes (parent excluded) that ran on or were decided on the epoch; reuse_risk above ${limit} (contract) — introduce a fresh epoch (GYM_HOLDOUT_EPOCH, operator). Read-only.` };
}

/** MS-2: the expert runner's model from FRONTIER_EXPERTS_RUNTIME ('ollama:kimi-k3:cloud' → 'kimi-k3:cloud'), parsed like the runner does. */
const frontierIncumbent = (runtime?: string): string | undefined => (runtime || '').trim() ? parseRuntimeSpec(runtime, { runtime: 'ollama', model: '' }).model : undefined;

export function buildEvolutionEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now(), days = 30) {
  const window = Math.min(90, Math.max(1, Math.floor(days) || 30));
  const since = new Date(now - window * 86_400_000).toISOString();
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const one = (sql: string, ...args: unknown[]): number | null => {
    try { const r = db.prepare(sql).get(...args) as Record<string, unknown> | undefined; const v = r ? Object.values(r)[0] : null; return v == null ? null : Number(v); } catch { return null; }
  };

  const flags = EVOLUTION_FLAGS.map((f) => ({ ...f, value: env[f.name] ?? null }));
  // skill id up to its third segment (loop-maker:<lane>:<runtime>, agent:<name>:<kind>) — the selection key
  const outcomes = all<{ domain: string; skill: string; n: number; ok: number }>(`SELECT domain, substr(skill_id, 1, CASE WHEN instr(substr(skill_id, instr(skill_id, ':') + 1), ':') > 0
      THEN instr(skill_id, ':') + instr(substr(skill_id, instr(skill_id, ':') + 1), ':') - 1 ELSE length(skill_id) END) AS skill,
    COUNT(*) AS n, SUM(success) AS ok FROM skill_outcomes WHERE created_at >= ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 60`, since);

  // RX-3: production maker outcomes whose zero is not the species' fault (infra, no change, eligible evolve loser)
  const outcomes_tagged = all<{ skill: string; total: number; failures: number; tagged: number }>(`SELECT skill_id AS skill, COUNT(*) AS total,
    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
    SUM(CASE WHEN success = 0 AND (evidence_refs_json LIKE '%"outcome_class:infra_failed"%' OR evidence_refs_json LIKE '%"outcome_class:no_change"%'
      OR evidence_refs_json LIKE '%"evolve:lost_eligible"%') THEN 1 ELSE 0 END) AS tagged
    FROM skill_outcomes WHERE skill_id LIKE 'loop-maker:%' AND domain NOT IN ('gym', 'merge') AND created_at >= ? GROUP BY 1 ORDER BY total DESC LIMIT 30`, since)
    .map((r) => ({ ...r, share: r.total ? +(r.tagged / r.total).toFixed(3) : 0 }));
  const settled = all<{ state: string; survived: number | null; n: number }>(`SELECT json_extract(metadata, '$.pr_outcome.state') AS state,
    json_extract(metadata, '$.pr_outcome.survived') AS survived, COUNT(*) AS n FROM loop_runs
    WHERE json_extract(metadata, '$.pr_outcome.settled_at') IS NOT NULL GROUP BY 1, 2`);
  const openDrafts = all<{ created_at: string }>(`SELECT created_at FROM loop_runs WHERE json_extract(metadata, '$.pr_url') IS NOT NULL
    AND json_extract(metadata, '$.pr_outcome.settled_at') IS NULL ORDER BY created_at`);
  const ages = openDrafts.map((r) => (now - Date.parse(r.created_at)) / 86_400_000).sort((a, b) => a - b);
  const q = (p: number) => (ages.length ? +ages[Math.min(ages.length - 1, Math.floor(p * ages.length))].toFixed(1) : null);
  const merge = { settled, merge_outcomes: one("SELECT COUNT(*) FROM skill_outcomes WHERE domain = 'merge'"), first_settled: all<{ at: string }>("SELECT MIN(created_at) AS at FROM skill_outcomes WHERE domain = 'merge'")[0]?.at ?? null };
  const drafts = { unsettled: openDrafts.length, unsettled_open_or_recent: openDrafts.length, age_days_p50: q(0.5), age_days_max: ages.length ? +ages[ages.length - 1].toFixed(1) : null,
    note: 'unsettled_open_or_recent = PR url without a merge-survival settlement: still open, or merged < 14 d ago. Only GitHub knows which; the open count is the draft throttle\'s (RX-6, draft_pr_throttle* events)' };

  const genomes = {
    by_status: all<{ status: string; origin: string; n: number }>('SELECT status, origin, COUNT(*) AS n FROM maker_genomes GROUP BY 1, 2'),
    recent: all<{ id: string; status: string; note: string | null; updated_at: string; evidence_clusters: string | null }>("SELECT id, status, note, updated_at, evidence_clusters FROM maker_genomes WHERE status IN ('active', 'retired', 'trial') AND id <> 'baseline' ORDER BY updated_at DESC LIMIT 8"),
    holdout: { mined: one('SELECT COUNT(*) FROM gym_holdout'), mutant: one('SELECT COUNT(*) FROM gym_mutant_holdout'), write_test: one('SELECT COUNT(*) FROM gym_write_test_holdout') },
  };
  const gym = all<{ kind: string; tier: number | null; status: string | null; n: number }>(`SELECT CASE WHEN json_extract(metadata, '$.gym.commit') LIKE 'mut:%' THEN 'mutant' ELSE 'mined' END AS kind,
    json_extract(metadata, '$.gym.tier') AS tier, json_extract(metadata, '$.gym_result.status') AS status, COUNT(*) AS n
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') IS NULL AND created_at >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, since);
  // gym gold agreement (GYM_PROD_GATES): on runs claimed with the production gates, how often the gym's own oracle said
  // success (proxy) vs how often the production checks + lane diff limit agreed. A gated run carries gym_result.prod_gates
  // exactly when its proxy oracle succeeded (the worker runs the gates only then).
  const gateRuns = `FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.prod_gates') = 1
    AND json_extract(metadata, '$.gym.canary') IS NULL AND json_extract(metadata, '$.gym_result.status') IN ('success', 'failure') AND created_at >= ?`;
  const gym_prod_gates = {
    by_kind: all<{ kind: string; scored: number; proxy_success: number; prod_gate_success: number }>(`SELECT CASE WHEN json_extract(metadata, '$.gym.kind') = 'write_test' THEN 'write_test'
        WHEN json_extract(metadata, '$.gym.commit') LIKE 'mut:%' THEN 'mutant' ELSE 'mined' END AS kind, COUNT(*) AS scored,
        SUM(json_extract(metadata, '$.gym_result.status') = 'success' OR json_extract(metadata, '$.gym_result.prod_gates') IS NOT NULL) AS proxy_success,
        SUM(json_extract(metadata, '$.gym_result.status') = 'success' AND json_extract(metadata, '$.gym_result.prod_gates') IS NOT NULL) AS prod_gate_success
      ${gateRuns} GROUP BY 1 ORDER BY 1`, since)
      .map((r) => ({ ...r, proxy_rate: r.scored ? +(r.proxy_success / r.scored).toFixed(3) : null, prod_gate_rate: r.scored ? +(r.prod_gate_success / r.scored).toFixed(3) : null })),
    failed_checks: all<{ check: string; n: number }>(`SELECT g.key AS "check", COUNT(*) AS n FROM loop_runs r, json_each(json_extract(r.metadata, '$.gym_result.prod_gates')) g
      WHERE r.loop_name = 'evolution-gym' AND json_extract(r.metadata, '$.gym.prod_gates') = 1 AND g.value = 'fail' AND r.created_at >= ? GROUP BY 1 ORDER BY n DESC, 1`, since),
  };
  // GYM_STORE_DIFFS: stored (task, redacted diff, oracle result) pairs — all time, the training corpus is cumulative
  const diffRow = all<{ stored: number; distinct_tasks: number; successes: number | null; failures: number | null; redacted_attempts: number | null }>(`SELECT COUNT(*) AS stored,
    COUNT(DISTINCT task_key) AS distinct_tasks, SUM(status = 'success') AS successes, SUM(status = 'failure') AS failures, SUM(redacted > 0) AS redacted_attempts FROM gym_attempt_diffs`)[0];
  const gym_diffs = { enabled: env.GYM_STORE_DIFFS === 'true', stored: diffRow?.stored ?? 0, distinct_tasks: diffRow?.distinct_tasks ?? 0,
    successes: diffRow?.successes ?? 0, failures: diffRow?.failures ?? 0, redacted_attempts: diffRow?.redacted_attempts ?? 0 };
  // RX-11: shadow hack flags per species (from gym_result.hack_flags) and canary outcomes (a solved canary = compromised oracle)
  const hacks = {
    flags: all<{ species: string; flag: string; n: number }>(`SELECT json_extract(r.metadata, '$.gym.species') AS species, f.value AS flag, COUNT(*) AS n
      FROM loop_runs r, json_each(json_extract(r.metadata, '$.gym_result.hack_flags')) f
      WHERE r.loop_name = 'evolution-gym' AND r.created_at >= ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 50`, since),
    flagged_runs: one(`SELECT COUNT(*) FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_array_length(json_extract(metadata, '$.gym_result.hack_flags')) > 0`, since),
    canaries: all<{ status: string | null; n: number }>(`SELECT json_extract(metadata, '$.gym_result.status') AS status, COUNT(*) AS n FROM loop_runs
      WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') = 1 AND created_at >= ? GROUP BY 1`, since),
  };

  // GENOME_FIRE_CHECK: trial attempts voided because the genome's lines never reached the maker (never paired)
  const voided = all<{ genome: string; n: number }>(`SELECT json_extract(metadata, '$.gym.genome') AS genome, COUNT(*) AS n FROM loop_runs
    WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym_result.void') IS NOT NULL AND created_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 20`, since);
  const fire_checked = one(`SELECT COUNT(*) FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym_result.fire_check') IS NOT NULL AND created_at >= ?`, since);
  // RX-4: settled trials and how much each could have shown
  const trials = {
    void: { attempts: voided.reduce((a, r) => a + r.n, 0), by_genome: voided, fire_checked },
    by_state: all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM genome_trial_results GROUP BY 1 ORDER BY 1'),
    // RX-12: a holdout is consumable — settled trials per epoch (rotate after ~6); RX-13: e-process shadow decisions
    // SI-C: graded decisions per epoch (acted on only under DREAM_PROMOTION_RULE=graded)
    by_epoch: all<{ epoch: number | null; n: number; e_promote: number; graded_promote: number }>(
      "SELECT epoch, COUNT(*) AS n, SUM(e_rule_decision = 'promote') AS e_promote, SUM(graded_decision = 'promote') AS graded_promote FROM genome_trial_results GROUP BY 1 ORDER BY 1"),
    recent: all<{ trial_id: string; parent_id: string; tier_set: string; deciding_n: number | null; f_parent_failures: number; b: number; c: number; p: number; power_q8_l05: number; state: string; recorded_at: string;
      graded_mean_parent: number | null; graded_mean_mutant: number | null; graded_p: number | null; graded_decision: string | null; graded_refs: number | null }>(
      `SELECT trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, power_q8_l05, state, recorded_at,
        graded_mean_parent, graded_mean_mutant, graded_p, graded_decision, graded_refs FROM genome_trial_results ORDER BY recorded_at DESC LIMIT 10`),
  };
  // Gate A reads deciding-set diagnostics; shadow-only rows (e-process, graded) carry none
  const latestTrial = trials.recent.find((t): t is typeof t & { deciding_n: number } => t.deciding_n != null);
  // RX-7: forecast scoring V2 summary (shadow): counts per state; details at GET /api/health/forecasts-v2
  let forecasters: ForecasterScoreV2[] = [];
  const forecasts_v2 = (() => {
    try {
      const f = forecasters = forecastScoresV2(db, { boot: 500 }).forecasters;
      const grade = f.filter((x) => x.state === 'decision_grade');
      return { scored: f.length, decision_grade: grade.length, decision_grade_skilled: grade.filter((x) => x.skill_ci[0] > 0).length, insufficient: f.length - grade.length };
    } catch { return { scored: 0, decision_grade: 0, decision_grade_skilled: 0, insufficient: 0 }; }
  })();
  const gates: Record<'A' | 'B' | 'C' | 'D', Gate> = {
    A: (() => {
      if (!latestTrial) return { state: 'unknown', reason: 'no settled trial with diagnostics yet (TRIAL_DIAGNOSTICS_ENABLED)' } as Gate;
      const pass = latestTrial.deciding_n ? (latestTrial.deciding_n - latestTrial.f_parent_failures) / latestTrial.deciding_n : null;
      const ok = pass !== null && pass >= 0.30 && pass <= 0.55;
      return { state: ok ? 'green' : 'red', reason: `latest trial ${latestTrial.trial_id}: parent passed ${latestTrial.deciding_n - latestTrial.f_parent_failures}/${latestTrial.deciding_n} deciding tasks (${latestTrial.state === 'no_headroom' ? 'no headroom — trial skipped before any mutant attempt' : latestTrial.state}); needs a pass rate in [0.30, 0.55]` } as Gate;
    })(),
    B: (() => {
      const pos = settled.filter((s) => s.survived === 1).reduce((a, s) => a + s.n, 0); const total = settled.reduce((a, s) => a + s.n, 0);
      const ok = total >= 30 && pos >= 8 && total - pos >= 8;
      return { state: ok ? 'green' : 'red', reason: `${total} settled loop PRs (${pos} survived, ${total - pos} not); needs ≥ 30 with ≥ 8 per class` } as Gate;
    })(),
    C: { state: openDrafts.length <= 5 ? 'unknown' : 'red', reason: `${openDrafts.length} loop PRs open or merged < 14 d ago (an upper bound on open drafts; target ≤ 5 open on 14 consecutive days)` },
    D: (() => {
      // RX-7: decision-grade needs >= 10 positives, n >= 100 and a bootstrap skill CI that excludes 0
      if (!forecasts_v2.scored) return { state: 'unknown', reason: 'no forecaster scored yet' } as Gate;
      const skilled = forecasts_v2.decision_grade_skilled;
      return { state: skilled ? 'green' : 'red', reason: `${forecasts_v2.decision_grade} of ${forecasts_v2.scored} forecaster(s) decision-grade (${skilled} with skill CI > 0); ${forecasts_v2.insufficient} insufficient` } as Gate;
    })(),
  };
  // MS-1: model calls per consumer (14-day selector window) and what the cost-aware selector would pick
  const frontier = frontierIncumbent(env.FRONTIER_EXPERTS_RUNTIME);
  const models = modelEvidence(db, { panel_review: env.SELF_IMPROVEMENT_REVIEW_MODEL, ...(frontier ? { frontier_experts: frontier } : {}) }, env, now);
  // RX-9 / RX-8: honest agreement and yield numbers (one row per maker; attempted Commons children vs source base rate)
  const oracle = oracleAgreement(db);
  const commons = commonsYield(db);
  // RX-14: the last 14 days of the nightly thermometer, one trend per estimator × scope
  const estRows = all<{ estimator: string; scope: string; day: string; value: number | null; ci_low: number | null; ci_high: number | null; n: number; status: string }>(
    `SELECT estimator, scope, as_of_day AS day, value, ci_low, ci_high, n, status FROM evolution_estimates WHERE as_of_day >= ? ORDER BY estimator, scope, as_of_day`,
    new Date(now - 13 * 86_400_000).toISOString().slice(0, 10));
  const estimates: Array<{ estimator: string; scope: string; days: Array<{ day: string; value: number | null; ci_low: number | null; ci_high: number | null; n: number; status: string }> }> = [];
  for (const r of estRows) {
    let t = estimates[estimates.length - 1];
    if (!t || t.estimator !== r.estimator || t.scope !== r.scope) { t = { estimator: r.estimator, scope: r.scope, days: [] }; estimates.push(t); }
    t.days.push({ day: r.day, value: r.value, ci_low: r.ci_low, ci_high: r.ci_high, n: r.n, status: r.status });
  }
  // RX-15: report-only off-policy value of the fitness-view policy vs the logged bandit
  const ope = (() => { try { return banditOpe(db, env); } catch { return null; } })();
  // Batch-8: loop PRs whose read set (configs, lockfile, imports) changed on main between the checks and the PR
  const freshness = {
    by_state: all<{ state: string; n: number }>(`SELECT json_extract(metadata, '$.evidence_freshness.state') AS state, COUNT(*) AS n FROM loop_runs
      WHERE json_extract(metadata, '$.evidence_freshness.state') IS NOT NULL AND created_at >= ? GROUP BY 1`, since),
    stale_events: one("SELECT COUNT(*) FROM loop_events WHERE event_type IN ('evidence_stale', 'evidence_stale_shadow') AND created_at >= ?", since),
  };
  // MEMORY_HOLDOUT_RATE: proposal outcome (verified / regressed) of maker runs that got rules vs runs held out (read-only)
  const arms = all<{ arm: string; status: string; n: number }>(`SELECT CASE WHEN json_extract(e.metadata, '$.memory_holdout') = 1 THEN 'holdout' ELSE 'rules' END AS arm,
      s.status AS status, COUNT(DISTINCT e.loop_run_id) AS n
    FROM loop_events e JOIN loop_runs r ON r.id = e.loop_run_id JOIN goals g ON g.id = r.goal_id JOIN self_improvements s ON s.id = g.improvement_id
    WHERE e.event_type = 'assignment_context' AND e.created_at >= ? AND s.status IN ('verified', 'regressed')
      AND (json_extract(e.metadata, '$.memory_holdout') = 1 OR json_array_length(json_extract(e.metadata, '$.rule_ids')) > 0)
      AND NOT (s.status = 'regressed' AND ${nonMakerRunSql('e.loop_run_id', env)})
    GROUP BY 1, 2`, since);
  const arm = (name: string) => {
    const verified = arms.filter((r) => r.arm === name && r.status === 'verified').reduce((a, r) => a + r.n, 0);
    const regressed = arms.filter((r) => r.arm === name && r.status === 'regressed').reduce((a, r) => a + r.n, 0);
    return { n: verified + regressed, verified, regressed, verified_rate: verified + regressed ? +(verified / (verified + regressed)).toFixed(3) : null };
  };
  const withRules = arm('rules'); const heldOut = arm('holdout');
  const memory_holdout = { rate: env.MEMORY_HOLDOUT_RATE ?? null, rules: withRules, holdout: heldOut,
    fisher_p: +fisherExact(withRules.verified, withRules.regressed, heldOut.verified, heldOut.regressed).toPrecision(4),
    note: 'runs with a settled proposal (verified or regressed); rules = ≥ 1 rule in the assignment, holdout = rules withheld by MEMORY_HOLDOUT_RATE. Two-sided Fisher exact.' };
  const effort_x1 = effortX1Evidence(db, since, env, fisherExact);
  const holdout_exposure = holdoutExposure(db, env);
  return { at: new Date(now).toISOString(), window_days: window, flags, outcomes, outcomes_tagged, merge, drafts, genomes, gym, gym_prod_gates, gym_diffs, trials, models, oracle, commons, forecasts_v2, hacks,
    // S7: hack-detector flag rate per genome and gym task kind (14 d) and canary passes, Wilson 95 %
    hack_rate: hackRateEvidence(db, env, now), estimates, ope,
    // UX-20: where model calls send data (shadow report; nothing is blocked)
    egress: egressEvidence(db, env, now),
    // UX-21: vectors compared across dimensions since boot, per store (resampled by default; skipped under VECTOR_STRICT_DIM)
    // Batch-8: gym tasks from real production failures (git lookups skipped here; 'available' is computed at claim time)
    failure_tasks: failureTaskEvidence(db, null, env),
    embedding_dim_mismatch: { strict: vectorStrictDim(env), by_store: embeddingDimMismatch() }, freshness,
    // earned auto-merge: mode, class state (active / revoked + why) and counts
    auto_merge: autoMergeEvidence(db, env, now), memory_holdout,
    // X1 (EFFORT_SIBLING_RANDOMISE): verified / regressed / infra per sibling arm
    effort_x1,
    // SI-A/SI-B: graded executed fitness per pool (n, mean, share at 1.0) and graded-contest agreement with the current rule
    graded: gradedEvidence(db, since, env),
    // KE-3: does knowledge reach evolution? Mutant genomes written from injected knowledge units, and proposals citing a
    // unit or claim (evidence ref `expert_unit:<id>` / `expert_claim:<id>`; no proposal path cites knowledge yet)
    knowledge_links: {
      genomes_with_refs: one("SELECT COUNT(*) FROM maker_genomes WHERE knowledge_refs_json IS NOT NULL AND knowledge_refs_json <> '[]'"),
      genomes_total: one("SELECT COUNT(*) FROM maker_genomes WHERE origin = 'dream'"),
      proposals_with_refs: one(`SELECT COUNT(*) FROM self_improvements WHERE evidence_refs_json LIKE '%"expert_unit:%' OR evidence_refs_json LIKE '%"expert_claim:%'`),
    },
    // §16 step 7: per frozen holdout epoch, distinct candidates run or decided on it; reuse_risk above the contract limit (read-only)
    holdout_exposure,
    // §16 step 1: one read-only status per metric contract (METRIC_CONTRACTS.yaml); INSUFFICIENT_EVIDENCE is never rendered as 0
    intelligence: intelligenceEvidence(db, env, now, since, { forecasters, effort_x1, memory_holdout,
      holdout_reuse_risk: holdout_exposure.epochs.filter((e) => e.current && e.reuse_risk).map((e) => ({ holdout: e.holdout, epoch: e.epoch, candidates: e.candidates })) }), gates };
}
