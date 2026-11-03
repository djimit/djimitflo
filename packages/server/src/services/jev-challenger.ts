import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';
import { challengerModel, challengerSample } from './judgment-service';
import { typesafeModel } from './typesafe-client';

/**
 * JEV-114 evidence (`evolution-evidence.jev_challenger`): the paired shadow of JEV_CHALLENGER_MODEL next to the pinned jev
 * model. A pair = one `<judgment>@<model>` shadow row and the primary `<judgment>` row on the same subject and state_hash
 * (both non-error). Per judgment: decision-level agreement (yes / no / uncertain identical) with Wilson 95 %, and accuracy of
 * each side against the ground truth that exists for it:
 *   names_file      — proposal_prescreen: names_file Noul ≥ 0.5 vs the deterministic PATH_RE label on the description (JC-001 §1.5)
 *   d5_operator     — proposal_prescreen: the operator's D5 label on a rejection ('ok' = 'no' was right, 'wrong' = it was not)
 *   relevance_blind — discovery_relevance: the blind DI-001 labels (#835; relevant / not_relevant, 'unclear' left out); an
 *                     'uncertain' verdict is an abstention, never counted as wrong (E2)
 * Every rate is null with status 'insufficient' below MIN_N pairs — never 0. Read-only; nothing here routes or decides.
 */
