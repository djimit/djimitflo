import fs from 'fs';
import type { Database } from 'better-sqlite3';
import { detectStalls, type Stall } from './stall-watch';
import { infraFailing } from './evolution-gym-service';
import { decisionsInbox, openDecisionCounts } from './decisions-inbox';
import { listSchedulers } from './scheduler-registry';
import { countOpenLoopPrs, listDraftPrs } from './loop-draft-pr-service';

/**
 * S1 (operator 2026-09-28): one read-only snapshot of what the operator otherwise measures by hand over SSH —
 * scorecard + guardrails (plan §3), stalls, gym species (D6), remote workers, model/judgment usage. Every query is
 * fail-soft (a missing table yields null), so the cockpit never breaks on an older or partial schema.
 */
export interface Guardrail { name: string; ok: boolean; value: number | null; limit: string }
export interface CockpitSnapshot {
  at: string;
  build: { commit: string | null; build_time: string | null };
  scorecard: Record<string, number | null>;
  guardrails: Guardrail[];
  stalls: Stall[];
  /** stale: no outcome for 72 h — the species is not running, whatever its success rate says (sorted after the active ones) */
  gym: Array<{ species: string; outcomes: number; successes: number; success_pct: number; avg_seconds: number; avg_tokens: number; last: string; benched: boolean; stale: boolean }>;
  /** W3: what waits for the operator right now (the /decisions sections). */
  needs_you: { approvals: number; requeue: number; labels: number; memory_review: number;
    /** UX-6: every other thing that can block the loop on the operator */
    /** open loop draft PRs wait for a human merge or close; draft_prs (unsettled) also holds merged PRs still settling */
    proposals: number; draft_prs: number; open_prs: number; stalls: number; approvals_expiring: number; join_requests: number; shell_requests: number };
  /** UX-8: schedulers armed at boot vs off */
  schedulers: { armed: number; off: number };
  /** Y2: maker outcomes per strategy genome and maker skill (30 d) — what Y3's dreaming mutates and the bandit selects.
   *  scope: 'gym' for loop-maker:gym:* (benchmark makers), 'production' for makers on real goals — never mixed in one table. */
  genomes: Array<{ genome: string; skill_id: string; scope: 'gym' | 'production'; outcomes: number; wins: number; win_pct: number }>;
  remote_workers: Array<{ host: string; claims_24h: number; last_claim: string | null; interrupted_24h: number }>;
  maker_usage_7d: Array<{ role: string; runtime: string; model: string | null; leases: number; tokens: number }>;
  judgments_7d: Array<{ judgment: string; calls: number; errors: number; input_tokens: number }>;
  deploys: Array<{ at: string; event: string; sha: string; detail: string }>;
}

