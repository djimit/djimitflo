import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { nonMakerRunSql, attributionSummary, attributionBackfill } from './outcome-attribution';
import { efficiencyView } from './resource-ledger';
import type { ForecasterScoreV2 } from './forecast-scoring';

/**
 * §16 step 1 (docs/research/intelligence-metrics/IMPLEMENTATION_PLAN.md, METRIC_CONTRACTS.yaml v0.2.0): one read-only status
 * per metric contract, computed from tables and helpers that already exist. A metric is 'ok' only when the contract's
 * minimum sample holds; otherwise INSUFFICIENT_EVIDENCE (or UNDEFINED when the estimand cannot exist yet) with value and ci
 * null and the blocker spelled out — never 0 for "not estimable". Nothing here writes, selects or promotes.
 */
export const INTELLIGENCE_CONTRACT_VERSION = '0.2.0';
export const INTELLIGENCE_METRIC_IDS = ['VIG', 'RIR', 'GTI', 'CLY', 'FRR', 'CAR', 'CIA', 'MCS', 'ADQ', 'EII', 'ESE', 'SCIG', 'ECON'] as const;
export type IntelligenceMetricId = (typeof INTELLIGENCE_METRIC_IDS)[number];
export type IntelligenceStatus = 'ok' | 'INSUFFICIENT_EVIDENCE' | 'UNDEFINED';
export interface IntelligenceMetric {
  metric_id: IntelligenceMetricId; version: string; status: IntelligenceStatus;
  value: number | null; ci: [number, number] | null; n: number;
  /** why the metric is not 'ok' (null when it is) */
  blocker: string | null;
  detail: Record<string, unknown>;
}

const r4 = (x: number) => +x.toFixed(4);
const metric = (metric_id: IntelligenceMetricId, status: IntelligenceStatus, n: number, blocker: string | null, detail: Record<string, unknown> = {},
  value: number | null = null, ci: [number, number] | null = null): IntelligenceMetric =>
  status === 'ok'
    ? { metric_id, version: INTELLIGENCE_CONTRACT_VERSION, status, value, ci, n, blocker: null, detail }
    : { metric_id, version: INTELLIGENCE_CONTRACT_VERSION, status, value: null, ci: null, n, blocker: blocker ?? 'not estimable', detail };

/** Newcombe hybrid-score interval for p1 − p2 from two Wilson intervals. */
function diffCi(k1: number, n1: number, k2: number, n2: number): [number, number] {
  const p1 = k1 / n1; const p2 = k2 / n2; const [l1, u1] = wilson(k1, n1); const [l2, u2] = wilson(k2, n2);
  const d = p1 - p2;
  return [r4(d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)), r4(d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2))];
}

// ── §16 step 3: failure signatures at read time ─────────────────────────────────────────────────────────────────────

