import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Funnel → learning phase 3 / Phase E2 (operator-approved 08-10): attributable outcomes.
 * Every learner read verified/regressed, but 30 of 45 regressions (30 d) were a missing reviewer verdict after a COMPLETED
 * maker — asymmetric label noise ρ ≈ 0.32–0.42 on the maker's reward. A settled run is now attributed to one class:
 *   maker_failure       — the maker's own work failed (checks, diff limit, scope) or a reviewer that ran said no
 *   reviewer_failure    — the maker completed but no reviewer verdict came back (timeout, token budget, unparsed, insufficient_evidence)
 *   environment_failure — the maker never ran / crashed without a change / a check's tool was missing / worktree gone / no change
 *   verified            — every gate passed (`survived` comes later from merge survival)
 * OUTCOME_ATTRIBUTION_ENABLED (default off): record the class per settled run (an `outcome_attribution` judgment, mode
 * 'annotation'), credit contributors of verified runs, and let maker-side learners (bandit, fitness view, memory-rule fitness,
 * genome evidence, earned autonomy) count only maker_failure as a failure. self_improvements.status is never changed.
 */
export type OutcomeClass = 'maker_failure' | 'reviewer_failure' | 'environment_failure' | 'verified';
const CLASSES: readonly string[] = ['maker_failure', 'reviewer_failure', 'environment_failure', 'verified'];
export const outcomeAttributionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.OUTCOME_ATTRIBUTION_ENABLED === 'true';

export interface MakerMeta {
  failure_reason?: string; timed_out?: boolean; runtime_timed_out?: boolean; exit_status?: number | null; completed_at?: string;
  changed_files?: unknown; deterministic_checks?: Array<{ exit_status?: number | null }>;
}
export interface AttributionLease { id?: string; role: string; status: string; metadata: MakerMeta & { verdict?: unknown; maker_lease_id?: unknown } }
export interface AttributionRun {
  /** names of the gates that failed (`name` or `name: evidence`, as in loop_runs.metadata.failed_gates) */
  failed_gates: string[];
  /** the active (non-superseded) maker lease, if any */
  maker: AttributionLease | null;
  reviewers: AttributionLease[];
  /** existing outcome_attribution judgments for the run or its proposal (operator annotations win, newest first) */
  annotations?: Array<{ decision: string; created_at: string }>;
  pr_outcome?: { survived?: boolean } | null;
}
export interface Attribution { outcome: OutcomeClass; survived: boolean | null; reason: string }

/** A3/EV3 (moved from loop-daemon runOutcomeOnFailure, unchanged): why a maker lease's run failed, from its metadata alone. */
export function makerFailureClass(meta: MakerMeta): 'regressed' | 'infra_failed' | 'no_change' {
  if (meta.timed_out || meta.runtime_timed_out || /runtime_contract/.test(meta.failure_reason ?? '')) return 'infra_failed';
  if (/maker_runtime_exit_zero/.test(meta.failure_reason ?? '')) return Array.isArray(meta.changed_files) && meta.changed_files.length ? 'regressed' : 'infra_failed';
  if (meta.exit_status === undefined && !meta.completed_at) return 'infra_failed'; // the maker never ran
  if ((meta.deterministic_checks ?? []).some((c) => c?.exit_status === 127)) return 'infra_failed'; // a check's tool was missing
  if (Array.isArray(meta.changed_files) && meta.changed_files.length === 0) return 'no_change';
  return 'regressed';
}

const MAKER_GATES = new Set(['tests_lint_typecheck', 'diff_threshold_all_makers', 'auto_approved_scope']);
const REVIEW_GATES: Record<string, string> = { checker_verdict: 'checker', security_checker_verdict: 'security_checker', maker_checker_separation: 'checker' };
const ENV_GATES = new Set(['worktree_isolation', 'assignment_file_present', 'run_not_cancelled']);
const REJECTING = new Set(['rejected', 'needs_revision']);

