import { rankContextResults, type ContextResult } from './context-injection-service';
/**
 * UX-24: offline retrieval quality harness. Given labelled queries (relevant ids per query) and a retriever that returns a
 * ranked id list per query, report recall@1/3/5/10 and MRR per source with n. Pure and deterministic; ranking is not touched.
 */
export interface LabelledQuery { id: string; source: string; relevant: string[] }
export interface SourceMetrics { source: string; n: number; recall: Record<'1' | '3' | '5' | '10', number>; mrr: number }
export type Retriever<Q extends LabelledQuery> = (query: Q) => string[];

const KS = [1, 3, 5, 10] as const;
const round = (x: number) => Math.round(x * 1e4) / 1e4;

export function evaluateRetrieval<Q extends LabelledQuery>(queries: Q[], retrieve: Retriever<Q>): SourceMetrics[] {
  const bySource = new Map<string, Q[]>();
  for (const q of queries) bySource.set(q.source, [...(bySource.get(q.source) ?? []), q]);
  return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, qs]) => {
    const recall = Object.fromEntries(KS.map((k) => [String(k), 0])) as SourceMetrics['recall'];
    let mrr = 0;
    for (const q of qs) {
      const ranked = retrieve(q); const relevant = new Set(q.relevant);
      for (const k of KS) recall[String(k) as keyof SourceMetrics['recall']] += relevant.size ? ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size : 0;
      const first = ranked.findIndex((id) => relevant.has(id));
      mrr += first >= 0 ? 1 / (first + 1) : 0;
    }
    for (const k of KS) recall[String(k) as keyof SourceMetrics['recall']] = round(recall[String(k) as keyof SourceMetrics['recall']] / qs.length);
    return { source, n: qs.length, recall, mrr: round(mrr / qs.length) };
  });
}

/** Cosine top-k retriever over an in-memory corpus restricted to the query's source (what the fixture and offline runs use). */
export function cosineRetriever(corpus: Array<{ id: string; source: string; embedding: number[] }>) {
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0) / (norm(a) * norm(b));
  return (q: LabelledQuery & { embedding: number[] }): string[] => corpus.filter((d) => d.source === q.source)
    .map((d) => ({ id: d.id, s: cos(q.embedding, d.embedding) })).sort((a, b) => b.s - a.s || a.id.localeCompare(b.id)).map((d) => d.id);
}

/**
 * E1 (docs/research/eco/E1-RRF_PROTOCOL.md): offline comparison of cross-source ranking arms. Harness only: the prod order
 * (`rankContextResults`) is reused unchanged for `raw` and `minmax`; `rrf` exists only here. Every arm sorts trust tier first.
 */
export type E1Arm = 'raw' | 'minmax' | 'rrf';
export interface E1Candidate { id: string; source: string; score: number; trust_level?: string }
export interface E1Query { id: string; relevant: string[]; candidates: E1Candidate[] }

const TRUST_ORDER: Record<string, number> = { approved: 0, validated: 1, agent_generated: 2 };
const tierOf = (t?: string) => TRUST_ORDER[t || 'agent_generated'] ?? 3;

/** Reciprocal rank fusion: Σ over sources 1 / (k + rank), rank 1-based by descending score within the source, ties by id. */
export function reciprocalRankFusion(candidates: E1Candidate[], k = 60): Map<string, number> {
  const bySource = new Map<string, E1Candidate[]>();
  for (const c of candidates) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
  const fused = new Map<string, number>();
  for (const list of bySource.values()) {
    [...list].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .forEach((c, i) => fused.set(c.id, (fused.get(c.id) ?? 0) + 1 / (k + i + 1)));
  }
  return fused;
}

