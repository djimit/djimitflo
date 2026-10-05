import type { Database } from 'better-sqlite3';
import { rng } from './gym-mutants';
import { OUTCOME_SQL } from './improvement-funnel-service';

/**
 * RX-9 / RX-8 (Phase F): honest numbers for two signals that were quoted as headlines. Read-only, fail-soft.
 * - Oracle: the "36/56 agree" checker-second-opinion figure mixed duplicate rows (checker + security checker on one
 *   maker before #583), mechanical disagreements (checker=insufficient_evidence) and no CI. Here: one row per maker,
 *   a 3×3 table, Cohen's kappa with a seeded bootstrap CI, and accuracy of jev and of the checker against the run outcome.
 * - Commons: "0 verified of 737" counted parked parents that can never verify. The like-for-like yield is attempted
 *   refinement children vs the base rate of the same source.
 */
const LABELS = ['accepted', 'needs_revision', 'rejected'] as const;
type Label = typeof LABELS[number];
const EXCLUDE_BEFORE = '2026-09-23T18:30:00Z'; // before #334 the opinion saw an empty diff for new files

export function cohenKappa(table: number[][]): number | null {
  const n = table.flat().reduce((a, b) => a + b, 0);
  if (!n) return null;
  const po = table.reduce((a, row, i) => a + row[i], 0) / n;
  const rows = table.map((r) => r.reduce((a, b) => a + b, 0)); const cols = table[0].map((_, j) => table.reduce((a, r) => a + r[j], 0));
  const pe = rows.reduce((a, r, i) => a + r * cols[i], 0) / (n * n);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

/** Seeded bootstrap 95 % interval of a statistic over paired items (B resamples). */
function bootstrap<T>(items: T[], stat: (s: T[]) => number | null, seed = 42, B = 500): [number, number] | null {
  if (items.length < 2) return null;
  const r = rng(seed); const vals: number[] = [];
  for (let b = 0; b < B; b++) {
    const s = Array.from({ length: items.length }, () => items[Math.floor(r() * items.length)]);
    const v = stat(s); if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.min(vals.length - 1, Math.floor(0.975 * vals.length))]];
}

const binomCdf = (k: number, n: number, p: number): number => {
  let s = 0; let term = (1 - p) ** n; // P(X = 0)
  for (let i = 0; i <= k; i++) { s += term; term *= ((n - i) / (i + 1)) * (p / (1 - p || 1e-300)); }
  return Math.min(1, s);
};
const bisect = (f: (p: number) => number, target: number): number => {
  let lo = 0; let hi = 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
};
/** Exact two-sided 95 % Clopper–Pearson interval for k successes in n. */
export function clopperPearson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const lower = k === 0 ? 0 : bisect((p) => binomCdf(k - 1, n, p), 0.975); // P(X ≥ k) = 0.025
  const upper = k === n ? 1 : bisect((p) => binomCdf(k, n, p), 0.025);
  return [lower, upper];
}

interface OracleRow { jev: Label; checker: Label; conf: number; outcome: number | null }
export interface OracleReport {
  n: number; confusion: Record<Label, Record<Label, number>>; marginals: { jev: Record<Label, number>; checker: Record<Label, number> };
  kappa: number | null; kappa_ci: [number, number] | null;
  agreement: { all: number | null; conf_ge_06: number | null; conf_lt_06: number | null };
  accuracy: { n: number; jev: number | null; checker: number | null };
  kappa_jev_outcome: number | null; kappa_jev_outcome_ci: [number, number] | null; kappa_checker_outcome: number | null;
  enforce_eligible: boolean; note: string;
}