/** Pure: the class of one settled run. */
export function attributeOutcome(run: AttributionRun): Attribution {
  const survived = typeof run.pr_outcome?.survived === 'boolean' ? run.pr_outcome.survived : null;
  const note = [...(run.annotations ?? [])].filter((a) => CLASSES.includes(a.decision)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (note) return { outcome: note.decision as OutcomeClass, survived, reason: 'annotation' };
  const gates = new Set(run.failed_gates.map((g) => g.split(':')[0].trim()).filter(Boolean));
  if (gates.size === 0) return { outcome: 'verified', survived, reason: 'all gates passed' };
  const maker = run.maker;
  if (!maker) return { outcome: 'environment_failure', survived, reason: 'no maker lease' };
  const makerClass = makerFailureClass(maker.metadata);
  if (maker.status !== 'completed') {
    return makerClass === 'regressed' ? { outcome: 'maker_failure', survived, reason: `maker ${maker.status} after changing files` }
      : { outcome: 'environment_failure', survived, reason: `maker ${maker.status} (${makerClass})` };
  }
  if (makerClass === 'infra_failed') return { outcome: 'environment_failure', survived, reason: 'maker completed but its run was infra (missing tool / timeout)' };
  if (makerClass === 'no_change') return { outcome: 'environment_failure', survived, reason: 'maker changed nothing' };
  const makerGate = [...gates].find((g) => MAKER_GATES.has(g));
  if (makerGate) return { outcome: 'maker_failure', survived, reason: `gate ${makerGate} failed` };
  const forMaker = run.reviewers.filter((r) => r.metadata.maker_lease_id === undefined || r.metadata.maker_lease_id === maker.id);
  const reviewGates = [...gates].filter((g) => REVIEW_GATES[g]);
  const rejected = forMaker.find((r) => reviewGates.some((g) => REVIEW_GATES[g] === r.role) && r.status === 'completed' && REJECTING.has(String(r.metadata.verdict)));
  if (rejected) return { outcome: 'maker_failure', survived, reason: `${rejected.role} verdict ${String(rejected.metadata.verdict)}` };
  const envGate = [...gates].find((g) => ENV_GATES.has(g));
  if (envGate) return { outcome: 'environment_failure', survived, reason: `gate ${envGate} failed` };
  if (reviewGates.length) return { outcome: 'reviewer_failure', survived, reason: `maker completed; no ${reviewGates.join('/')} verdict (reviewer missing, failed or inconclusive)` };
  return { outcome: 'maker_failure', survived, reason: `unclassified gate(s): ${[...gates].join(', ')}` };
}

/**
 * SQL predicate: the loop run `runExpr` carries a reviewer/environment attribution — on the run itself, or (operator
 * annotations of 08-10) on its proposal, made after the run started (a requeued run of the same proposal is not covered).
 * Returns `0` when the flag is off, so callers keep their old query.
 */
export function nonMakerRunSql(runExpr: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!outcomeAttributionEnabled(env)) return '0';
  return `EXISTS (SELECT 1 FROM judgments oa WHERE oa.judgment = 'outcome_attribution' AND oa.decision IN ('reviewer_failure', 'environment_failure')
    AND ((oa.subject_type = 'loop_run' AND oa.subject_id = ${runExpr})
      OR (oa.subject_type = 'self_improvement' AND EXISTS (SELECT 1 FROM loop_runs oar JOIN goals oag ON oag.id = oar.goal_id
        WHERE oar.id = ${runExpr} AND oag.improvement_id = oa.subject_id AND oar.created_at <= oa.created_at))))`;
}

const parse = (s: string | null | undefined): Record<string, unknown> => { try { return JSON.parse(s || '{}') as Record<string, unknown>; } catch { return {}; } };

