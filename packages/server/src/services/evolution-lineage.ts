import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { ATTRIBUTION_OF_PROPOSAL } from './decisions-inbox';
import { efficiencyView } from './resource-ledger';

/**
 * Operator directive 'Restore Evolutionary Health' (2026-10-11): `verified` throughput is not fitness. This read-only view
 * follows each proposal of the window through its lineage — proposal → experiment → verified → merged → settled → survived
 * 14 d — and states plainly which later stages (30 d survival, capability gain, reproduction) Djimitflo does not measure yet.
 *
 * Regressions are split four ways: a maker that failed (mutation failure), a reviewer that rejected (NOT an evolutionary
 * regression — the gate worked), the environment, and a change that was verified + merged and then did not survive
 * (post-verification regression). Only mutation failures and post-verification regressions count as evolutionary harm.
 *
 * NEV (Net Evolutionary Value, shadow): survived changes minus severity-weighted post-verification regressions, reported per
 * M cloud tokens, per local kWh and per operator decision — separately, never one blended number. INSUFFICIENT_EVIDENCE below
 * NEV_MIN_SETTLED settled lineages.
 */
export const NEV_MIN_SETTLED = 10;
/** severity weights of a post-verification regression (stated, not fitted): revert / removal = 1, follow-up fix = 0.5 */
export const SEVERITY = { removed: 1, follow_up_fix: 0.5 } as const;
const HUMAN = (decidedBy: string | null) => Boolean(decidedBy) && !/^(autonomy|inherit|agent|system|auto)[:-]/.test(String(decidedBy));

export type StageName = 'discovery' | 'proposal' | 'experiment' | 'verified' | 'merged' | 'settled' | 'survived_14d' | 'survived_30d' | 'capability_gain' | 'reproduced';
export interface Stage {
  stage: StageName;
  /** null = not measured (see `measured`) — never 0 for 'unknown' */
  count: number | null;
  /** count / previous stage count; null when either side is unmeasured or the previous stage is 0 */
  conversion: number | null;
  /** median days the lineages that reached this stage and not the next have waited since reaching it */
  median_age_days: number | null;
  top_failure: string | null;
  /** maker + reviewer lease tokens of the lineages at this stage (lease runtime_usage); null when no lease tokens exist */
  compute_tokens: number | null;
  /** human decisions spent on these lineages at this transition (approvals / merges / labels) */
  operator_decisions: number | null;
  measured: 'measured' | 'not_linked' | 'not_measured';
  note?: string;
}

interface Row { id: string; status: string; created_at: string; updated_at: string; goal_at: string | null; run_id: string | null;
  pr_state: string | null; merged_at: string | null; settled_at: string | null; survived: number | null; not_scored: string | null; cls: string | null }

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.floor(s.length / 2)].toFixed(1); };

