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
