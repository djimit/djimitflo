import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';

/**
 * H-D5NO (operator 11-10, protocol docs/research/eco/D5NO_PROTOCOL.md): is jev's confident 'no' on proposal_prescreen a
 * valid ASYMMETRIC classifier for rejecting proposals — measured prospectively, never by retuning the rejected JC study
 * (NE-001, PR #779)? Prescreen runs in shadow, so every proposal still reaches the panel and its real outcome is observed.
 * Read-only evidence; nothing here routes, parks or approves.
 */

/** Frozen: shadow switch of TYPESAFE_PROPOSAL_PRESCREEN_MODE (11-10). No env override — the protocol fixes the population. */
export const D5NO_CUTOFF = '2026-10-11T21:00:00.000Z';
/** sha256 of docs/research/eco/D5NO_PROTOCOL.md above its PREREG_SHA256 line (frozen 2026-10-11, before any outcome) */
export const D5NO_PREREG_SHA256 = '2730c749acd68599e779ecbeac9016bca9d3800f5f8b81f2cc196eaa3c314b0e';
export const D5NO_ANALYSIS_N = 100;      // single efficacy analysis at 100 resolved confident-NO cases
export const D5NO_MAX_RISK = 0.05;       // one-sided 95 % Clopper-Pearson upper bound on P(verified | confident-NO)
export const D5NO_DEADLINE_DAYS = 90;    // n not reached by cutoff + 90 d → insufficient_evidence

/** Confident-NO = exactly the rule D5 enforce parked on: proposal_prescreen decided 'no' (self-improvement-auto-review-scheduler). */
export const isConfidentNo = (decision: string | null | undefined): boolean => decision === 'no';

const lchoose = (n: number, k: number) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
const binomCdf = (k: number, n: number, p: number) => {
  let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(lchoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p)); return s;
};
/** Exact one-sided (1−alpha) Clopper-Pearson upper bound for k events in n trials. */
export function clopperPearsonUpper(k: number, n: number, alpha = 0.05): number | null {
  if (n <= 0) return null;
  if (k >= n) return 1;
  let lo = 0, hi = 1;
  for (let t = 0; t < 80; t++) { const m = (lo + hi) / 2; if (binomCdf(k, n, m) > alpha) lo = m; else hi = m; }
  return hi;
}

/** Largest false-rejection count k for which the one-sided bound at n can still fall below D5NO_MAX_RISK (−1 = never). */
export function maxErrorsAllowed(n: number): number {
  let k = -1; while (k + 1 < n && (clopperPearsonUpper(k + 1, n) ?? 1) < D5NO_MAX_RISK) k++; return k;
}
/** Minimum independent clusters for the bound to be able to fall below D5NO_MAX_RISK at all (0 errors). */
export function minClustersForBound(): number { let n = 1; while ((clopperPearsonUpper(0, n) ?? 1) >= D5NO_MAX_RISK) n++; return n; }

// ImprovementStatus (self-improvement-service.ts): not yet settled
const PENDING = new Set(['proposed', 'scheduled', 'executing', 'evaluating', 'applied']);
/** Case outcome: verified = false rejection; infra_failed = censored; rejected / no_change / regressed / needs_more_evidence /
 * needs_grounding / archived = correct rejection; anything still in flight = pending. */
export type CaseOutcome = 'false_rejection' | 'correct_rejection' | 'censored' | 'pending';
export function caseOutcome(statuses: string[]): CaseOutcome {
  if (statuses.includes('verified')) return 'false_rejection';
  if (statuses.some((s) => PENDING.has(s))) return 'pending';
  if (statuses.length > 0 && statuses.every((s) => s === 'infra_failed')) return 'censored';
  return 'correct_rejection';
}

interface Row { id: string; status: string; created_at: string; source: string | null; refs: string | null; description: string | null; decision: string; dup_of: string | null }