export function operatorCockpit(db: Database, now = Date.now()): CockpitSnapshot {
  const d7 = new Date(now - 7 * 86_400_000).toISOString(); const d1 = new Date(now - 86_400_000).toISOString();
  const one = (sql: string, ...args: unknown[]): number | null => {
    try { const r = db.prepare(sql).get(...args) as Record<string, unknown> | undefined; const v = r ? Object.values(r)[0] : null; return v === null || v === undefined ? null : Number(v); } catch { return null; }
  };
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const scorecard = {
    verified_7d: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'verified' AND updated_at >= ?", d7),
    regressed_7d: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'regressed' AND updated_at >= ?", d7),
    infra_failed_7d: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'infra_failed' AND updated_at >= ?", d7),
    approvals_decided_7d: one("SELECT COUNT(*) FROM approvals WHERE status IN ('approved', 'denied') AND updated_at >= ?", d7),
    approvals_expired_7d: one("SELECT COUNT(*) FROM approvals WHERE status = 'expired' AND updated_at >= ?", d7),
    approvals_pending: one("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"),
    runs_failed_7d: one("SELECT COUNT(*) FROM loop_runs WHERE status IN ('failed', 'interrupted') AND created_at >= ?", d7),
    panel_unparseable_7d: one("SELECT COUNT(*) FROM specialist_reviews WHERE findings_json LIKE '%could not be parsed%' AND created_at >= ?", d7),
    reflection_inflow_24h: one("SELECT COUNT(*) FROM self_improvements WHERE source = 'reflection' AND created_at >= ?", d1),
    needs_grounding_stock: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'needs_grounding'"),
    needs_more_evidence_stock: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'needs_more_evidence'"),
    memory_reads_7d: one('SELECT COUNT(*) FROM memory_access_log WHERE accessed_at >= ?', d7),
    // was 'tokens per outcome' = AVG over every skill outcome incl. zero-token gym outcomes (prod 08-10: 64 576, ~37× too low).
    // Now: everything the maker + reviewer leases spent in the window over the proposals verified in it (prod ≈ 62.8 M / 26).
    tokens_per_verified_change_7d: one(`SELECT ROUND(COALESCE(SUM(json_extract(metadata, '$.runtime_usage.total_tokens')), 0) * 1.0
        / NULLIF((SELECT COUNT(*) FROM self_improvements WHERE status = 'verified' AND updated_at >= ?), 0))
      FROM worker_leases WHERE role IN ('maker', 'checker', 'security_checker') AND created_at >= ?`, d7, d7),
  };
  const v = scorecard.verified_7d ?? 0;
  // plan §3 guardrails
  const guardrails: Guardrail[] = [
    { name: 'regressions', value: scorecard.regressed_7d, limit: `<= verified/5 (${(v / 5).toFixed(1)})`, ok: (scorecard.regressed_7d ?? 0) <= v / 5 },
    { name: 'panel unparseable (7 d)', value: scorecard.panel_unparseable_7d, limit: '0', ok: (scorecard.panel_unparseable_7d ?? 0) === 0 },
    { name: 'reflection inflow (24 h)', value: scorecard.reflection_inflow_24h, limit: '<= 25', ok: (scorecard.reflection_inflow_24h ?? 0) <= 25 },
    { name: 'approvals expired (7 d)', value: scorecard.approvals_expired_7d, limit: 'not rising', ok: (scorecard.approvals_expired_7d ?? 0) <= (scorecard.approvals_decided_7d ?? 0) / 5 },
  ];
  const gym = all<{ species: string; outcomes: number; successes: number; avg_seconds: number; avg_tokens: number; last: string }>(
    // per runtime@model (prod 2026-09-30: atomic@llama-router and atomic@qwen36-2060 were merged into one 'atomic' row)
    `SELECT replace(skill_id, 'loop-maker:gym:', '') || COALESCE('@' || model, '') AS species, COUNT(*) AS outcomes, SUM(success) AS successes,
       ROUND(AVG(duration_ms) / 1000) AS avg_seconds, ROUND(AVG(tokens_used)) AS avg_tokens, MAX(created_at) AS last
       FROM skill_outcomes WHERE domain = 'gym' GROUP BY skill_id, model ORDER BY outcomes DESC`)
    .map((g) => {
      const stale = !(Date.parse(g.last) >= now - 72 * 3_600_000); // prod 08-10: species silent for days still read 'active'
      // the circuit breaker's own verdict: a benched species takes no gym work (prod 2026-09-30: benched for hours, unseen)
      let benched = false;
      try { benched = infraFailing(db, g.species, d1); } catch { /* loop_runs absent */ }
      return { ...g, success_pct: g.outcomes ? Math.round((100 * g.successes) / g.outcomes) : 0, benched, stale };
    })
    .sort((a, b) => Number(a.stale) - Number(b.stale)); // stable: active first, each group still by outcomes
  const remote_workers = all<{ host: string; claims_24h: number; last_claim: string | null; interrupted_24h: number }>(
    `SELECT json_extract(metadata, '$.gym.remote_host') AS host, SUM(created_at >= ?) AS claims_24h, MAX(created_at) AS last_claim,
       SUM(created_at >= ? AND status = 'interrupted') AS interrupted_24h FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL GROUP BY host`, d1, d1);
  const maker_usage_7d = all<{ role: string; runtime: string; model: string | null; leases: number; tokens: number }>(
    `SELECT role, runtime, json_extract(metadata, '$.model') AS model, COUNT(*) AS leases, COALESCE(SUM(json_extract(metadata, '$.runtime_usage.total_tokens')), 0) AS tokens
       FROM worker_leases WHERE created_at >= ? AND runtime != 'manual' GROUP BY role, runtime, model ORDER BY tokens DESC`, d7);
  const judgments_7d = all<{ judgment: string; calls: number; errors: number; input_tokens: number }>(
    `SELECT judgment, COUNT(*) AS calls, SUM(decision = 'error') AS errors, COALESCE(SUM(input_tokens), 0) AS input_tokens FROM judgments WHERE created_at >= ? GROUP BY judgment ORDER BY calls DESC`, d7);
  const d30 = new Date(now - 30 * 86_400_000).toISOString();
  // prod 08-10: the 'real makers' table was mostly gym makers (loop-maker:gym:*); each scope now gets its own top 20
  const genomesIn = (scope: 'gym' | 'production') => all<{ genome: string; skill_id: string; outcomes: number; wins: number }>(
    `SELECT substr(r.value, 8) AS genome, s.skill_id, COUNT(*) AS outcomes, SUM(s.success) AS wins
       FROM skill_outcomes s, json_each(s.evidence_refs_json) r
      WHERE r.value LIKE 'genome:%' AND s.created_at >= ? AND (s.skill_id LIKE 'loop-maker:gym:%') = ? GROUP BY 1, 2 ORDER BY outcomes DESC LIMIT 20`, d30, scope === 'gym' ? 1 : 0)
    .map((g) => ({ ...g, scope, win_pct: g.outcomes ? Math.round((100 * g.wins) / g.outcomes) : 0 }));
  const genomes = [...genomesIn('production'), ...genomesIn('gym')];
  const in60 = new Date(now + 3_600_000).toISOString();
  let needs_you: CockpitSnapshot['needs_you'] = { approvals: scorecard.approvals_pending ?? 0, requeue: 0, labels: 0, memory_review: 0,
    proposals: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'proposed'") ?? 0,
    draft_prs: (() => { try { return listDraftPrs(db, 100, now).unsettled; } catch { return 0; } })(),
    open_prs: countOpenLoopPrs(db),
    stalls: 0,
    approvals_expiring: one("SELECT COUNT(*) FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?", in60) ?? 0,
    join_requests: one("SELECT COUNT(*) FROM social_join_requests WHERE status = 'pending'") ?? 0,
    shell_requests: one("SELECT COUNT(*) FROM fleet_commands WHERE status = 'pending_approval'") ?? 0 };
  try {
    const inbox = decisionsInbox(db, now);
    needs_you = { ...needs_you, ...openDecisionCounts(inbox) };
  } catch { /* inbox tables absent */ }
  let stalls: Stall[] = [];
  try { stalls = detectStalls(db, now); } catch { /* stall watch is advisory */ }
  needs_you.stalls = stalls.length;
  const { armed, off } = listSchedulers();
  return {
    at: new Date(now).toISOString(),
    build: { commit: process.env.DJIMITFLO_BUILD_COMMIT ?? null, build_time: process.env.DJIMITFLO_BUILD_TIME ?? null },
    scorecard, guardrails, stalls, gym, remote_workers, maker_usage_7d, judgments_7d, needs_you, schedulers: { armed, off }, genomes, deploys: recentDeploys(),
  };
}

/** Last deploy events written by the host's auto-deploy.sh into the mounted data dir (newest first). */
export function recentDeploys(file = process.env.DEPLOY_LOG_PATH || '/data/deploy-log.jsonl', limit = 12): CockpitSnapshot['deploys'] {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-limit).reverse()
      .map((line) => { try { return JSON.parse(line) as CockpitSnapshot['deploys'][number]; } catch { return null; } })
      .filter((e): e is CockpitSnapshot['deploys'][number] => Boolean(e?.event));
  } catch { return []; }
}