/** Normalised error class: ids, hashes, urls, paths, quoted strings and numbers stripped, so the same failure maps to the same text. */
export function normaliseErrorClass(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const s = reason.toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/g, '<hash>')
    .replace(/(?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?/g, '<path>')
    .replace(/(["'`])[^"'`]*\1/g, '<str>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 160) : null;
}

export interface FailureSignature { signature: string; key: string; lane: string; gate: string | null; error_class: string | null }

/**
 * Stable signature of one failed outcome: lane (+ runtime) + first failed gate + normalised error class. The gate comes from
 * evidence refs (`gate:<name>:fail`) or loop_runs failed_gates (`<name>: <description>`); the error class from the first
 * non-empty reason (lease failure_reason, attribution reason). Nothing observable → null: such a failure is counted as missing,
 * never as a new signature.
 */
export function failureSignature(input: { lane: string; refs?: unknown[]; failed_gates?: unknown[]; reasons?: Array<string | null | undefined> }): FailureSignature | null {
  const fromRef = (input.refs ?? []).find((r): r is string => typeof r === 'string' && /^gate:[^:]+:fail$/.test(r));
  const fromGates = (input.failed_gates ?? []).find((g): g is string => typeof g === 'string' && g.trim().length > 0);
  const gate = fromRef ? fromRef.slice(5, -5) : fromGates ? fromGates.split(':')[0].trim() || null : null;
  const error_class = (input.reasons ?? []).map(normaliseErrorClass).find((x): x is string => Boolean(x)) ?? null;
  if (!gate && !error_class) return null;
  const key = `${input.lane}|${gate ?? '-'}|${error_class ?? '-'}`;
  return { signature: createHash('sha256').update(key).digest('hex').slice(0, 16), key, lane: input.lane, gate, error_class };
}

export interface FailureUnit { at: string; lane: string; failed: boolean; signature: FailureSignature | null }

/**
 * Failure recurrence (FRR proxy until remediation links exist, plan step 5): in time order, a unit is *exposed* once its lane
 * has failed before; an exposed failure whose signature already occurred in that lane is a *repeat*. FRR = repeats / exposed,
 * Wilson 95 %. A failure without a signature is excluded from both (missing_n) so blind failures cannot lower FRR; the
 * observability share is reported beside it. Minimum (contract): ≥ 20 signed failures and ≥ 3 distinct signatures.
 */
export function failureRecurrence(units: FailureUnit[], min = { failures: 20, signatures: 3 }): IntelligenceMetric {
  const seen = new Map<string, Set<string>>(); const distinct = new Set<string>();
  let exposed = 0; let repeats = 0; let failures = 0; let missing = 0;
  const weeks = new Map<string, { exposed: number; repeats: number; failures: number }>();
  for (const u of [...units].sort((a, b) => a.at.localeCompare(b.at))) {
    const d = new Date(u.at); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const week = d.toISOString().slice(0, 10);
    const w = weeks.get(week) ?? { exposed: 0, repeats: 0, failures: 0 }; weeks.set(week, w);
    if (u.failed) { failures++; w.failures++; }
    if (u.failed && !u.signature) { missing++; continue; }
    const lane = seen.get(u.lane);
    if (lane && lane.size > 0) {
      exposed++; w.exposed++;
      if (u.failed && lane.has(u.signature!.signature)) { repeats++; w.repeats++; }
    }
    if (u.failed) { (lane ?? seen.set(u.lane, new Set()).get(u.lane)!).add(u.signature!.signature); distinct.add(u.signature!.signature); }
  }
  const signed = failures - missing;
  const detail = { failures, signed_failures: signed, missing_n: missing, observability: failures ? r4(signed / failures) : null, distinct_signatures: distinct.size,
    repeats, by_week: [...weeks.entries()].sort().map(([week_start, w]) => ({ week_start, ...w })),
    note: 'repeat = a failure whose signature already occurred in the same lane; exposed = every unit after the lane\'s first failure. No remediation link yet (plan step 5), so this is recurrence, not recurrence-after-fix.' };
  if (signed < min.failures || distinct.size < min.signatures || !exposed)
    return metric('FRR', 'INSUFFICIENT_EVIDENCE', exposed, `${signed} signed failures, ${distinct.size} distinct signatures; needs ≥ ${min.failures} and ≥ ${min.signatures}`, detail);
  // contract missing_data_policy: more than 20 % of failures without a signature → not estimable
  if (missing / failures > 0.2)
    return metric('FRR', 'INSUFFICIENT_EVIDENCE', exposed, `${missing} of ${failures} failures (${Math.round((100 * missing) / failures)} %) carry no gate or reason; the contract allows ≤ 20 % missing`, detail);
  return metric('FRR', 'ok', exposed, null, detail, r4(repeats / exposed), wilson(repeats, exposed));
}

/** Production maker outcomes in the window as failure units (gym and merge domains are not production failures). */
function failureUnits(db: Database, since: string): FailureUnit[] {
  let rows: Array<{ skill_id: string; success: number; refs: string | null; at: string; run: string | null; lease_reason: string | null; attribution_reason: string | null; failed_gates: string | null }> = [];
  try {
    rows = db.prepare(`SELECT o.skill_id, o.success, o.evidence_refs_json AS refs, o.created_at AS at, o.task_id AS run,
        (SELECT json_extract(l.metadata, '$.failure_reason') FROM worker_leases l WHERE l.loop_run_id = o.task_id AND l.role = 'maker'
          AND json_extract(l.metadata, '$.failure_reason') IS NOT NULL ORDER BY l.created_at DESC LIMIT 1) AS lease_reason,
        (SELECT j.reason FROM judgments j WHERE j.judgment = 'outcome_attribution' AND j.subject_id = o.task_id ORDER BY j.created_at DESC LIMIT 1) AS attribution_reason,
        (SELECT json_extract(r.metadata, '$.failed_gates') FROM loop_runs r WHERE r.id = o.task_id) AS failed_gates
      FROM skill_outcomes o WHERE o.skill_id LIKE 'loop-maker:%' AND o.domain NOT IN ('gym', 'merge') AND o.created_at >= ? ORDER BY o.created_at LIMIT 20000`).all(since) as typeof rows;
  } catch {
    try { // no worker_leases / judgments table: the outcome's own refs still carry the gate
      rows = (db.prepare(`SELECT skill_id, success, evidence_refs_json AS refs, created_at AS at, task_id AS run FROM skill_outcomes
        WHERE skill_id LIKE 'loop-maker:%' AND domain NOT IN ('gym', 'merge') AND created_at >= ? ORDER BY created_at LIMIT 20000`).all(since) as typeof rows)
        .map((r) => ({ ...r, lease_reason: null, attribution_reason: null, failed_gates: null }));
    } catch { return []; }
  }
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    const id = `${r.run ?? r.at}|${r.skill_id}`; if (seen.has(id)) return []; seen.add(id); // one unit per (run, maker)
    const parse = (x: string | null): unknown[] => { try { const v = JSON.parse(x || '[]') as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };
    const refs = parse(r.refs);
    const notFailure = refs.includes('outcome_class:no_change') || refs.includes('evolve:lost_eligible');
    const failed = r.success === 0 && !notFailure;
    const lane = r.skill_id.slice('loop-maker:'.length);
    // an evolve loser carries its loss reason as a ref (`evolve:reason:runtime exit != 0`)
    const evolveReason = refs.find((x): x is string => typeof x === 'string' && x.startsWith('evolve:reason:'))?.slice('evolve:reason:'.length);
    return [{ at: r.at, lane, failed, signature: failed ? failureSignature({ lane, refs, failed_gates: parse(r.failed_gates), reasons: [r.lease_reason, evolveReason, r.attribution_reason] }) : null }];
  });
}

// ── §16 step 2: approval → goal → outcome join (ADQ) ───────────────────────────────────────────────────────────────

/**
 * Approvals of the window with their outcome. The link stored on the approval (metadata.goal_id / loop_run_id /
 * improvement_id, written at creation since §16 step 2) is used first; older rows fall back to the read-time derivation
 * through the worker task (tasks.metadata.loop_run_id). Nothing is backfilled.
 */
export function approvalOutcomes(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    return db.prepare(`SELECT a.id, a.status, a.decided_by,
        json_extract(a.metadata, '$.goal_id') AS stored_goal, r.loop_name AS lane, s.status AS outcome,
        CASE WHEN r.id IS NULL THEN 0 ELSE ${nonMakerRunSql('r.id', env)} END AS non_maker
      FROM approvals a
      LEFT JOIN tasks t ON t.id = a.task_id
      LEFT JOIN loop_runs r ON r.id = COALESCE(json_extract(a.metadata, '$.loop_run_id'), json_extract(t.metadata, '$.loop_run_id'))
      LEFT JOIN goals g ON g.id = COALESCE(json_extract(a.metadata, '$.goal_id'), r.goal_id)
      LEFT JOIN self_improvements s ON s.id = COALESCE(json_extract(a.metadata, '$.improvement_id'), g.improvement_id)
      WHERE a.created_at >= ?`).all(since) as Array<{ id: string; status: string; decided_by: string | null; stored_goal: string | null; lane: string | null; outcome: string | null; non_maker: number }>;
  } catch { return []; }
}