export function evolutionLineage(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, windowDays = 60) {
  const since = new Date(now - windowDays * 86_400_000).toISOString();
  const days = (t: string | null) => (t ? (now - Date.parse(t)) / 86_400_000 : NaN);
  const errors: string[] = [];
  const all = <T>(sql: string, ...args: unknown[]): T[] | null => { try { return db.prepare(sql).all(...args) as T[]; } catch (e) { errors.push(String(e instanceof Error ? e.message : e).slice(0, 160)); return null; } };
  const one = (sql: string, ...args: unknown[]): number | null => {
    try { const v = Object.values((db.prepare(sql).get(...args) ?? {}) as Record<string, unknown>)[0]; return v === null || v === undefined ? null : Number(v); }
    catch (e) { errors.push(String(e instanceof Error ? e.message : e).slice(0, 160)); return null; }
  };

  // one row per proposal of the window, with its latest run (and that run's PR settlement)
  const rows = all<Row>(`SELECT s.id, s.status, s.created_at, s.updated_at, g.created_at AS goal_at, r.id AS run_id,
      json_extract(r.metadata, '$.pr_outcome.state') AS pr_state, json_extract(r.metadata, '$.pr_outcome.merged_at') AS merged_at,
      json_extract(r.metadata, '$.pr_outcome.settled_at') AS settled_at, json_extract(r.metadata, '$.pr_outcome.survived') AS survived,
      json_extract(r.metadata, '$.pr_outcome.not_scored') AS not_scored, ${ATTRIBUTION_OF_PROPOSAL} AS cls
    FROM self_improvements s
    LEFT JOIN goals g ON g.improvement_id = s.id
    LEFT JOIN loop_runs r ON r.id = (SELECT r2.id FROM loop_runs r2 WHERE r2.goal_id = g.id ORDER BY (json_extract(r2.metadata, '$.pr_url') IS NOT NULL) DESC, r2.created_at DESC LIMIT 1)
    WHERE s.created_at >= ?`, since) ?? [];
  const tokensOf = (runIds: Array<string | null>): number | null => {
    const ids = runIds.filter((x): x is string => Boolean(x));
    if (!ids.length) return null;
    const v = one(`SELECT SUM(json_extract(metadata, '$.runtime_usage.total_tokens')) FROM worker_leases
      WHERE role IN ('maker', 'checker', 'security_checker') AND loop_run_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    return v === null ? null : Math.round(v);
  };
  const humanApprovals = (runIds: Array<string | null>): number | null => {
    const ids = runIds.filter((x): x is string => Boolean(x));
    if (!ids.length) return 0;
    const r = all<{ decided_by: string | null }>(`SELECT a.decided_by FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.status IN ('approved', 'denied') AND COALESCE(json_extract(a.metadata, '$.loop_run_id'), json_extract(t.metadata, '$.loop_run_id')) IN (${ids.map(() => '?').join(',')})`, ...ids);
    return r ? r.filter((x) => HUMAN(x.decided_by)).length : null;
  };

  const exp = rows.filter((r) => r.run_id);
  const ver = rows.filter((r) => r.status === 'verified');
  const merged = ver.filter((r) => r.pr_state === 'merged');
  // settled with a fitness verdict (not_scored settlements say nothing about survival)
  const settled = merged.filter((r) => r.settled_at && r.survived !== null);
  const survived = settled.filter((r) => r.survived === 1);
  const discoveries = one("SELECT COUNT(*) FROM external_events WHERE event_type LIKE 'discovery.%' AND occurred_at >= ?", since);
  const labels = one("SELECT COUNT(*) FROM judgments WHERE judgment IN ('operator_label', 'attribution_audit') AND created_at >= ?", since);
  const top = (xs: string[]) => { if (!xs.length) return null; const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    const [k, n] = [...c.entries()].sort((a, b) => b[1] - a[1])[0]; return `${k} (${n})`; };
  const conv = (a: number | null, b: number | null) => (a === null || b === null || !b ? null : +(a / b).toFixed(3));

  const stages: Stage[] = [
    { stage: 'discovery', count: discoveries, conversion: null, median_age_days: null, top_failure: null, compute_tokens: null, operator_decisions: 0, measured: 'not_linked',
      note: 'discovery events are counted, but no proposal records which discovery it came from — discovery → proposal conversion is not measurable' },
    { stage: 'proposal', count: rows.length, conversion: null, median_age_days: median(rows.filter((r) => !r.run_id).map((r) => days(r.created_at))),
      top_failure: top(rows.filter((r) => !r.run_id).map((r) => r.status)), compute_tokens: null, operator_decisions: labels, measured: 'measured' },
    { stage: 'experiment', count: exp.length, conversion: conv(exp.length, rows.length),
      median_age_days: median(exp.filter((r) => r.status !== 'verified' && !['regressed', 'infra_failed', 'no_change', 'needs_more_evidence', 'blocked'].includes(r.status)).map((r) => days(r.goal_at))),
      top_failure: top(exp.filter((r) => r.status !== 'verified').map((r) => (r.status === 'regressed' ? `regressed:${r.cls ?? 'unattributed'}` : r.status))),
      compute_tokens: tokensOf(exp.map((r) => r.run_id)), operator_decisions: humanApprovals(exp.map((r) => r.run_id)), measured: 'measured' },
    { stage: 'verified', count: ver.length, conversion: conv(ver.length, exp.length),
      median_age_days: median(ver.filter((r) => r.pr_state !== 'merged').map((r) => days(r.updated_at))),
      top_failure: top(ver.filter((r) => r.pr_state !== 'merged').map((r) => (r.pr_state === 'closed_unmerged' ? 'closed_unmerged' : r.pr_state === 'open' || !r.pr_state ? 'awaiting_human_merge' : r.pr_state))),
      compute_tokens: tokensOf(ver.map((r) => r.run_id)), operator_decisions: null, measured: 'measured' },
    { stage: 'merged', count: merged.length, conversion: conv(merged.length, ver.length),
      median_age_days: median(merged.filter((r) => !r.settled_at).map((r) => days(r.merged_at))),
      top_failure: top(merged.filter((r) => !r.settled_at).map(() => 'within_14d_survival_window')), compute_tokens: null,
      // every merged loop PR is a human merge today (earned auto-merge is shadow)
      operator_decisions: merged.length, measured: 'measured' },
    { stage: 'settled', count: settled.length, conversion: conv(settled.length, merged.length), median_age_days: null,
      top_failure: top(settled.filter((r) => r.survived === 0).map(() => 'removed_or_reverted')), compute_tokens: null, operator_decisions: 0, measured: 'measured' },
    { stage: 'survived_14d', count: survived.length, conversion: conv(survived.length, settled.length), median_age_days: null, top_failure: null, compute_tokens: null, operator_decisions: 0, measured: 'measured' },
    { stage: 'survived_30d', count: null, conversion: null, median_age_days: null, top_failure: null, compute_tokens: null, operator_decisions: null, measured: 'not_measured',
      note: 'merge survival checks once at 14 d; no 30-day check exists' },
    { stage: 'capability_gain', count: null, conversion: null, median_age_days: null, top_failure: null, compute_tokens: null, operator_decisions: null, measured: 'not_measured',
      note: 'no measurement links a surviving change to a capability gain' },
    { stage: 'reproduced', count: null, conversion: null, median_age_days: null, top_failure: null, compute_tokens: null, operator_decisions: null, measured: 'not_measured',
      note: 'MISSING: nothing re-applies a surviving change in another niche, species or repository' },
  ];

  // largest bottleneck: among measured transitions with ≥ 5 lineages in, the most lineages lost (count_in − count_out)
  const transitions = stages.slice(2).map((s, j) => ({ from: stages[j + 1], to: s }))
    .filter((t) => t.from.measured === 'measured' && t.to.measured === 'measured' && (t.from.count ?? 0) >= 5 && t.to.count !== null);
  const worst = transitions.sort((a, b) => ((b.from.count ?? 0) - (b.to.count ?? 0)) - ((a.from.count ?? 0) - (a.to.count ?? 0)))[0];
  const oldest = [...stages].filter((s) => s.median_age_days !== null).sort((a, b) => (b.median_age_days ?? 0) - (a.median_age_days ?? 0))[0];
  const bottleneck = worst ? { from: worst.from.stage, to: worst.to.stage, lost: (worst.from.count ?? 0) - (worst.to.count ?? 0), conversion: worst.to.conversion,
    reason: worst.from.top_failure, oldest_queue: oldest ? { stage: oldest.stage, median_age_days: oldest.median_age_days } : null } : null;

  // four-way regression decomposition (window) + post-verification regressions (merged, settled, did not survive)
  const reg = rows.filter((r) => r.status === 'regressed');
  const regression_split = {
    mutation_failure: reg.filter((r) => r.cls === 'maker_failure').length,
    /** the gate worked: a reviewer rejected the change — not an evolutionary regression */
    reviewer_rejection: reg.filter((r) => r.cls === 'reviewer_failure').length,
    environment: reg.filter((r) => r.cls === 'environment_failure').length + rows.filter((r) => r.status === 'infra_failed').length,
    post_verification: settled.filter((r) => r.survived === 0).length,
    /** follow-up fixes of a merged change are not detected yet — weight 0.5 once they are */
    post_verification_follow_up_fix: null as number | null,
    unknown: reg.filter((r) => !r.cls || !['maker_failure', 'reviewer_failure', 'environment_failure'].includes(r.cls)).length,
  };
  const evolutionary_regressions = regression_split.mutation_failure + regression_split.post_verification;

  // NEV: survived − severity-weighted post-verification regressions, per resource (separately)
  const harm = SEVERITY.removed * regression_split.post_verification;
  const nevRaw = survived.length - harm;
  const cloudTokens = tokensOf(ver.map((r) => r.run_id));
  let energyPct: number | null = null; let kwh: number | null = null;
  try { const e = efficiencyView(db, now, env, Math.min(windowDays, 30)); energyPct = e.coverage.window_pct; kwh = e.hosts.reduce((a, h) => a + (h.gpu_kwh ?? 0), 0) || null; }
  catch { /* power tables absent: energy unknown */ }
  const decisions = (labels ?? 0) + merged.length + (humanApprovals(exp.map((r) => r.run_id)) ?? 0);
  const enough = settled.length >= NEV_MIN_SETTLED;
  const nev = {
    status: enough ? 'ok' as const : 'INSUFFICIENT_EVIDENCE' as const,
    reason: enough ? null : `${settled.length} settled lineage(s) with a survival verdict; NEV needs ≥ ${NEV_MIN_SETTLED}`,
    value: enough ? nevRaw : null,
    survived: survived.length, settled: settled.length,
    survival_rate: settled.length ? +(survived.length / settled.length).toFixed(3) : null,
    survival_ci: settled.length ? wilson(survived.length, settled.length) : null,
    severity_weights: SEVERITY,
    per_m_cloud_tokens: enough && cloudTokens ? +(nevRaw / (cloudTokens / 1e6)).toFixed(3) : null,
    per_kwh: enough && energyPct !== null && energyPct >= 80 && kwh ? +(nevRaw / kwh).toFixed(3) : null,
    per_kwh_status: energyPct === null || energyPct < 80 ? `INSUFFICIENT_EVIDENCE (energy coverage ${energyPct ?? 'unknown'} % < 80 %)` : 'ok',
    per_operator_decision: enough && decisions ? +(nevRaw / decisions).toFixed(3) : null,
    operator_decisions: decisions, cloud_tokens: cloudTokens,
    note: 'NEV = survived 14 d − severity × post-verification regressions; mutation failures are charged through compute, not as harm. Raw verified throughput is shown separately and is not improvement.',
  };
  const throughput = { verified: ver.length, label: 'throughput, not improvement' };
  return { window_days: windowDays, stages, bottleneck, regression_split, evolutionary_regressions, nev, throughput,
    jev_semantic_routing: 'REJECTED by JC-001 (NE-001, PR #779)', errors };
}

/**
 * Post-verification regressions settled in the window (merged loop PRs that did not survive 14 d) — added to the cockpit
 * regressions guardrail under outcome attribution, next to maker failures.
 */
export function postVerificationRegressions(db: Database, since: string): number | null {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.pr_outcome.state') = 'merged'
      AND json_extract(metadata, '$.pr_outcome.survived') = 0 AND json_extract(metadata, '$.pr_outcome.settled_at') >= ?`).get(since) as { n: number }).n;
  } catch { return null; }
}