export function oracleAgreement(db: Database): OracleReport {
  let raw: Array<{ subject_id: string; reason: string | null; created_at: string; maker: string | null }> = [];
  try {
    raw = db.prepare(`SELECT j.subject_id, j.reason, j.created_at, json_extract(l.metadata, '$.maker_lease_id') AS maker
      FROM judgments j LEFT JOIN worker_leases l ON l.id = j.subject_id
      WHERE j.judgment = 'checker_second_opinion' AND j.created_at >= ? ORDER BY j.created_at`).all(EXCLUDE_BEFORE) as typeof raw;
  } catch { /* no judgments table */ }
  const byMaker = new Map<string, OracleRow & { subject: string }>();
  for (const r of raw) {
    const m = /jev=(\w+) conf=([\d.]+) checker=(\w+)/.exec(r.reason ?? '');
    if (!m || !LABELS.includes(m[1] as Label) || !LABELS.includes(m[3] as Label)) continue; // insufficient_evidence / none / unknown
    const key = r.maker ?? r.subject_id;
    if (byMaker.has(key)) continue; // one row per maker: the first recorded opinion
    byMaker.set(key, { subject: r.subject_id, jev: m[1] as Label, checker: m[3] as Label, conf: Number(m[2]), outcome: null });
  }
  const rows = [...byMaker.values()];
  for (const r of rows) {
    try { const o = (db.prepare(OUTCOME_SQL.checker_second_opinion).get(r.subject) as { o: number | null } | undefined)?.o; r.outcome = o ?? null; } catch { /* no runs */ }
  }
  const zero = () => Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;
  const confusion = Object.fromEntries(LABELS.map((l) => [l, zero()])) as Record<Label, Record<Label, number>>;
  const mj = zero(); const mc = zero();
  for (const r of rows) { confusion[r.jev][r.checker]++; mj[r.jev]++; mc[r.checker]++; }
  const table = (s: OracleRow[]) => LABELS.map((a) => LABELS.map((b) => s.filter((r) => r.jev === a && r.checker === b).length));
  const rate = (s: OracleRow[]) => (s.length ? s.filter((r) => r.jev === r.checker).length / s.length : null);
  const withOutcome = rows.filter((r) => r.outcome !== null);
  const binary = (s: OracleRow[], who: 'jev' | 'checker') => {
    const t = [[0, 0], [0, 0]]; for (const r of s) t[r[who] === 'accepted' ? 0 : 1][r.outcome === 1 ? 0 : 1]++; return cohenKappa(t);
  };
  const right = (who: 'jev' | 'checker') => (withOutcome.length ? withOutcome.filter((r) => (r[who] === 'accepted') === (r.outcome === 1)).length / withOutcome.length : null);
  const kjo = binary(withOutcome, 'jev'); const kjoCi = bootstrap(withOutcome, (s) => binary(s, 'jev'));
  const kco = binary(withOutcome, 'checker');
  const eligible = rows.length >= 100 && kjoCi !== null && kjoCi[0] >= 0.2 && kjo !== null && kco !== null && kjo >= kco;
  return {
    n: rows.length, confusion, marginals: { jev: mj, checker: mc },
    kappa: cohenKappa(table(rows)), kappa_ci: bootstrap(rows, (s) => cohenKappa(table(s))),
    agreement: { all: rate(rows), conf_ge_06: rate(rows.filter((r) => r.conf >= 0.6)), conf_lt_06: rate(rows.filter((r) => r.conf < 0.6)) },
    accuracy: { n: withOutcome.length, jev: right('jev'), checker: right('checker') },
    kappa_jev_outcome: kjo, kappa_jev_outcome_ci: kjoCi, kappa_checker_outcome: kco,
    enforce_eligible: eligible,
    note: 'one row per maker; excludes checker=insufficient_evidence and rows before 2026-09-23T18:30Z; enforce needs n ≥ 100, kappa(jev,outcome) lower 95 % ≥ 0.2 and ≥ the checker',
  };
}

const POSITIVE = "('verified','evaluating','applied')";
const NEGATIVE = "('archived','regressed','rejected','no_change')";

export function commonsChildren(db: Database) {
  const empty = { children_attempted: 0, children_verified: 0, parents_archived_after_refinement: 0,
    children_by_period: { before_2026_09_29: { attempted: 0, verified: 0 }, from_2026_09_29: { attempted: 0, verified: 0 } } };
  try {
    const kids = db.prepare(`SELECT json_extract(j.answers_json, '$.refinement_id') AS kid, MIN(j.created_at) AS at, s.status AS status
      FROM judgments j LEFT JOIN self_improvements s ON s.id = json_extract(j.answers_json, '$.refinement_id')
      WHERE j.judgment = 'commons_grounding' AND j.decision = 'yes' AND json_extract(j.answers_json, '$.refinement_id') IS NOT NULL
      GROUP BY kid`).all() as Array<{ kid: string; at: string; status: string | null }>;
    const ok = (s: string | null) => s === 'verified' || s === 'applied' || s === 'evaluating';
    const before = kids.filter((k) => k.at < '2026-09-29'); const after = kids.filter((k) => k.at >= '2026-09-29');
    const parents = (db.prepare(`SELECT COUNT(DISTINCT j.subject_id) AS n FROM judgments j JOIN self_improvements p ON p.id = j.subject_id
      WHERE j.judgment = 'commons_grounding' AND json_extract(j.answers_json, '$.refinement_id') IS NOT NULL AND p.status = 'archived'`).get() as { n: number }).n;
    return { children_attempted: kids.length, children_verified: kids.filter((k) => ok(k.status)).length, parents_archived_after_refinement: parents,
      children_by_period: { before_2026_09_29: { attempted: before.length, verified: before.filter((k) => ok(k.status)).length },
        from_2026_09_29: { attempted: after.length, verified: after.filter((k) => ok(k.status)).length } } };
  } catch { return empty; }
}

/** K/N of attempted Commons children vs the base rate of the same source ('refinement'); a verdict only with N ≥ 30. */
export function commonsYield(db: Database) {
  const c = commonsChildren(db);
  const k = c.children_verified; const n = c.children_attempted;
  let base: { k: number; n: number } = { k: 0, n: 0 };
  try {
    base = db.prepare(`SELECT SUM(status IN ${POSITIVE}) AS k, SUM(status IN ${POSITIVE} OR status IN ${NEGATIVE}) AS n FROM self_improvements WHERE source = 'refinement'`).get() as typeof base;
  } catch { /* no table */ }
  const ci = clopperPearson(k, n); const baseCi = clopperPearson(base.k ?? 0, base.n ?? 0);
  const below = n >= 30 && (base.n ?? 0) > 0 && ci[1] < baseCi[0];
  return { k, n, rate: n ? k / n : null, ci, base_rate: base.n ? (base.k ?? 0) / base.n : null, base_ci: baseCi, base_n: base.n ?? 0,
    verdict: below ? 'below system' : 'unmeasured', note: 'children = attempted refinements from valid Commons groundings; parked parents are not trials' };
}