const PATH_RE = /(?:[\w@.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|ya?ml|sql)\b/; // same path shape as namedPathsExist

export function d5NoEvidence(db: Database, now = Date.now()) {
  let rows: Row[] = [];
  try {
    rows = db.prepare(`SELECT s.id, s.status, s.created_at, s.source, s.evidence_refs_json AS refs, s.description, j.decision,
        (SELECT substr(d.reason, 12, instr(d.reason || ' ', ' ') - 12) FROM judgments d WHERE d.judgment = 'proposal_near_duplicate'
          AND d.subject_id = s.id AND d.reason LIKE 'similar_to=%' ORDER BY d.created_at LIMIT 1) AS dup_of
      FROM self_improvements s JOIN judgments j ON j.subject_id = s.id AND j.judgment = 'proposal_prescreen' AND j.mode = 'shadow'
      WHERE s.created_at >= ? AND j.created_at >= ?
        AND j.created_at = (SELECT MAX(x.created_at) FROM judgments x WHERE x.judgment = 'proposal_prescreen' AND x.subject_id = s.id)`)
      .all(D5NO_CUTOFF, D5NO_CUTOFF) as Row[];
  } catch { return { status: 'unavailable' as const, cutoff: D5NO_CUTOFF }; }
  const createdAt = (id: string) => (db.prepare('SELECT created_at FROM self_improvements WHERE id = ?').get(id) as { created_at: string } | undefined)?.created_at;
  const linkTargets = (refs: string | null) => {
    try { return (JSON.parse(refs ?? '[]') as string[]).map((r) => /^(?:requeue-of|refinement-of):(.+)$/.exec(r)?.[1]).filter((x): x is string => !!x); } catch { return []; }
  };
  const isOracle = (r: Row) => r.source === 'gap_analysis' && /"(?:test-gap|mutation-gap):/.test(r.refs ?? '');
  const excluded = { pre_cutoff_cluster: 0, oracle_lane: 0 };
  const kept = rows.filter((r) => { if (isOracle(r)) { excluded.oracle_lane++; return false; } return true; }); // oracle lanes skip the panel; D5 never parked them
  // Clusters (#779 rule, operator 11-10): requeue copies, refinements, near-duplicates (cosine ≥ 0.92) and same-target variants
  // (same first named file path) are ONE independent observation. Union-find over those links; a cluster linked to any
  // pre-cutoff proposal belongs to the JC era and is excluded whole.
  const parent = new Map(kept.map((r) => [r.id, r.id]));
  const find = (x: string): string => { const p = parent.get(x)!; if (p === x) return x; const root = find(p); parent.set(x, root); return root; };
  const union = (a: string, b: string) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); };
  const preCutoff = new Set<string>();
  const byTarget = new Map<string, string>();
  for (const r of kept) {
    for (const o of [...linkTargets(r.refs), ...(r.dup_of ? [r.dup_of] : [])]) {
      if (parent.has(o)) union(r.id, o); else { const c = createdAt(o); if (c !== undefined && c < D5NO_CUTOFF) preCutoff.add(r.id); }
    }
    const target = (r.description ?? '').match(PATH_RE)?.[0];
    if (target) { const seen = byTarget.get(target); if (seen) union(r.id, seen); else byTarget.set(target, r.id); }
  }
  const clusters = new Map<string, Row[]>();
  for (const r of kept) { const c = find(r.id); clusters.set(c, [...(clusters.get(c) ?? []), r]); }
  const tainted = new Set([...preCutoff].map(find));
  // A cluster's decision = the prescreen decision of its earliest member (the first screening — the one enforce would have
  // acted on); its outcome is conservative: any verified member ⇒ false rejection (caseOutcome).
  const cases = [...clusters.entries()].filter(([c, members]) => { if (tainted.has(c)) { excluded.pre_cutoff_cluster += members.length; return false; } return true; })
    .map(([c, members]) => { const first = [...members].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      return { id: c, first_created: first.created_at, decision: first.decision, outcome: caseOutcome(members.map((m) => m.status)) }; });
  const tally = (pred: (d: string) => boolean) => {
    const sel = cases.filter((c) => pred(c.decision));
    const n = (o: CaseOutcome) => sel.filter((c) => c.outcome === o).length;
    return { cases: sel.length, false_rejection: n('false_rejection'), correct_rejection: n('correct_rejection'), pending: n('pending'), censored: n('censored') };
  };
  const no = tally(isConfidentNo);
  const resolved = no.false_rejection + no.correct_rejection;
  const upper = clopperPearsonUpper(no.false_rejection, resolved);
  // the single efficacy analysis uses exactly the first D5NO_ANALYSIS_N resolved clusters (by first screening time)
  const analysisSet = cases.filter((c) => isConfidentNo(c.decision) && (c.outcome === 'false_rejection' || c.outcome === 'correct_rejection'))
    .sort((a, b) => a.first_created.localeCompare(b.first_created)).slice(0, D5NO_ANALYSIS_N);
  const analysisErrors = analysisSet.filter((c) => c.outcome === 'false_rejection').length;
  const analysisUpper = analysisSet.length === D5NO_ANALYSIS_N ? clopperPearsonUpper(analysisErrors, D5NO_ANALYSIS_N) : null;
  const pastDeadline = now > Date.parse(D5NO_CUTOFF) + D5NO_DEADLINE_DAYS * 86_400_000;
  // Early REJECT only when the accumulated false rejections make the bound unreachable even at the preregistered maximum n;
  // never early GO.
  const status = analysisErrors > maxErrorsAllowed(D5NO_ANALYSIS_N) ? 'rejected'
    : analysisUpper !== null ? (analysisUpper < D5NO_MAX_RISK ? 'ready' : 'rejected')
    : pastDeadline ? 'insufficient_evidence' : 'collecting';
  const descriptive = (d: string) => { const t = tally((x) => x === d); const settled = t.false_rejection + t.correct_rejection;
    return { ...t, verified_rate: settled ? t.false_rejection / settled : null, ci: settled ? wilson(t.false_rejection, settled) : null }; };
  return {
    status, cutoff: D5NO_CUTOFF, prereg_sha256: D5NO_PREREG_SHA256, analysis_n: D5NO_ANALYSIS_N, max_risk: D5NO_MAX_RISK, excluded,
    min_clusters_for_bound: minClustersForBound(), max_errors_allowed_at_n: maxErrorsAllowed(D5NO_ANALYSIS_N),
    confident_no: { ...no, resolved, false_rejection_upper_95: upper, analysis_n_reached: analysisSet.length, analysis_errors: analysisErrors, analysis_upper_95: analysisUpper },
    // descriptive only — never a routing candidate (NE-001)
    confident_yes: descriptive('yes'), uncertain: descriptive('uncertain'),
    note: 'H-D5NO, prospective; prescreen in shadow. ready = may be proposed to the operator again, never automatic. Not JC (NE-001).',
  };
}