export const JEV_CHALLENGER_MIN_N = 20;
const PATH_RE = /(?:[\w@.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|ya?ml|sql)\b/; // same path shape as namedPathsExist

export interface ChallengerRate { k: number; n: number; rate: number | null; ci_low: number | null; ci_high: number | null; status: 'ok' | 'insufficient' }
export interface ChallengerTruth { primary: ChallengerRate; challenger: ChallengerRate; abstained?: { primary: number; challenger: number } }
export interface JevChallengerEvidence {
  mode: 'off' | 'shadow'; model: string | null; primary_model: string; sample: number; min_n: number; status: 'ok' | 'insufficient';
  by_judgment: Array<{ judgment: string; model: string; n_pairs: number; n_errors: number; agreement: ChallengerRate;
    ground_truth: { names_file: ChallengerTruth | null; d5_operator: ChallengerTruth | null; relevance_blind: ChallengerTruth | null } }>;
  note: string;
}

export function challengerRate(k: number, n: number, minN = JEV_CHALLENGER_MIN_N): ChallengerRate {
  if (n < minN) return { k, n, rate: null, ci_low: null, ci_high: null, status: 'insufficient' };
  const [lo, hi] = wilson(k, n);
  return { k, n, rate: +(k / n).toFixed(4), ci_low: lo, ci_high: hi, status: 'ok' };
}

interface Pair { name: string; sid: string; cd: string; ca: string | null; pd: string; pa: string | null; description: string | null }
const noulOf = (json: string | null, key: string): number | null => {
  try { const v = (JSON.parse(json ?? '{}') as Record<string, { noul?: unknown }>)[key]?.noul; return typeof v === 'number' && Number.isFinite(v) ? v : null; } catch { return null; }
};

export function jevChallengerEvidence(db: Database, env: NodeJS.ProcessEnv = process.env): JevChallengerEvidence {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const model = challengerModel(env);
  // the primary row of a pair: same base judgment, subject and state_hash; the first one wins per challenger row
  const rows = all<Pair & { cid: number }>(`SELECT c.rowid AS cid, c.judgment AS name, c.subject_id AS sid, c.decision AS cd, c.answers_json AS ca,
      p.decision AS pd, p.answers_json AS pa, s.description AS description
    FROM judgments c
    JOIN judgments p ON p.judgment = substr(c.judgment, 1, instr(c.judgment, '@') - 1) AND p.subject_type = c.subject_type AND p.subject_id = c.subject_id
      AND p.state_hash = c.state_hash AND p.decision <> 'error'
    LEFT JOIN self_improvements s ON s.id = c.subject_id AND c.subject_type = 'self_improvement'
    WHERE instr(c.judgment, '@') > 0 AND c.judgment NOT LIKE '%@local' AND c.mode = 'shadow' AND c.decision <> 'error'
    ORDER BY c.rowid, p.rowid`);
  const seen = new Set<number>(); const pairs: Pair[] = [];
  for (const r of rows) if (!seen.has(r.cid)) { seen.add(r.cid); pairs.push(r); }
  const errors = new Map(all<{ name: string; n: number }>(`SELECT judgment AS name, COUNT(*) AS n FROM judgments
    WHERE instr(judgment, '@') > 0 AND judgment NOT LIKE '%@local' AND mode = 'shadow' AND decision = 'error' GROUP BY 1`).map((r) => [r.name, r.n]));

  // D5 operator labels (latest per proposal) and blind relevance labels (first decisive label per ref)
  const d5 = new Map(all<{ sid: string; d: string }>(`SELECT subject_id AS sid, decision AS d FROM judgments
    WHERE judgment = 'operator_label' AND state_hash = 'proposal_prescreen' ORDER BY created_at, rowid`).map((r) => [r.sid, r.d]));
  const relevance = new Map<string, string>();
  for (const r of all<{ ref: string; d: string }>(`SELECT subject_id AS ref, decision AS d FROM judgments
    WHERE judgment = 'operator_label' AND state_hash = 'discovery_relevance' AND decision IN ('yes', 'no') ORDER BY created_at, rowid`)) if (!relevance.has(r.ref)) relevance.set(r.ref, r.d);
  const aliasOf = new Map<string, string>();
  if (relevance.size) for (const u of all<{ id: string; aliases_json: string | null }>(`SELECT id, aliases_json FROM expert_identities WHERE kind IN ('paper', 'repository')`)) {
    try { const a = JSON.parse(u.aliases_json ?? '[]') as unknown[]; if (typeof a[0] === 'string') aliasOf.set(u.id, a[0]); } catch { /* malformed row: no alias */ }
  }

  const truth = (list: Pair[], label: (p: Pair) => boolean | null, correct: (decision: string, answers: string | null, y: boolean) => boolean | null): ChallengerTruth => {
    let kp = 0, kc = 0, ap = 0, ac = 0, np = 0, nc = 0;
    for (const p of list) {
      const y = label(p); if (y === null) continue;
      const okp = correct(p.pd, p.pa, y), okc = correct(p.cd, p.ca, y);
      if (okp === null) ap += 1; else { np += 1; if (okp) kp += 1; }
      if (okc === null) ac += 1; else { nc += 1; if (okc) kc += 1; }
    }
    return { primary: challengerRate(kp, np), challenger: challengerRate(kc, nc), abstained: { primary: ap, challenger: ac } };
  };

  const byName = new Map<string, Pair[]>();
  for (const p of pairs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const name of errors.keys()) if (!byName.has(name)) byName.set(name, []);
  const by_judgment = [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, list]) => {
    const at = name.indexOf('@'); const base = name.slice(0, at);
    const prescreen = base === 'proposal_prescreen';
    return {
      judgment: base, model: name.slice(at + 1), n_pairs: list.length, n_errors: errors.get(name) ?? 0,
      agreement: challengerRate(list.filter((p) => p.cd === p.pd).length, list.length),
      ground_truth: {
        names_file: prescreen ? truth(list, (p) => (p.description == null ? null : PATH_RE.test(p.description)), (_d, a, y) => {
          const v = noulOf(a, 'names_file'); return v === null ? null : (v >= 0.5) === y;
        }) : null,
        d5_operator: prescreen ? truth(list, (p) => (d5.has(p.sid) ? d5.get(p.sid) === 'yes' : null), (d, _a, y) => (y ? d === 'no' : d !== 'no')) : null,
        relevance_blind: base === 'discovery_relevance' ? truth(list, (p) => { const l = relevance.get(aliasOf.get(p.sid) ?? p.sid); return l === undefined ? null : l === 'yes'; },
          (d, _a, y) => (d === 'yes' || d === 'no' ? (d === 'yes') === y : null)) : null,
      },
    };
  });
  return {
    mode: model ? 'shadow' : 'off', model, primary_model: typesafeModel(), sample: challengerSample(env), min_n: JEV_CHALLENGER_MIN_N,
    status: by_judgment.some((j) => j.agreement.status === 'ok') ? 'ok' : 'insufficient', by_judgment,
    note: 'paired shadow (JEV_CHALLENGER_MODEL): <judgment>@<model> rows vs the primary row on the same subject + state_hash, all time. agreement = identical decision; names_file = Noul ≥ 0.5 vs PATH_RE on the description; d5_operator = the D5 label on a rejection (only primary-no subjects are labelled); relevance_blind = DI-001 blind labels, uncertain = abstained. Rates null below min_n. Never feeds a decision (NE-001).',
  };
}
