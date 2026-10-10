import fs from 'fs';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { detectStalls, type Stall } from './stall-watch';
import { infraFailing } from './evolution-gym-service';
import { ATTRIBUTION_OF_PROPOSAL, decisionsInbox, openDecisionCounts } from './decisions-inbox';
import { listSchedulers } from './scheduler-registry';
import { nonMakerRunSql, outcomeAttributionEnabled } from './outcome-attribution';

/**
 * S1 (operator 2026-09-28): one read-only snapshot of what the operator otherwise measures by hand over SSH —
 * scorecard + guardrails (plan §3), stalls, gym species (D6), remote workers, model/judgment usage. Every query is
 * fail-soft (a missing table yields null), so the cockpit never breaks on an older or partial schema.
 * Cockpit 3.0: fail-soft is not fail-green — a failed query is null + an `errors` entry, and a guardrail without its
 * inputs is UNKNOWN, never ok.
 */
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'BREACHED' | 'UNKNOWN' | 'STALE' | 'NOT_APPLICABLE';
/** worst first; `health` is the worst state of the guardrails (plus DEGRADED for a partial snapshot or an open stall) */
const SEVERITY: HealthState[] = ['BREACHED', 'UNKNOWN', 'STALE', 'DEGRADED', 'HEALTHY', 'NOT_APPLICABLE'];
export const worstState = (states: HealthState[]): HealthState =>
  states.reduce<HealthState>((w, x) => (SEVERITY.indexOf(x) < SEVERITY.indexOf(w) ? x : w), 'NOT_APPLICABLE');
/**
 * split: regressions by attributed class — with OUTCOME_ATTRIBUTION_ENABLED the guardrail counts maker only.
 * unknown = no outcome_attribution judgment (was silently 'maker'). ok = state === 'HEALTHY' (kept for older clients).
 */
