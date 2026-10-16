import type { Database } from 'better-sqlite3';
import { wilson } from './evolution-estimators';

/**
 * K1: what knowledge was worth, measured from evolution outcomes that already exist. Read-only (no flag): nothing is
 * written, nothing is deleted, and the decay is computed, never applied to a row.
 *
 * Use edges (item → loop run), each read from a concrete field:
 *   - self_improvements.evidence_refs_json knowledge refs (kb:/expert_unit:/expert_claim:/okf: …) → the proposal's runs
 *   - kb_retrieval judgments on a specialist_panel → self_improvements.panel_id → the proposal's runs
 *   - memory_access_log reads (agent_id 'loop-maker:<run>', assignment-context.ts) → that run
 *   - maker_genomes.knowledge_refs_json (#727) → runs whose maker lease ran that genome (metadata.genome_id)
 *   - outcome_credits kind knowledge / memory_rule (#707) → that run
 *   - an expert unit used by a run also credits the discovery it was made from (expert_identities.provenance_json.ref, E3)
 * Only maker-attributable outcomes count: an outcome_attribution of `verified` (n_verified) or `maker_failure`
 * (n_regressed); reviewer/environment failures and unattributed runs credit nobody. n < 5 → insufficient, never 0.
 */
export type FitnessKind = 'kb_page' | 'expert_unit' | 'expert_claim' | 'discovery' | 'memory_rule' | 'knowledge';
export type FitnessStatus = 'used_with_value' | 'used_no_value' | 'unused' | 'insufficient';
export const FITNESS_KINDS: readonly FitnessKind[] = ['kb_page', 'expert_unit', 'expert_claim', 'discovery', 'memory_rule', 'knowledge'];
export const FITNESS_MIN_N = 5;
export const FITNESS_HALF_LIFE_DAYS = 30;
const WINDOW_DAYS = 90;
const CLASSES = new Set(['maker_failure', 'reviewer_failure', 'environment_failure', 'verified']);

export interface FitnessItem {
  kind: FitnessKind; id: string; title: string | null;
  n_used: number; n_verified: number; n_regressed: number;
  /** verified runs whose PR survived the 14-day merge window; null when none of them has settled yet */
  n_survived_14d: number | null;
  wilson: [number, number] | null; last_used_at: string | null;
  /** verified share of the attributable uses, each weighted 0.5^(age/30 d); null without attributable uses */
  decayed_verified_rate: number | null;
  status: FitnessStatus;
}
export interface KindCounts { kind: FitnessKind; inventory: number | null; used_with_value: number; used_no_value: number; insufficient: number; unused: number | null }
export interface KnowledgeFitness {
  at: string; window_days: number; half_life_days: number; min_n: number;
  /** verified share of all maker-attributable runs in the window — the bar an item is compared with */
  baseline: { n: number; verified_rate: number | null };
  runs: { in_window: number; maker_attributable: number; non_maker: number; unattributed: number };
  by_kind: KindCounts[];
  top: FitnessItem[];
  rule: string;
  writes: 0;
}