/** The attribution inputs of one run from the database (failed gates from `failedGates` when the caller has them). */
export function attributionInputForRun(db: Database, runId: string, makerLeaseId: string | null, failedGates?: string[]): AttributionRun {
  const run = db.prepare('SELECT r.metadata, r.created_at, g.improvement_id FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id WHERE r.id = ?').get(runId) as { metadata: string; created_at: string; improvement_id: string | null } | undefined;
  const meta = parse(run?.metadata);
  const leases = (db.prepare('SELECT id, role, status, metadata FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ id: string; role: string; status: string; metadata: string }>)
    .map((l) => ({ id: l.id, role: l.role, status: l.status, metadata: parse(l.metadata) as AttributionLease['metadata'] }));
  let annotations: Array<{ decision: string; created_at: string }> = [];
  try {
    // a proposal-level annotation covers only runs that started before it (a requeued run is judged on its own)
    annotations = db.prepare(`SELECT decision, created_at FROM judgments WHERE judgment = 'outcome_attribution'
      AND ((subject_type = 'loop_run' AND subject_id = ?) OR (subject_type = 'self_improvement' AND subject_id = ? AND created_at >= ?))`).all(runId, run?.improvement_id ?? '', run?.created_at ?? '') as typeof annotations;
  } catch { /* judgments absent */ }
  return {
    failed_gates: failedGates ?? (Array.isArray(meta.failed_gates) ? meta.failed_gates.map(String) : []),
    maker: leases.find((l) => l.id === makerLeaseId) ?? leases.filter((l) => l.role === 'maker').pop() ?? null,
    reviewers: leases.filter((l) => l.role === 'checker' || l.role === 'security_checker'),
    annotations,
    pr_outcome: (meta.pr_outcome as { survived?: boolean } | undefined) ?? null,
  };
}

/**
 * Record the attribution of a newly settled run (once per run) and, for a verified run, its credited contributors.
 * Behind OUTCOME_ATTRIBUTION_ENABLED; best-effort (never throws). Never touches self_improvements.status.
 */
export function recordOutcomeAttribution(db: Database, runId: string, makerLeaseId: string | null, failedGates?: string[], env: NodeJS.ProcessEnv = process.env): Attribution | null {
  if (!outcomeAttributionEnabled(env)) return null;
  try {
    if (db.prepare("SELECT 1 FROM judgments WHERE judgment = 'outcome_attribution' AND subject_type = 'loop_run' AND subject_id = ? LIMIT 1").get(runId)) return null;
    const input = attributionInputForRun(db, runId, makerLeaseId, failedGates);
    const a = attributeOutcome(input);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'outcome_attribution', 'loop_run', ?, ?, 'annotation', ?, ?, ?, ?)`)
      .run(randomUUID(), runId, a.outcome, a.outcome, a.reason.slice(0, 300), JSON.stringify({ computed: true, failed_gates: input.failed_gates.map((g) => g.split(':')[0]) }), new Date().toISOString());
    if (a.outcome === 'verified') recordCredits(db, runId, input.maker?.id ?? makerLeaseId);
    return a;
  } catch { return null; } // learning bookkeeping must never break the daemon
}

// ---- contributor credit (E2, first version) ----

export type CreditKind = 'maker' | 'reviewer' | 'model' | 'genome' | 'memory_rule' | 'example' | 'knowledge' | 'judgment';
export function ensureCreditTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS outcome_credits (run_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, kind, ref))`);
}

const KNOWLEDGE_REF = /^(kb|kb_page|okf|knowledge|expert|expert_claim|claim):/;

/** What a verified run's contributors were — maker species + model + genome, accepting reviewers, rules/examples, knowledge, gating judgments. */
export function creditedContributors(db: Database, runId: string, makerLeaseId: string | null): Array<{ kind: CreditKind; ref: string }> {
  const out: Array<{ kind: CreditKind; ref: string }> = [];
  const leases = db.prepare('SELECT id, role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ id: string; role: string; runtime: string; status: string; metadata: string }>;
  const maker = leases.find((l) => l.id === makerLeaseId) ?? leases.filter((l) => l.role === 'maker').pop();
  if (maker) {
    const m = parse(maker.metadata) as { model?: unknown; genome?: { id?: unknown }; genome_id?: unknown };
    const model = typeof m.model === 'string' ? m.model : '';
    out.push({ kind: 'maker', ref: model ? `${maker.runtime}@${model}` : maker.runtime });
    if (model) out.push({ kind: 'model', ref: model });
    if (typeof m.genome?.id === 'string') out.push({ kind: 'genome', ref: m.genome.id });
    if (typeof m.genome_id === 'string') out.push({ kind: 'genome', ref: `strategy:${m.genome_id}` });
  }
  for (const l of leases.filter((x) => (x.role === 'checker' || x.role === 'security_checker') && x.status === 'completed')) {
    const m = parse(l.metadata) as { verdict?: unknown; model?: unknown; maker_lease_id?: unknown };
    if (m.verdict !== 'accepted' || (maker && m.maker_lease_id !== undefined && m.maker_lease_id !== maker.id)) continue;
    out.push({ kind: 'reviewer', ref: `${l.role}:${l.runtime}${typeof m.model === 'string' ? `@${m.model}` : ''}` });
  }
  try {
    const ev = db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = ? AND event_type = 'assignment_context' ORDER BY created_at DESC LIMIT 1").get(runId) as { metadata: string } | undefined;
    const m = parse(ev?.metadata) as { rule_ids?: unknown; examples?: unknown };
    for (const id of Array.isArray(m.rule_ids) ? m.rule_ids : []) if (typeof id === 'string') out.push({ kind: 'memory_rule', ref: id });
    for (const e of Array.isArray(m.examples) ? m.examples : []) if (typeof e === 'string') out.push({ kind: 'example', ref: e.split(' — ')[0] });
  } catch { /* no events */ }
  const improvement = (db.prepare('SELECT g.improvement_id AS id FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE r.id = ?').get(runId) as { id: string | null } | undefined)?.id ?? null;
  if (improvement) {
    try {
      const refs = (db.prepare('SELECT evidence_refs_json AS r FROM self_improvements WHERE id = ?').get(improvement) as { r: string | null } | undefined)?.r;
      const list = refs ? JSON.parse(refs) as unknown : [];
      for (const r of Array.isArray(list) ? list : []) if (typeof r === 'string' && KNOWLEDGE_REF.test(r)) out.push({ kind: 'knowledge', ref: r });
    } catch { /* malformed refs */ }
  }
  try {
    // judgments that gated it: enforce-mode decisions on the run or its proposal that let it through
    const js = db.prepare(`SELECT DISTINCT judgment FROM judgments WHERE mode = 'enforce' AND decision IN ('yes', 'uncertain') AND judgment <> 'outcome_attribution'
      AND ((subject_type = 'loop_run' AND subject_id = ?) OR (subject_type = 'self_improvement' AND subject_id = ?))`).all(runId, improvement ?? '') as Array<{ judgment: string }>;
    for (const j of js) out.push({ kind: 'judgment', ref: j.judgment });
  } catch { /* judgments absent */ }
  return out;
}

export function recordCredits(db: Database, runId: string, makerLeaseId: string | null): number {
  ensureCreditTable(db);
  const ins = db.prepare('INSERT OR IGNORE INTO outcome_credits (run_id, kind, ref, created_at) VALUES (?, ?, ?, ?)');
  const at = new Date().toISOString();
  return creditedContributors(db, runId, makerLeaseId).reduce((n, c) => n + ins.run(runId, c.kind, c.ref, at).changes, 0);
}

/** GET /api/health/attribution: counts per class (window), merge survival of attributed-verified runs, top credited contributors. */
export function attributionSummary(db: Database, now = Date.now(), days = 30, env: NodeJS.ProcessEnv = process.env) {
  const since = new Date(now - Math.min(90, Math.max(1, Math.floor(days) || 30)) * 86_400_000).toISOString();
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const by = all<{ outcome: string; source: string; n: number }>(`SELECT decision AS outcome, CASE WHEN subject_type = 'loop_run' THEN 'computed' ELSE 'operator' END AS source, COUNT(*) AS n
    FROM judgments WHERE judgment = 'outcome_attribution' AND created_at >= ? GROUP BY 1, 2 ORDER BY 1, 2`, since);
  const classes: Record<OutcomeClass, number> = { maker_failure: 0, reviewer_failure: 0, environment_failure: 0, verified: 0 };
  for (const r of by) if (r.outcome in classes) classes[r.outcome as OutcomeClass] += r.n;
  const survived = all<{ survived: number | null; n: number }>(`SELECT json_extract(r.metadata, '$.pr_outcome.survived') AS survived, COUNT(*) AS n FROM judgments j JOIN loop_runs r ON r.id = j.subject_id
    WHERE j.judgment = 'outcome_attribution' AND j.subject_type = 'loop_run' AND j.decision = 'verified' AND j.created_at >= ?
      AND json_extract(r.metadata, '$.pr_outcome.settled_at') IS NOT NULL GROUP BY 1`, since);
  const top = all<{ kind: string; ref: string; credits: number }>(`SELECT kind, ref, COUNT(*) AS credits FROM outcome_credits WHERE created_at >= ?
    GROUP BY 1, 2 ORDER BY credits DESC, kind, ref LIMIT 30`, since);
  return {
    at: new Date(now).toISOString(), enabled: outcomeAttributionEnabled(env), since, classes, by_source: by,
    survived: { yes: survived.filter((s) => s.survived === 1).reduce((a, s) => a + s.n, 0), no: survived.filter((s) => s.survived === 0).reduce((a, s) => a + s.n, 0) },
    credited_runs: all<{ n: number }>('SELECT COUNT(DISTINCT run_id) AS n FROM outcome_credits WHERE created_at >= ?', since)[0]?.n ?? 0,
    top_contributors: top,
    note: 'learners count only maker_failure as a failure when OUTCOME_ATTRIBUTION_ENABLED=true; reviewer/environment failures are neither success nor failure',
  };
}
