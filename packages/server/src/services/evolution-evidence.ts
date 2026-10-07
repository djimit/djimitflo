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
  { name: 'DREAM_PROMOTION_ALPHA', acting: true }, { name: 'TRIAL_DIAGNOSTICS_ENABLED', acting: false }, { name: 'TRIAL_HEADROOM_PRECHECK', acting: true }, { name: 'DREAM_PROMOTION_RULE', acting: false }, { name: 'DREAM_EVIDENCE_MUTATIONS', acting: true }, { name: 'GYM_HOLDOUT_EPOCH', acting: true }, { name: 'GENOME_APPLY_MODE', acting: false },
  { name: 'ARENA_GATE_ENABLED', acting: true }, { name: 'COMMITTEE_SWARM_ENABLED', acting: true }, { name: 'COMMONS_GROUNDING_APPLY', acting: true }, { name: 'SOCIAL_AUTOPILOT_FORECAST_ONLY', acting: true },
  { name: 'LOOP_AUTO_DRAFT_PR_ENABLED', acting: true }, { name: 'LOOP_AUTO_MERGE_TEST_ONLY', acting: true }, { name: 'LOOP_AUTO_MERGE_MAX_PER_DAY', acting: true }, { name: 'LOOP_AUTO_APPROVE_TEST_GAP', acting: true }, { name: 'ORACLE_LANES_AUTO_APPROVE', acting: true },
  { name: 'LOOP_MEMORY_RULES_ENABLED', acting: true }, { name: 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', acting: true }, { name: 'DJIMITFLO_PUBLIC_URL', acting: false },
  { name: 'GYM_TIER_PROBE_ENABLED', acting: false }, { name: 'GYM_TIER_PROBE_TIERS', acting: false }, { name: 'GYM_TIER_PROBE_EVERY', acting: false },
  { name: 'HACK_DETECTOR_MODE', acting: false }, { name: 'GYM_CANARY_RATE', acting: false }, { name: 'GYM_FAILURE_TASKS_ENABLED', acting: false },
  { name: 'MODEL_SELECTOR_MODE', acting: true }, { name: 'EVOLUTION_ESTIMATORS_ENABLED', acting: false }, { name: 'GYM_IRT_SELECTION', acting: true },
  { name: 'DEPENDENCY_LANE_MODE', acting: true }, { name: 'DEPENDENCY_LANE_MAX_PER_DAY', acting: true },
  { name: 'DEAD_CODE_LANE_ENABLED', acting: true }, { name: 'DEAD_CODE_MAX_PER_DAY', acting: true },
];

export type GateState = 'green' | 'red' | 'unknown';
export interface Gate { state: GateState; reason: string }

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
    holdout: { mined: one('SELECT COUNT(*) FROM gym_holdout'), mutant: one('SELECT COUNT(*) FROM gym_mutant_holdout') },
  };
  const gym = all<{ kind: string; tier: number | null; status: string | null; n: number }>(`SELECT CASE WHEN json_extract(metadata, '$.gym.commit') LIKE 'mut:%' THEN 'mutant' ELSE 'mined' END AS kind,
    json_extract(metadata, '$.gym.tier') AS tier, json_extract(metadata, '$.gym_result.status') AS status, COUNT(*) AS n
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') IS NULL AND created_at >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, since);
  // RX-11: shadow hack flags per species (from gym_result.hack_flags) and canary outcomes (a solved canary = compromised oracle)
  const hacks = {
    flags: all<{ species: string; flag: string; n: number }>(`SELECT json_extract(r.metadata, '$.gym.species') AS species, f.value AS flag, COUNT(*) AS n
      FROM loop_runs r, json_each(json_extract(r.metadata, '$.gym_result.hack_flags')) f
      WHERE r.loop_name = 'evolution-gym' AND r.created_at >= ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 50`, since),
    flagged_runs: one(`SELECT COUNT(*) FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_array_length(json_extract(metadata, '$.gym_result.hack_flags')) > 0`, since),
    canaries: all<{ status: string | null; n: number }>(`SELECT json_extract(metadata, '$.gym_result.status') AS status, COUNT(*) AS n FROM loop_runs
      WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') = 1 AND created_at >= ? GROUP BY 1`, since),
  };

  // RX-4: settled trials and how much each could have shown
  const trials = {
    by_state: all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM genome_trial_results GROUP BY 1 ORDER BY 1'),
    // RX-12: a holdout is consumable — settled trials per epoch (rotate after ~6); RX-13: e-process shadow decisions
    by_epoch: all<{ epoch: number | null; n: number; e_promote: number }>("SELECT epoch, COUNT(*) AS n, SUM(e_rule_decision = 'promote') AS e_promote FROM genome_trial_results GROUP BY 1 ORDER BY 1"),
    recent: all<{ trial_id: string; parent_id: string; tier_set: string; deciding_n: number; f_parent_failures: number; b: number; c: number; p: number; power_q8_l05: number; state: string; recorded_at: string }>(
      'SELECT trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, power_q8_l05, state, recorded_at FROM genome_trial_results ORDER BY recorded_at DESC LIMIT 10'),
  };
  const latestTrial = trials.recent[0];
  // RX-7: forecast scoring V2 summary (shadow): counts per state; details at GET /api/health/forecasts-v2
  const forecasts_v2 = (() => {
    try {
      const f = forecastScoresV2(db, { boot: 500 }).forecasters;
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
  return { at: new Date(now).toISOString(), window_days: window, flags, outcomes, outcomes_tagged, merge, drafts, genomes, gym, trials, models, oracle, commons, forecasts_v2, hacks, estimates, ope,
    // UX-20: where model calls send data (shadow report; nothing is blocked)
    egress: egressEvidence(db, env, now),
    // UX-21: vectors compared across dimensions since boot, per store (resampled by default; skipped under VECTOR_STRICT_DIM)
    // Batch-8: gym tasks from real production failures (git lookups skipped here; 'available' is computed at claim time)
    failure_tasks: failureTaskEvidence(db, null, env),
    embedding_dim_mismatch: { strict: vectorStrictDim(env), by_store: embeddingDimMismatch() }, freshness,
    // earned auto-merge: mode, class state (active / revoked + why) and counts
    auto_merge: autoMergeEvidence(db, env, now), gates };
}