const parseList = (s: string | null | undefined): unknown[] => { try { const v = JSON.parse(s || '[]') as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };

/** Pure: a proposal/credit ref → a fitness item key, or null when it names no knowledge. */
export function knowledgeItem(ref: string): { kind: FitnessKind; id: string } | null {
  const m = /^(kb|kb_page|expert_unit|expert_claim|claim|okf|knowledge|expert):(.+)$/.exec(ref.trim());
  if (!m) return null;
  if (m[1] === 'kb' || m[1] === 'kb_page') return { kind: 'kb_page', id: m[2] };
  if (m[1] === 'expert_unit') return { kind: 'expert_unit', id: m[2] };
  if (m[1] === 'expert_claim' || m[1] === 'claim') return { kind: 'expert_claim', id: m[2] };
  return { kind: 'knowledge', id: ref.trim() };
}

/** Pure: the status of one item from its counts (n = attributable uses). */
export function fitnessStatus(nUsed: number, nVerified: number, nRegressed: number, baselineRate: number | null): FitnessStatus {
  if (nUsed === 0) return 'unused';
  const n = nVerified + nRegressed;
  if (n < FITNESS_MIN_N || baselineRate === null) return 'insufficient';
  return nVerified > 0 && nVerified / n >= baselineRate ? 'used_with_value' : 'used_no_value';
}

export function knowledgeFitness(db: Database, now = Date.now(), topN = 20): KnowledgeFitness {
  const all = <T>(sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();

  // ---- runs in the window and their maker-attributable outcome ----
  const runs = new Map(all<{ id: string; pid: string | null; created_at: string; survived: number | null }>(`SELECT r.id, g.improvement_id AS pid, r.created_at,
      json_extract(r.metadata, '$.pr_outcome.survived') AS survived FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id WHERE r.created_at >= ?`, since).map((r) => [r.id, r]));
  const runsByProposal = new Map<string, string[]>();
  for (const r of runs.values()) if (r.pid) runsByProposal.set(r.pid, [...(runsByProposal.get(r.pid) ?? []), r.id]);
  // newest attribution wins: the run's own, or an operator annotation on its proposal made after the run started (outcome-attribution.ts)
  const cls = new Map<string, { decision: string; at: string }>();
  const take = (runId: string, decision: string, at: string) => { const cur = cls.get(runId); if (CLASSES.has(decision) && (!cur || at > cur.at)) cls.set(runId, { decision, at }); };
  for (const j of all<{ type: string; sid: string; decision: string; at: string }>(`SELECT subject_type AS type, subject_id AS sid, decision, created_at AS at FROM judgments
      WHERE judgment = 'outcome_attribution' AND subject_type IN ('loop_run', 'self_improvement')`)) {
    if (j.type === 'loop_run') { if (runs.has(j.sid)) take(j.sid, j.decision, j.at); continue; }
    for (const id of runsByProposal.get(j.sid) ?? []) if (runs.get(id)!.created_at <= j.at) take(id, j.decision, j.at);
  }
  const outcome = (runId: string): 'verified' | 'regressed' | null => {
    const d = cls.get(runId)?.decision; return d === 'verified' ? 'verified' : d === 'maker_failure' ? 'regressed' : null;
  };
  let attributable = 0; let verifiedRuns = 0; let nonMaker = 0;
  for (const id of runs.keys()) { const o = outcome(id); if (o) { attributable++; if (o === 'verified') verifiedRuns++; } else if (cls.has(id)) nonMaker++; }
  const baselineRate = attributable ? verifiedRuns / attributable : null;

  // ---- use edges ----
  const uses = new Map<string, Set<string>>(); // `${kind}\u0000${id}` → run ids
  const use = (kind: FitnessKind, id: string, runId: string) => {
    if (!id || !runs.has(runId)) return;
    const key = `${kind}\u0000${id}`; uses.set(key, (uses.get(key) ?? new Set()).add(runId));
  };
  const useRef = (ref: unknown, runId: string) => { if (typeof ref === 'string') { const k = knowledgeItem(ref); if (k) use(k.kind, k.id, runId); } };
  for (const p of all<{ id: string; refs: string | null }>('SELECT id, evidence_refs_json AS refs FROM self_improvements WHERE id IN (SELECT g.improvement_id FROM goals g JOIN loop_runs r ON r.goal_id = g.id WHERE r.created_at >= ?)', since)) {
    for (const ref of parseList(p.refs)) for (const runId of runsByProposal.get(p.id) ?? []) useRef(ref, runId);
  }
  for (const k of all<{ pid: string; reason: string | null }>(`SELECT s.id AS pid, j.reason FROM judgments j JOIN self_improvements s ON s.panel_id = j.subject_id
      WHERE j.judgment = 'kb_retrieval' AND j.subject_type = 'specialist_panel'`)) {
    const pages = (k.reason ?? '').split(' ').map((h) => h.replace(/@[\d.]+$/, '')).filter(Boolean);
    for (const runId of runsByProposal.get(k.pid) ?? []) for (const page of pages) use('kb_page', page, runId);
  }
  for (const a of all<{ cid: string; agent: string }>("SELECT candidate_id AS cid, agent_id AS agent FROM memory_access_log WHERE agent_id LIKE 'loop-maker:%' AND accessed_at >= ?", since)) {
    use('memory_rule', a.cid, a.agent.slice('loop-maker:'.length));
  }
  for (const g of all<{ run: string; refs: string | null }>(`SELECT l.loop_run_id AS run, m.knowledge_refs_json AS refs FROM worker_leases l
      JOIN maker_genomes m ON m.id = json_extract(l.metadata, '$.genome_id') WHERE l.role = 'maker' AND m.knowledge_refs_json IS NOT NULL AND l.created_at >= ?`, since)) {
    for (const ref of parseList(g.refs)) if (typeof ref === 'string') use('expert_unit', ref, g.run);
  }
  for (const c of all<{ run: string; kind: string; ref: string }>("SELECT run_id AS run, kind, ref FROM outcome_credits WHERE kind IN ('knowledge', 'memory_rule')")) {
    if (c.kind === 'memory_rule') use('memory_rule', c.ref, c.run); else useRef(c.ref, c.run);
  }
  // an expert unit's runs also credit the discovery it was made from
  const unitIds = [...uses.keys()].filter((k) => k.startsWith('expert_unit\u0000')).map((k) => k.slice('expert_unit\u0000'.length));
  const unitTitles = new Map<string, string>();
  for (let i = 0; i < unitIds.length; i += 500) {
    const ids = unitIds.slice(i, i + 500);
    for (const u of all<{ id: string; name: string; ref: string | null }>(`SELECT id, canonical_name AS name, json_extract(provenance_json, '$.ref') AS ref FROM expert_identities
        WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
      unitTitles.set(u.id, u.name);
      if (u.ref) for (const runId of uses.get(`expert_unit\u0000${u.id}`) ?? []) use('discovery', u.ref, runId);
    }
  }

  // ---- per item ----
  const items: FitnessItem[] = [...uses.entries()].map(([key, runIds]) => {
    const [kind, id] = key.split('\u0000') as [FitnessKind, string];
    let nV = 0; let nR = 0; let survived = 0; let settled = 0; let w = 0; let wV = 0; let last: string | null = null;
    for (const runId of runIds) {
      const r = runs.get(runId)!; if (!last || r.created_at > last) last = r.created_at;
      const o = outcome(runId); if (!o) continue;
      const weight = 0.5 ** (Math.max(0, now - Date.parse(r.created_at)) / 86_400_000 / FITNESS_HALF_LIFE_DAYS);
      w += weight;
      if (o === 'verified') { nV++; wV += weight; if (r.survived === 0 || r.survived === 1) { settled++; survived += r.survived; } } else nR++;
    }
    const n = nV + nR;
    return { kind, id, title: null, n_used: runIds.size, n_verified: nV, n_regressed: nR, n_survived_14d: settled ? survived : null,
      wilson: n ? wilson(nV, n) : null, last_used_at: last, decayed_verified_rate: w > 0 ? +(wV / w).toFixed(4) : null,
      status: fitnessStatus(runIds.size, nV, nR, baselineRate) };
  });

  // ---- inventory (for unused counts) ----
  const ids = (sql: string): Set<string> | null => { try { return new Set((db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id)); } catch { return null; } };
  const inventory: Record<FitnessKind, Set<string> | null> = {
    kb_page: ids('SELECT path AS id FROM kb_pages'),
    expert_unit: ids("SELECT id FROM expert_identities WHERE kind IN ('paper', 'repository')"),
    expert_claim: ids('SELECT id FROM expert_claims'),
    memory_rule: ids("SELECT id FROM memory_candidates WHERE status = 'promoted' AND memory_type = 'engineering_rule'"),
    discovery: null, knowledge: null, // no table lists every discovery ref / free-form knowledge ref: unused is unknown
  };
  const by_kind: KindCounts[] = FITNESS_KINDS.map((kind) => {
    const mine = items.filter((i) => i.kind === kind); const inv = inventory[kind];
    const count = (s: FitnessStatus) => mine.filter((i) => i.status === s).length;
    return { kind, inventory: inv ? inv.size : null, used_with_value: count('used_with_value'), used_no_value: count('used_no_value'), insufficient: count('insufficient'),
      unused: inv ? [...inv].filter((id) => !uses.has(`${kind}\u0000${id}`)).length : null };
  });

  const top = items.sort((a, b) => (b.n_verified + b.n_regressed) - (a.n_verified + a.n_regressed) || b.n_used - a.n_used || (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '') || a.id.localeCompare(b.id))
    .slice(0, topN);
  const title = (sql: string, id: string) => all<{ t: string | null }>(sql, id)[0]?.t ?? null;
  for (const i of top) {
    i.title = i.kind === 'kb_page' ? title('SELECT title AS t FROM kb_pages WHERE path = ?', i.id)
      : i.kind === 'expert_unit' ? unitTitles.get(i.id) ?? null
        : i.kind === 'expert_claim' ? title("SELECT subject || ' ' || relation || ' ' || object AS t FROM expert_claims WHERE id = ?", i.id)
          : i.kind === 'memory_rule' ? title('SELECT title AS t FROM memory_candidates WHERE id = ?', i.id) : null;
    if (i.title) i.title = i.title.replace(/\s+/g, ' ').slice(0, 120);
  }
  return {
    at: new Date(now).toISOString(), window_days: WINDOW_DAYS, half_life_days: FITNESS_HALF_LIFE_DAYS, min_n: FITNESS_MIN_N,
    baseline: { n: attributable, verified_rate: baselineRate === null ? null : +baselineRate.toFixed(4) },
    runs: { in_window: runs.size, maker_attributable: attributable, non_maker: nonMaker, unattributed: runs.size - attributable - nonMaker },
    by_kind, top,
    rule: `n = verified + maker_failure runs that used the item (reviewer/environment failures and unattributed runs count for nobody); n < ${FITNESS_MIN_N} → insufficient; `
      + 'used_with_value when its verified rate ≥ the baseline rate, else used_no_value; decay 0.5^(age/30 d) is computed, never applied to data',
    writes: 0,
  };
}
