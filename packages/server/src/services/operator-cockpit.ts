import fs from 'fs';
import type { Database } from 'better-sqlite3';
import { detectStalls, type Stall } from './stall-watch';

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
  gym: Array<{ species: string; outcomes: number; successes: number; success_pct: number; avg_seconds: number; avg_tokens: number; last: string }>;
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
    tokens_per_outcome_7d: one('SELECT ROUND(AVG(tokens_used)) FROM skill_outcomes WHERE created_at >= ?', d7),
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
    `SELECT replace(skill_id, 'loop-maker:gym:', '') AS species, COUNT(*) AS outcomes, SUM(success) AS successes, ROUND(AVG(duration_ms) / 1000) AS avg_seconds,
       ROUND(AVG(tokens_used)) AS avg_tokens, MAX(created_at) AS last FROM skill_outcomes WHERE domain = 'gym' GROUP BY skill_id ORDER BY outcomes DESC`)
    .map((g) => ({ ...g, success_pct: g.outcomes ? Math.round((100 * g.successes) / g.outcomes) : 0 }));
  const remote_workers = all<{ host: string; claims_24h: number; last_claim: string | null; interrupted_24h: number }>(
    `SELECT json_extract(metadata, '$.gym.remote_host') AS host, SUM(created_at >= ?) AS claims_24h, MAX(created_at) AS last_claim,
       SUM(created_at >= ? AND status = 'interrupted') AS interrupted_24h FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL GROUP BY host`, d1, d1);
  const maker_usage_7d = all<{ role: string; runtime: string; model: string | null; leases: number; tokens: number }>(
    `SELECT role, runtime, json_extract(metadata, '$.model') AS model, COUNT(*) AS leases, COALESCE(SUM(json_extract(metadata, '$.runtime_usage.total_tokens')), 0) AS tokens
       FROM worker_leases WHERE created_at >= ? AND runtime != 'manual' GROUP BY role, runtime, model ORDER BY tokens DESC`, d7);
  const judgments_7d = all<{ judgment: string; calls: number; errors: number; input_tokens: number }>(
    `SELECT judgment, COUNT(*) AS calls, SUM(decision = 'error') AS errors, COALESCE(SUM(input_tokens), 0) AS input_tokens FROM judgments WHERE created_at >= ? GROUP BY judgment ORDER BY calls DESC`, d7);
  let stalls: Stall[] = [];
  try { stalls = detectStalls(db, now); } catch { /* stall watch is advisory */ }
  return {
    at: new Date(now).toISOString(),
    build: { commit: process.env.DJIMITFLO_BUILD_COMMIT ?? null, build_time: process.env.DJIMITFLO_BUILD_TIME ?? null },
    scorecard, guardrails, stalls, gym, remote_workers, maker_usage_7d, judgments_7d, deploys: recentDeploys(),
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