function adq(db: Database, since: string, env: NodeJS.ProcessEnv): IntelligenceMetric {
  const rows = approvalOutcomes(db, since, env).filter((r) => r.status === 'approved');
  const autonomous = (r: { decided_by: string | null }) => /^(autonomy|inherit):/.test(r.decided_by ?? '');
  const settled = rows.filter((r) => (r.outcome === 'verified' || r.outcome === 'regressed') && !(r.outcome === 'regressed' && r.non_maker));
  const classes = new Map<string, { auto: [number, number]; human: [number, number] }>(); // [verified, n]
  for (const r of settled) {
    const c = classes.get(r.lane ?? 'unknown') ?? { auto: [0, 0], human: [0, 0] };
    const arm = autonomous(r) ? c.auto : c.human; arm[1]++; if (r.outcome === 'verified') arm[0]++;
    classes.set(r.lane ?? 'unknown', c);
  }
  const by_class = [...classes.entries()].map(([cls, c]) => ({ cls, autonomous: { verified: c.auto[0], n: c.auto[1] }, human: { verified: c.human[0], n: c.human[1] } }));
  const detail = { approved: rows.length, autonomous: rows.filter(autonomous).length, linked_stored: rows.filter((r) => r.stored_goal).length,
    with_outcome: settled.length, missing_outcome: rows.length - settled.length, by_class,
    note: 'class = loop lane; outcome = proposal verified / regressed (regressions attributed to reviewer or environment excluded); U = verified rate. Autonomy is granted on easier classes, so the difference is within class only.' };
  const eligible = by_class.filter((c) => c.autonomous.n >= 30 && c.human.n >= 30);
  if (!eligible.length) return metric('ADQ', 'INSUFFICIENT_EVIDENCE', settled.length, `no class with ≥ 30 autonomous and ≥ 30 human decisions with an outcome (${settled.length} of ${rows.length} approvals linked to a settled outcome)`, detail);
  // stratified (by class) difference in verified rate, weights = class share of eligible decisions; normal approximation.
  // Not ADQ yet: neither randomised nor propensity-adjusted, and the contract's human audit sample of autonomous decisions
  // (≥ 10 %) does not exist, so it stays INSUFFICIENT_EVIDENCE and the unadjusted number is shown only as detail.
  const N = eligible.reduce((a, c) => a + c.autonomous.n + c.human.n, 0);
  let d = 0; let v = 0;
  for (const c of eligible) {
    const w = (c.autonomous.n + c.human.n) / N; const p1 = c.autonomous.verified / c.autonomous.n; const p2 = c.human.verified / c.human.n;
    d += w * (p1 - p2); v += w * w * (p1 * (1 - p1) / c.autonomous.n + p2 * (1 - p2) / c.human.n);
  }
  return metric('ADQ', 'INSUFFICIENT_EVIDENCE', N, 'no human audit sample of autonomous approvals (contract: ≥ 10 %), and the arms are neither randomised nor propensity-adjusted', {
    ...detail, eligible_classes: eligible.map((c) => c.cls),
    unadjusted_within_class: { difference: r4(d), ci: [r4(d - 1.96 * Math.sqrt(v)), r4(d + 1.96 * Math.sqrt(v))], caveat: 'confounded by class difficulty and time (human approvals precede auto-approval); not ADQ' } });
}

