import type { Database } from 'better-sqlite3';
import { forecastScores } from './forecast-scoring';

/**
 * RX-1 (Phase F, operator 2026-10-04): one read-only snapshot of the evolution loop's evidence — the flags that steer it,
 * outcomes per signal source, loop draft PRs and their settlement, genomes and holdouts, gym difficulty per tier, and the
 * four Realm Gates. Every query is fail-soft (missing table → empty/null) and every gate states why it is not green.
 * Aggregates only: no prompts, diffs, tokens or hosts.
 */
export const EVOLUTION_FLAGS: Array<{ name: string; acting: boolean }> = [
  { name: 'LOOP_BANDIT_ENABLED', acting: true }, { name: 'LOOP_BANDIT_SPECIES', acting: true }, { name: 'LOOP_BANDIT_MAX_SHARE', acting: true },
  { name: 'LOOP_EVOLVE_ENABLED', acting: true }, { name: 'LOOP_EVOLVE_SPECIES', acting: true },
  { name: 'FITNESS_SHADOW_ENABLED', acting: false }, { name: 'MERGE_SURVIVAL_ENABLED', acting: false },
  { name: 'DREAM_EVOLUTION_ENABLED', acting: true }, { name: 'DREAM_TRIAL_MUTANTS', acting: true }, { name: 'DREAM_TRIAL_MUTANT_TIERS', acting: true },
  { name: 'DREAM_PROMOTION_ALPHA', acting: true }, { name: 'TRIAL_DIAGNOSTICS_ENABLED', acting: false }, { name: 'GENOME_APPLY_MODE', acting: false },
  { name: 'ARENA_GATE_ENABLED', acting: true }, { name: 'COMMITTEE_SWARM_ENABLED', acting: true }, { name: 'COMMONS_GROUNDING_APPLY', acting: true },
  { name: 'LOOP_AUTO_DRAFT_PR_ENABLED', acting: true }, { name: 'LOOP_AUTO_APPROVE_TEST_GAP', acting: true }, { name: 'ORACLE_LANES_AUTO_APPROVE', acting: true },
  { name: 'LOOP_MEMORY_RULES_ENABLED', acting: true }, { name: 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', acting: true }, { name: 'DJIMITFLO_PUBLIC_URL', acting: false },
  { name: 'GYM_TIER_PROBE_ENABLED', acting: false }, { name: 'GYM_TIER_PROBE_TIERS', acting: false }, { name: 'GYM_TIER_PROBE_EVERY', acting: false },
];

export type GateState = 'green' | 'red' | 'unknown';
export interface Gate { state: GateState; reason: string }

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
    recent: all<{ id: string; status: string; note: string | null; updated_at: string }>("SELECT id, status, note, updated_at FROM maker_genomes WHERE status IN ('active', 'retired', 'trial') AND id <> 'baseline' ORDER BY updated_at DESC LIMIT 8"),
    holdout: { mined: one('SELECT COUNT(*) FROM gym_holdout'), mutant: one('SELECT COUNT(*) FROM gym_mutant_holdout') },
  };
  const gym = all<{ kind: string; tier: number | null; status: string | null; n: number }>(`SELECT CASE WHEN json_extract(metadata, '$.gym.commit') LIKE 'mut:%' THEN 'mutant' ELSE 'mined' END AS kind,
    json_extract(metadata, '$.gym.tier') AS tier, json_extract(metadata, '$.gym_result.status') AS status, COUNT(*) AS n
    FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, since);

  // RX-4: settled trials and how much each could have shown
  const trials = {
    by_state: all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM genome_trial_results GROUP BY 1 ORDER BY 1'),
    recent: all<{ trial_id: string; parent_id: string; tier_set: string; deciding_n: number; f_parent_failures: number; b: number; c: number; p: number; power_q8_l05: number; state: string; recorded_at: string }>(
      'SELECT trial_id, parent_id, tier_set, deciding_n, f_parent_failures, b, c, p, power_q8_l05, state, recorded_at FROM genome_trial_results ORDER BY recorded_at DESC LIMIT 10'),
  };
  const latestTrial = trials.recent[0];
  const gates: Record<'A' | 'B' | 'C' | 'D', Gate> = {
    A: (() => {
      if (!latestTrial) return { state: 'unknown', reason: 'no settled trial with diagnostics yet (TRIAL_DIAGNOSTICS_ENABLED)' } as Gate;
      const pass = latestTrial.deciding_n ? (latestTrial.deciding_n - latestTrial.f_parent_failures) / latestTrial.deciding_n : null;
      const ok = pass !== null && pass >= 0.30 && pass <= 0.55;
      return { state: ok ? 'green' : 'red', reason: `latest trial ${latestTrial.trial_id}: parent passed ${latestTrial.deciding_n - latestTrial.f_parent_failures}/${latestTrial.deciding_n} deciding tasks (${latestTrial.state}); needs a pass rate in [0.30, 0.55]` } as Gate;
    })(),
    B: (() => {
      const pos = settled.filter((s) => s.survived === 1).reduce((a, s) => a + s.n, 0); const total = settled.reduce((a, s) => a + s.n, 0);
      const ok = total >= 30 && pos >= 8 && total - pos >= 8;
      return { state: ok ? 'green' : 'red', reason: `${total} settled loop PRs (${pos} survived, ${total - pos} not); needs ≥ 30 with ≥ 8 per class` } as Gate;
    })(),
    C: { state: openDrafts.length <= 5 ? 'unknown' : 'red', reason: `${openDrafts.length} loop PRs open or merged < 14 d ago (an upper bound on open drafts; target ≤ 5 open on 14 consecutive days)` },
    D: (() => {
      const fs = (() => { try { return forecastScores(db); } catch { return []; } })();
      const eligible = fs.filter((f) => f.positives >= 10 && f.n >= 100);
      return { state: eligible.length ? 'unknown' : 'red', reason: eligible.length ? `${eligible.length} forecaster(s) with ≥ 10 positives and n ≥ 100; skill CI needs V2 (RX-7)` : `no forecaster has ≥ 10 positives and n ≥ 100 (${fs.length} scored)` } as Gate;
    })(),
  };
  return { at: new Date(now).toISOString(), window_days: window, flags, outcomes, outcomes_tagged, merge, drafts, genomes, gym, trials, gates };
}