/** Ranked unique ids for one arm. An id listed twice keeps its first (best-placed) occurrence; in rrf it takes its best tier. */
export function rankE1Arm(candidates: E1Candidate[], arm: E1Arm, k = 60): string[] {
  if (arm === 'rrf') {
    const fused = reciprocalRankFusion(candidates, k);
    const tier = new Map<string, number>();
    for (const c of candidates) tier.set(c.id, Math.min(tier.get(c.id) ?? Infinity, tierOf(c.trust_level)));
    return [...fused.keys()].sort((a, b) => tier.get(a)! - tier.get(b)! || fused.get(b)! - fused.get(a)!);
  }
  const asContext = candidates.map((c) => ({ source: c.source as ContextResult['source'], concept_id: c.id, score: c.score, trust_level: c.trust_level, excerpt: '' }));
  const ranked = rankContextResults(asContext, arm === 'minmax' ? { RETRIEVAL_NORMALISE_SCORES: 'true' } : {});
  return [...new Set(ranked.map((r) => r.concept_id!))];
}

const reciprocalRank = (ranked: string[], relevant: Set<string>) => { const i = ranked.findIndex((id) => relevant.has(id)); return i >= 0 ? 1 / (i + 1) : 0; };
const recallAt = (ranked: string[], relevant: Set<string>, k: number) => ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;

/** Paired bootstrap over queries (percentile 95 % CI) of the mean of per-query differences; seeded mulberry32, deterministic. */
export function pairedBootstrapCI(diffs: number[], resamples = 10_000, seed = 20261020): { mean: number; lo: number; hi: number } {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = diffs.length;
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) { let sum = 0; for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)]; means.push(sum / n); }
  means.sort((a, b) => a - b);
  return { mean: round(diffs.reduce((a, b) => a + b, 0) / n), lo: round(means[Math.floor(0.025 * resamples)]), hi: round(means[Math.ceil(0.975 * resamples) - 1]) };
}

export const E1_MIN_QUERIES = 30;
export interface E1Report {
  n_eligible: number; n_excluded: number; verdict: 'SUPPORTED' | 'FALSIFIED' | 'INSUFFICIENT';
  primary: { mrr_rrf_minus_raw: { mean: number; lo: number; hi: number } } | null;
  arms: Record<E1Arm, { mrr: number; recall5: number }> | null;
  secondary: { mrr_rrf_minus_minmax: { mean: number; lo: number; hi: number }; recall5_rrf_minus_raw: { mean: number; lo: number; hi: number } } | null;
}

/**
 * Scores the pre-registered E1 analysis. Eligible = ≥ 1 relevant id and candidates from ≥ 2 sources. Below 30 eligible
 * queries the verdict is INSUFFICIENT and no metric is returned (null, never 0).
 */
export function scoreE1(queries: E1Query[], k = 60): E1Report {
  const eligible = queries.filter((q) => q.relevant.length > 0 && new Set(q.candidates.map((c) => c.source)).size >= 2);
  const base = { n_eligible: eligible.length, n_excluded: queries.length - eligible.length };
  if (eligible.length < E1_MIN_QUERIES) return { ...base, verdict: 'INSUFFICIENT', primary: null, arms: null, secondary: null };
  const arms: E1Arm[] = ['raw', 'minmax', 'rrf'];
  const per = eligible.map((q) => {
    const rel = new Set(q.relevant);
    return Object.fromEntries(arms.map((a) => { const r = rankE1Arm(q.candidates, a, k); return [a, { mrr: reciprocalRank(r, rel), recall5: recallAt(r, rel, 5) }]; })) as Record<E1Arm, { mrr: number; recall5: number }>;
  });
  const mean = (xs: number[]) => round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const primary = pairedBootstrapCI(per.map((p) => p.rrf.mrr - p.raw.mrr));
  return {
    ...base,
    verdict: primary.lo > 0 ? 'SUPPORTED' : 'FALSIFIED',
    primary: { mrr_rrf_minus_raw: primary },
    arms: Object.fromEntries(arms.map((a) => [a, { mrr: mean(per.map((p) => p[a].mrr)), recall5: mean(per.map((p) => p[a].recall5)) }])) as E1Report['arms'],
    secondary: { mrr_rrf_minus_minmax: pairedBootstrapCI(per.map((p) => p.rrf.mrr - p.minmax.mrr)), recall5_rrf_minus_raw: pairedBootstrapCI(per.map((p) => p.rrf.recall5 - p.raw.recall5)) },
  };
}