export interface Guardrail { name: string; ok: boolean; state: HealthState; value: number | null; limit: string; split?: { maker: number; reviewer: number; environment: number; unknown: number } }
export interface CockpitSnapshot {
  at: string;
  /** one id per snapshot; every section is read in this one synchronous pass, so `at` is each section's observation time */
  snapshot_id: string;
  health: HealthState;
  /** sections whose query failed (missing table, SQL error) — their values are null/empty, not zero */
  errors: Array<{ section: string; message: string }>;
  build: { commit: string | null; build_time: string | null };
  scorecard: Record<string, number | null>;
  guardrails: Guardrail[];
  stalls: Stall[];
  /** stale: no outcome for 72 h — the species is not running, whatever its success rate says (sorted after the active ones) */
  gym: Array<{ species: string; outcomes: number; successes: number; success_pct: number; avg_seconds: number; avg_tokens: number; last: string; benched: boolean; stale: boolean }>;
  /** W3: what waits for the operator right now (the /decisions sections). */
  /** null = that count could not be read (see errors) — never shown as 'nothing waiting' */
  needs_you: { approvals: number | null; requeue: number | null; labels: number | null; memory_review: number | null;
    /** UX-6: every other thing that can block the loop on the operator */
    /** open loop draft PRs wait for a human merge or close; draft_prs (unsettled) also holds merged PRs still settling */
    proposals: number | null; draft_prs: number | null; open_prs: number | null; stalls: number | null; approvals_expiring: number | null;
    join_requests: number | null; shell_requests: number | null;
    /** proposals listed in two sections (operator requeue + unlabelled pre-screen) — subtracted once from total */
    shared_subjects: number | null;
    /** distinct things waiting: blocking counts (not approvals_expiring ⊂ approvals, not draft_prs) minus shared_subjects; null if any is unknown */
    total: number | null;
    /** requeue candidates that are system work, not decisions (counted, never hidden) */
    system_requeue: Partial<Record<'budgeted_requeue' | 'attribution_unknown' | 'not_actionable', number>> | null };
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

export function operatorCockpit(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): CockpitSnapshot {
  const d7 = new Date(now - 7 * 86_400_000).toISOString(); const d1 = new Date(now - 86_400_000).toISOString();
  const errors: CockpitSnapshot['errors'] = [];
  const fail = (section: string, e: unknown) => { errors.push({ section, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) }); };
  let section = 'scorecard';
  const one = (sql: string, ...args: unknown[]): number | null => {
    try { const r = db.prepare(sql).get(...args) as Record<string, unknown> | undefined; const v = r ? Object.values(r)[0] : null; return v === null || v === undefined ? null : Number(v); } catch (e) { fail(section, e); return null; }
  };
  const all = <T>(sql: string, ...args: unknown[]): T[] | null => { try { return db.prepare(sql).all(...args) as T[]; } catch (e) { fail(section, e); return null; } };
  const scorecard = {
    verified_7d: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'verified' AND updated_at >= ?", d7),
    regressed_7d: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'regressed' AND updated_at >= ?", d7),
    infra_failed_7d: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'infra_failed' AND updated_at >= ?", d7),
    approvals_decided_7d: one("SELECT COUNT(*) FROM approvals WHERE status IN ('approved', 'denied') AND updated_at >= ?", d7),
    approvals_expired_7d: one("SELECT COUNT(*) FROM approvals WHERE status = 'expired' AND updated_at >= ?", d7),
    approvals_pending: one("SELECT COUNT(*) FROM approvals WHERE status = 'pending'"),
    runs_failed_7d: one("SELECT COUNT(*) FROM loop_runs WHERE status IN ('failed', 'interrupted') AND created_at >= ?", d7),
    panel_unparseable_7d: one("SELECT COUNT(*) FROM specialist_reviews WHERE findings_json LIKE '%could not be parsed%' AND created_at >= ?", d7),
    // spend_per_verified_change_7d: tokens of every maker/checker/security lease CREATED in 7 d (all lanes, all outcomes)
    // over proposals VERIFIED (settled) in 7 d = what a verified change costs including the failures around it.
    // tokens_per_verified_change_7d is the same number under its old name (kept for older clients).
    // direct_tokens_per_verified_change_7d: tokens of the leases of the verified proposals' own runs over the same verified count.
    spend_per_verified_change_7d: null as number | null,
    direct_tokens_per_verified_change_7d: one(`SELECT ROUND(COALESCE(SUM(json_extract(l.metadata, '$.runtime_usage.total_tokens')), 0) * 1.0 / NULLIF(COUNT(DISTINCT s.id), 0))
      FROM self_improvements s JOIN goals g ON g.improvement_id = s.id JOIN loop_runs r ON r.goal_id = g.id
      LEFT JOIN worker_leases l ON l.loop_run_id = r.id AND l.role IN ('maker', 'checker', 'security_checker')
      WHERE s.status = 'verified' AND s.updated_at >= ?`, d7),
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
  scorecard.spend_per_verified_change_7d = scorecard.tokens_per_verified_change_7d;
  const v = scorecard.verified_7d;
  // funnel phase 3: each regressed proposal by its newest outcome attribution (on the proposal or any of its runs); none = unknown
  section = 'regression_split';
  const split = { maker: 0, reviewer: 0, environment: 0, unknown: 0 };
  const splitRows = all<{ cls: string | null; n: number }>(`SELECT ${ATTRIBUTION_OF_PROPOSAL} AS cls, COUNT(*) AS n
    FROM self_improvements s WHERE s.status = 'regressed' AND s.updated_at >= ? GROUP BY 1`, d7);
  for (const r of splitRows ?? []) {
    if (r.cls === 'reviewer_failure') split.reviewer += r.n; else if (r.cls === 'environment_failure') split.environment += r.n;
    else if (r.cls === 'maker_failure') split.maker += r.n; else split.unknown += r.n;
  }
  const attributed = outcomeAttributionEnabled(env);
  const regressions = attributed ? (splitRows ? split.maker : null) : scorecard.regressed_7d;
  const state = (value: number | null, bad: boolean): HealthState => (value === null ? 'UNKNOWN' : bad ? 'BREACHED' : 'HEALTHY');
  const guard = (g: Omit<Guardrail, 'ok'>): Guardrail => ({ ...g, ok: g.state === 'HEALTHY' });
  // regressions: maker-failed (attribution on) or all regressed proposals updated in 7 d, vs verified proposals updated in 7 d.
  // Unattributed regressions keep it DEGRADED under attribution: they may be maker failures nobody classified yet.
  let regState: HealthState = v === null ? 'UNKNOWN' : state(regressions, (regressions ?? 0) > v / 5);
  if (attributed && regState === 'HEALTHY' && split.unknown > 0) regState = 'DEGRADED';
  const expiredBad = (scorecard.approvals_expired_7d ?? 0) > (scorecard.approvals_decided_7d ?? 0) / 5;
  // plan §3 guardrails
  const guardrails: Guardrail[] = [
    guard({ name: 'regressions', value: regressions, state: regState, split,
      limit: `<= verified/5 (${v === null ? '?' : (v / 5).toFixed(1)})${attributed ? `, maker failures only${split.unknown ? `; ${split.unknown} unattributed` : ''}` : ''}` }),
    // specialist reviews created in 7 d whose findings could not be parsed; any is a breach
    guard({ name: 'panel unparseable (7 d)', value: scorecard.panel_unparseable_7d, limit: '0', state: state(scorecard.panel_unparseable_7d, (scorecard.panel_unparseable_7d ?? 0) > 0) }),
    // reflection-sourced proposals created in the last 24 h
    // NOT_APPLICABLE when reflection proposals are capped at 0 (Y7): 0 inflow then says nothing about health
    guard({ name: 'reflection inflow (24 h)', value: scorecard.reflection_inflow_24h, limit: '<= 25',
      state: env.REFLECTION_PROPOSALS_MAX_PER_DAY === '0' ? 'NOT_APPLICABLE' : state(scorecard.reflection_inflow_24h, (scorecard.reflection_inflow_24h ?? 0) > 25) }),
    // approvals expired in 7 d vs approved + denied in 7 d — a ratio, not a trend
    guard({ name: 'approvals expired (7 d)', value: scorecard.approvals_expired_7d, limit: '<= decided/5 (7 d)',
      state: scorecard.approvals_decided_7d === null ? 'UNKNOWN' : state(scorecard.approvals_expired_7d, expiredBad) }),
  ];
  section = 'gym';
  const gym = (all<{ species: string; outcomes: number; successes: number; avg_seconds: number; avg_tokens: number; last: string }>(
    // per runtime@model (prod 2026-09-30: atomic@llama-router and atomic@qwen36-2060 were merged into one 'atomic' row)
    `SELECT replace(skill_id, 'loop-maker:gym:', '') || COALESCE('@' || model, '') AS species, COUNT(*) AS outcomes, SUM(success) AS successes,
       ROUND(AVG(duration_ms) / 1000) AS avg_seconds, ROUND(AVG(tokens_used)) AS avg_tokens, MAX(created_at) AS last
       FROM skill_outcomes WHERE domain = 'gym' GROUP BY skill_id, model ORDER BY outcomes DESC`) ?? [])
    .map((g) => {
      const stale = !(Date.parse(g.last) >= now - 72 * 3_600_000); // prod 08-10: species silent for days still read 'active'
      // the circuit breaker's own verdict: a benched species takes no gym work (prod 2026-09-30: benched for hours, unseen)
      let benched = false;
      try { benched = infraFailing(db, g.species, d1); } catch { /* loop_runs absent */ }
      return { ...g, success_pct: g.outcomes ? Math.round((100 * g.successes) / g.outcomes) : 0, benched, stale };
    })
    .sort((a, b) => Number(a.stale) - Number(b.stale)); // stable: active first, each group still by outcomes
  section = 'remote_workers';
  const remote_workers = all<{ host: string; claims_24h: number; last_claim: string | null; interrupted_24h: number }>(
    `SELECT json_extract(metadata, '$.gym.remote_host') AS host, SUM(created_at >= ?) AS claims_24h, MAX(created_at) AS last_claim,
       SUM(created_at >= ? AND status = 'interrupted') AS interrupted_24h FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL GROUP BY host`, d1, d1) ?? [];
  section = 'usage';
  const maker_usage_7d = all<{ role: string; runtime: string; model: string | null; leases: number; tokens: number }>(
    `SELECT role, runtime, json_extract(metadata, '$.model') AS model, COUNT(*) AS leases, COALESCE(SUM(json_extract(metadata, '$.runtime_usage.total_tokens')), 0) AS tokens
       FROM worker_leases WHERE created_at >= ? AND runtime != 'manual' GROUP BY role, runtime, model ORDER BY tokens DESC`, d7) ?? [];
  const judgments_7d = all<{ judgment: string; calls: number; errors: number; input_tokens: number }>(
    `SELECT judgment, COUNT(*) AS calls, SUM(decision = 'error') AS errors, COALESCE(SUM(input_tokens), 0) AS input_tokens FROM judgments WHERE created_at >= ? GROUP BY judgment ORDER BY calls DESC`, d7) ?? [];
  const d30 = new Date(now - 30 * 86_400_000).toISOString();
  // prod 08-10: the 'real makers' table was mostly gym makers (loop-maker:gym:*); each scope now gets its own top 20
  section = 'genomes';
  const genomesIn = (scope: 'gym' | 'production') => (all<{ genome: string; skill_id: string; outcomes: number; wins: number }>(
    `SELECT substr(r.value, 8) AS genome, s.skill_id, COUNT(*) AS outcomes, SUM(s.success) AS wins
       FROM skill_outcomes s, json_each(s.evidence_refs_json) r
      WHERE r.value LIKE 'genome:%' AND s.created_at >= ? AND (s.skill_id LIKE 'loop-maker:gym:%') = ?
        AND NOT (s.success = 0 AND ${nonMakerRunSql('s.task_id', env)}) GROUP BY 1, 2 ORDER BY outcomes DESC LIMIT 20`, d30, scope === 'gym' ? 1 : 0) ?? [])
    .map((g) => ({ ...g, scope, win_pct: g.outcomes ? Math.round((100 * g.wins) / g.outcomes) : 0 }));
  const genomes = [...genomesIn('production'), ...genomesIn('gym')];
  const in60 = new Date(now + 3_600_000).toISOString();
  section = 'needs_you';
  // same predicates as loop-draft-pr-service listDraftPrs().unsettled / countOpenLoopPrs, which swallow errors as 0
  let needs_you: CockpitSnapshot['needs_you'] = { approvals: scorecard.approvals_pending, requeue: null, labels: null, memory_review: null,
    proposals: one("SELECT COUNT(*) FROM self_improvements WHERE status = 'proposed'"),
    // merged loop PRs still settling (survival not decided) — disjoint from open_prs, which counts never-polled PRs as open
    draft_prs: one("SELECT COUNT(*) FROM loop_runs WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND json_extract(metadata, '$.pr_outcome.state') = 'merged' AND json_extract(metadata, '$.pr_outcome.survived') IS NULL"),
    open_prs: one("SELECT COUNT(*) FROM loop_runs WHERE json_extract(metadata, '$.pr_url') IS NOT NULL AND COALESCE(json_extract(metadata, '$.pr_outcome.state'), 'open') = 'open'"),
    stalls: null,
    approvals_expiring: one("SELECT COUNT(*) FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?", in60),
    join_requests: one("SELECT COUNT(*) FROM social_join_requests WHERE status = 'pending'"),
    shell_requests: one("SELECT COUNT(*) FROM fleet_commands WHERE status = 'pending_approval'"),
    shared_subjects: null, total: null, system_requeue: null };
  try {
    const inbox = decisionsInbox(db, now, env);
    const counts = openDecisionCounts(inbox);
    needs_you = { ...needs_you, ...counts };
    const c = inbox.totals.requeue_classes;
    needs_you.system_requeue = c ? { budgeted_requeue: c.budgeted_requeue ?? 0, attribution_unknown: c.attribution_unknown ?? 0, not_actionable: c.not_actionable ?? 0 } : null;
    if (Object.values(counts).some((c) => c === null)) fail('decisions', new Error('a decisions inbox count query failed'));
  } catch (e) { fail('decisions', e); }
  let stalls: Stall[] = [];
  // an empty list from a failed detector is not 'no stalls': stalls stays [] but needs_you.stalls null + an error
  try { stalls = detectStalls(db, now); needs_you.stalls = stalls.length; } catch (e) { fail('stalls', e); }
  const blocking = [needs_you.approvals, needs_you.requeue, needs_you.labels, needs_you.memory_review, needs_you.open_prs, needs_you.proposals,
    needs_you.stalls, needs_you.join_requests, needs_you.shell_requests];
  needs_you.total = blocking.some((x) => x === null) || needs_you.shared_subjects === null ? null
    : (blocking as number[]).reduce((a, b) => a + b, 0) - (needs_you.shared_subjects as number);
  const { armed, off } = listSchedulers();
  const health = worstState([...guardrails.map((g) => g.state), errors.length || stalls.length ? 'DEGRADED' : 'HEALTHY']);
  return {
    at: new Date(now).toISOString(), snapshot_id: randomUUID(), health, errors,
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