// ── the section ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface IntelligenceInputs {
  /** forecastScoresV2 forecasters (already computed by the evidence builder) */
  forecasters: ForecasterScoreV2[];
  effort_x1: { on: { verified: number; regressed: number }; off: { verified: number; regressed: number } };
  memory_holdout: { rules: { n: number }; holdout: { n: number } };
  /** §16 step 7: current holdout epochs over the reuse limit (evolution-evidence holdout_exposure) */
  holdout_reuse_risk?: Array<{ holdout: string; epoch: number; candidates: number }>;
}

export function intelligenceEvidence(db: Database, env: NodeJS.ProcessEnv, now: number, since: string, inputs: IntelligenceInputs) {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const count = (sql: string, ...args: unknown[]): number | null => { try { const r = db.prepare(sql).get(...args) as Record<string, unknown> | undefined; return r ? Number(Object.values(r)[0]) : null; } catch { return null; } };
  const metrics: IntelligenceMetric[] = [];

  // VIG: paired graded (else binary) difference on the latest trial with headroom, ≥ 20 paired tasks, parent mean in [0.30, 0.95]
  const trials = all<{ trial_id: string; state: string; deciding_n: number | null; f_parent_failures: number | null; b: number | null; c: number | null; p: number | null;
    graded_mean_parent: number | null; graded_mean_mutant: number | null; graded_p: number | null; graded_decision: string | null; recorded_at: string }>(
    'SELECT trial_id, state, deciding_n, f_parent_failures, b, c, p, graded_mean_parent, graded_mean_mutant, graded_p, graded_decision, recorded_at FROM genome_trial_results ORDER BY recorded_at DESC');
  const parentMean = (t: (typeof trials)[number]) => t.graded_mean_parent ?? (t.deciding_n ? (t.deciding_n - (t.f_parent_failures ?? 0)) / t.deciding_n : null);
  // no_headroom (skipped) and blind (the parent fails too few deciding tasks for any significant win) cannot show a difference
  const vigEligible = trials.filter((t) => t.state !== 'no_headroom' && t.state !== 'blind' && (t.deciding_n ?? 0) >= 20 && parentMean(t) !== null && parentMean(t)! >= 0.30 && parentMean(t)! <= 0.95);
  const decisive = (t: (typeof trials)[number]) => (t.graded_p !== null && t.graded_p < 0.05) || t.graded_decision === 'promote' || (t.p !== null && t.p < 0.05 && (t.b ?? 0) > (t.c ?? 0));
  const byState = trials.reduce<Record<string, number>>((a, t) => ({ ...a, [t.state]: (a[t.state] ?? 0) + 1 }), {});
  const vigTrial = vigEligible[0];
  const vig = vigTrial
    ? metric('VIG', 'ok', vigTrial.deciding_n!, null, { trial_id: vigTrial.trial_id, decisive: decisive(vigTrial), p: vigTrial.graded_p ?? vigTrial.p, trials: trials.length, by_state: byState,
      holdout_reuse_risk: inputs.holdout_reuse_risk ?? [], note: 'paired mean difference (graded when recorded, else (b − c) / n); the trial stores p only, so the CI is not available here' },
      r4(vigTrial.graded_mean_mutant !== null && vigTrial.graded_mean_parent !== null ? vigTrial.graded_mean_mutant - vigTrial.graded_mean_parent : ((vigTrial.b ?? 0) - (vigTrial.c ?? 0)) / vigTrial.deciding_n!))
    : metric('VIG', 'INSUFFICIENT_EVIDENCE', trials.length, `${trials.length} trial(s), none past headroom (not no_headroom / blind) with ≥ 20 paired tasks and parent mean in [0.30, 0.95] (${Object.entries(byState).map(([s, n]) => `${n} ${s}`).join(', ') || 'none recorded'})`, { trials: trials.length, by_state: byState, holdout_reuse_risk: inputs.holdout_reuse_risk ?? [] });
  metrics.push(vig);

  // RIR: needs ≥ 3 cycles each with a decisive VIG
  const decisiveCycles = vigEligible.filter(decisive).length;
  metrics.push(metric('RIR', 'INSUFFICIENT_EVIDENCE', decisiveCycles, decisiveCycles < 3 ? `${decisiveCycles} cycle(s) with a decisive VIG; needs ≥ 3` : 'per-cycle cost is not attributed to a trial in the resource ledger yet', { decisive_cycles: decisiveCycles }));

  // GTI = VIG_unseen / VIG_source, defined only once a source VIG is decisive; no per-stratum VIG is recorded yet
  const paths = all<{ repo: string }>("SELECT DISTINCT COALESCE(repository_path, '') AS repo FROM loop_runs WHERE created_at >= ?", since).map((r) => r.repo).filter(Boolean);
  const gtiDetail = { repository_paths: paths.length, note: 'distinct loop_runs.repository_path values; checkout aliases of one repository (/app, /workspace/…) are not distinct repositories' };
  metrics.push(vigEligible.some(decisive)
    ? metric('GTI', 'INSUFFICIENT_EVIDENCE', 0, 'no per-stratum (unseen-repository / task-family) VIG is recorded yet', gtiDetail)
    : metric('GTI', 'UNDEFINED', 0, 'no decisive source VIG, so the transfer ratio is undefined; a second repository with ≥ 20 tasks is also needed', gtiDetail));

  // CLY: validated lessons / determined (completed) assessments; ≥ 10 completed experiments
  const ola = all<{ status: string; causal: number; replicated: number; n: number }>(`SELECT status, causal_support AS causal, replications > 0 AS replicated, COUNT(*) AS n
    FROM outcome_learning_assessments GROUP BY 1, 2, 3`);
  const completed = ola.filter((r) => r.status !== 'UNDETERMINED').reduce((a, r) => a + r.n, 0);
  const validated = ola.filter((r) => r.status === 'SUPPORTED' && r.causal && r.replicated).reduce((a, r) => a + r.n, 0);
  const clyDetail = { assessments: ola.reduce((a, r) => a + r.n, 0), completed, validated, falsified: ola.filter((r) => r.status === 'FALSIFIED').reduce((a, r) => a + r.n, 0),
    memory_holdout_arms: { rules: inputs.memory_holdout.rules.n, holdout: inputs.memory_holdout.holdout.n },
    note: 'validated = SUPPORTED with causal support and ≥ 1 replication — an upper bound: independent verification and the downstream effect are not recorded per lesson' };
  metrics.push(completed >= 10
    ? metric('CLY', 'ok', completed, null, clyDetail, r4(validated / completed), wilson(validated, completed))
    : metric('CLY', 'INSUFFICIENT_EVIDENCE', completed, `${completed} completed assessment(s) (SUPPORTED / FALSIFIED); needs ≥ 10`, clyDetail));

  // FRR (§16 step 3)
  metrics.push(failureRecurrence(failureUnits(db, since)));

  // CAR (§16 steps 3–4): operator adjudications of the weekly audit sample (judgments attribution_audit, mode operator_label,
  // state_hash = the computed class judged; newest label per run). CAR = correct / audited — unclear stays in the denominator
  // and is reported. Coverage (attributed / settled) and the read-only backfill of unattributed runs are context, never labels.
  const audits = all<{ computed: string; verdict: string }>(`SELECT a.state_hash AS computed, a.decision AS verdict FROM judgments a
    WHERE a.judgment = 'attribution_audit' AND a.mode = 'operator_label'
      AND a.rowid = (SELECT b.rowid FROM judgments b WHERE b.judgment = 'attribution_audit' AND b.mode = 'operator_label' AND b.subject_id = a.subject_id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1)`)
    .filter((a) => ['correct', 'wrong', 'unclear'].includes(a.verdict));
  const carClasses = ['maker_failure', 'reviewer_failure', 'environment_failure', 'verified'];
  const tally = (rows: typeof audits) => ({ audited: rows.length, correct: rows.filter((a) => a.verdict === 'correct').length,
    wrong: rows.filter((a) => a.verdict === 'wrong').length, unclear: rows.filter((a) => a.verdict === 'unclear').length });
  const per_class = Object.fromEntries(carClasses.map((c) => {
    const t = tally(audits.filter((a) => a.computed === c));
    return [c, { ...t, car: t.audited ? r4(t.correct / t.audited) : null, ci: t.audited ? wilson(t.correct, t.audited) : null }];
  })) as Record<string, ReturnType<typeof tally> & { car: number | null; ci: [number, number] | null }>;
  const pooled = tally(audits);
  const attribution = (() => { try { const s = attributionSummary(db, now, 30, env); return { enabled: s.enabled, classes: s.classes }; } catch { return null; } })();
  const backfill = (() => { try { return attributionBackfill(db); } catch { return null; } })();
  const carDetail = { ...pooled, per_class, coverage: backfill?.coverage ?? null, attribution,
    backfill: backfill && { runs: backfill.runs, first_computed_at: backfill.first_computed_at, classes: backfill.classes, rules_only: backfill.rules_only, annotated: backfill.annotated, by_lane: backfill.by_lane, outcome_mismatch: backfill.outcome_mismatch, missing_inputs: backfill.missing_inputs, note: backfill.note },
    note: 'pooled CAR = correct / audited (unclear in the denominator); per_class is the stratified view. Labels come only from the operator (Decisions inbox).' };
  const carOk = pooled.audited >= 40 && carClasses.every((c) => per_class[c].audited >= 10);
  metrics.push(carOk
    ? metric('CAR', 'ok', pooled.audited, null, carDetail, r4(pooled.correct / pooled.audited), wilson(pooled.correct, pooled.audited))
    : metric('CAR', 'INSUFFICIENT_EVIDENCE', pooled.audited, `${pooled.audited} operator-audited attribution(s); needs ≥ 40 with ≥ 10 per class (${carClasses.map((c) => `${per_class[c].audited} ${c}`).join(', ')})`, carDetail));

  // CIA: X1 sibling arms (on − off verified rate), ≥ 93 settled per arm
  const on = inputs.effort_x1.on; const off = inputs.effort_x1.off;
  const nOn = on.verified + on.regressed; const nOff = off.verified + off.regressed;
  const ciaDetail = { on: { verified: on.verified, n: nOn }, off: { verified: off.verified, n: nOff }, note: 'X1 (EFFORT_SIBLING_RANDOMISE): verified rate with evolve siblings minus without; Newcombe 95 %' };
  metrics.push(nOn >= 93 && nOff >= 93
    ? metric('CIA', 'ok', nOn + nOff, null, ciaDetail, r4(on.verified / nOn - off.verified / nOff), diffCi(on.verified, nOn, off.verified, nOff))
    : metric('CIA', 'INSUFFICIENT_EVIDENCE', nOn + nOff, `${nOn} on / ${nOff} off settled; needs ≥ 93 per arm`, ciaDetail));

  // MCS: forecastScoresV2 — a decision-grade forecaster whose skill CI excludes 0
  const graded = inputs.forecasters.filter((f) => f.state === 'decision_grade' && (f.skill_ci[0] > 0 || f.skill_ci[1] < 0)).sort((a, b) => b.n - a.n);
  const mcsDetail = { scored: inputs.forecasters.length, decision_grade: inputs.forecasters.filter((f) => f.state === 'decision_grade').length };
  const best = graded[0];
  metrics.push(best
    ? metric('MCS', 'ok', best.n, null, { ...mcsDetail, forecaster: best.forecaster, brier: best.brier, auc: best.auc }, r4(best.skill), best.skill_ci)
    : metric('MCS', 'INSUFFICIENT_EVIDENCE', Math.max(0, ...inputs.forecasters.map((f) => f.n)), `${mcsDetail.decision_grade} of ${mcsDetail.scored} forecaster(s) decision-grade with a skill CI excluding 0; needs n ≥ 100, ≥ 10 positives`, mcsDetail));

  // ADQ (§16 step 2)
  metrics.push(adq(db, since, env));

  // EII: needs a versioned, independently labelled evaluation set (≥ 100 items per sub-metric); none exists
  const labelled = count("SELECT COUNT(*) FROM judgments WHERE mode = 'annotation' AND judgment IN ('kb_retrieval', 'kb_passage_relevance', 'discovery_relevance')") ?? 0;
  metrics.push(metric('EII', 'INSUFFICIENT_EVIDENCE', labelled, `${labelled} operator-labelled knowledge item(s); a versioned labelled set needs ≥ 100 per sub-metric`, { labelled }));

  // ESE: promoted dream genomes with a decisive trial / candidates evaluated past headroom; ≥ 10 candidates and ≥ 1 promotion
  const pastHeadroom = trials.filter((t) => t.state !== 'no_headroom').length;
  const promoted = count(`SELECT COUNT(*) FROM maker_genomes g WHERE g.origin = 'dream' AND g.status = 'active' AND EXISTS (SELECT 1 FROM genome_trial_results t WHERE t.trial_id = g.id
    AND ((t.graded_p IS NOT NULL AND t.graded_p < 0.05) OR t.graded_decision = 'promote' OR (t.p < 0.05 AND t.b > t.c)))`) ?? 0;
  const candidates = count("SELECT COUNT(*) FROM maker_genomes WHERE origin = 'dream'") ?? 0;
  const eseDetail = { candidates, past_headroom: pastHeadroom, promoted, note: 'yield per candidate evaluated past headroom (Wilson); search cost per consumer is in GET /api/health/efficiency' };
  metrics.push(pastHeadroom >= 10 && promoted >= 1
    ? metric('ESE', 'ok', pastHeadroom, null, eseDetail, r4(promoted / pastHeadroom), wilson(promoted, pastHeadroom))
    : metric('ESE', 'INSUFFICIENT_EVIDENCE', pastHeadroom, `${promoted} decisive promotion(s), ${pastHeadroom} candidate(s) past headroom; needs ≥ 1 and ≥ 10`, eseDetail));

  // SCIG: VIG gated by constraints with live monitors; policy_violations never written today → not monitored
  const violations = count('SELECT COUNT(*) FROM policy_violations');
  const scigBlockers = [vig.status !== 'ok' ? `VIG ${vig.status}` : '', !violations ? 'policy_violations not monitored (0 rows: no live writer)' : ''].filter(Boolean);
  metrics.push(scigBlockers.length
    ? metric('SCIG', 'INSUFFICIENT_EVIDENCE', vig.n, scigBlockers.join('; '), { policy_violations: violations })
    : metric('SCIG', 'ok', vig.n, null, { policy_violations: violations }, vig.value, vig.ci));

  // ECON: verified per M cloud tokens for the consumer with the most attempts (≥ 20), resource-ledger valuePer interval
  const consumers = (() => { try { return efficiencyView(db, now, env).consumers; } catch { return []; } })()
    .filter((c) => (c.attempts ?? 0) >= 20 && c.per_m_tokens).sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0));
  const top = consumers[0];
  metrics.push(top
    ? metric('ECON', 'ok', top.attempts!, null, { consumer: top.consumer, unit: 'verified per M cloud tokens (7 d)', eligible: consumers.map((c) => ({ consumer: c.consumer, attempts: c.attempts, per_m_tokens: c.per_m_tokens })) },
      top.per_m_tokens!.value, top.per_m_tokens!.low !== null && top.per_m_tokens!.high !== null ? [top.per_m_tokens!.low, top.per_m_tokens!.high] : null)
    : metric('ECON', 'INSUFFICIENT_EVIDENCE', 0, 'no resource-ledger consumer with ≥ 20 attempts and token usage in 7 d', {}));

  return { contract_version: INTELLIGENCE_CONTRACT_VERSION, metrics,
    note: 'Read-only §16 metric statuses (METRIC_CONTRACTS.yaml). ok only at the contract\'s minimum n; INSUFFICIENT_EVIDENCE / UNDEFINED carry value null and the blocker — never 0. No composite score.' };
}
