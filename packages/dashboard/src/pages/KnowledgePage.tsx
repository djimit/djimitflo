import { useEffect, useState } from 'react';
import { Library } from 'lucide-react';
import { api, type KnowledgeOverview } from '../lib/api';

const day = (value: string | null) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—');

/** W5: what the knowledge pipeline brought in, per source, and whether jev judged it relevant (30 days). */
export function KnowledgePage() {
  const [data, setData] = useState<KnowledgeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getKnowledgeOverview().then(setData).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load the knowledge overview'));
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Library className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Knowledge</h1>
      </div>
      <p className="text-sm text-foreground-secondary">
        Discoveries from the fleet, the scout, the knowledge base and the operator's reading list; jev's relevance verdict on each; and what reached the panels. Last 30 days, read-only.
      </p>
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && <KnowledgeBody data={data} />}
    </div>
  );
}

export function KnowledgeBody({ data }: { data: KnowledgeOverview }) {
  const { yes, uncertain, no } = data.relevance;
  const judged = yes + uncertain + no;
  return (
    <>
      <section aria-labelledby="sources">
        <h2 id="sources" className="text-lg font-semibold mb-2">Sources</h2>
        <p className="text-xs text-foreground-tertiary mb-2">
          {judged ? `${yes} relevant, ${uncertain} uncertain, ${no} not relevant (${Math.round((100 * yes) / judged)} % relevant overall).` : 'No relevance verdicts yet.'} Sorted by relevant items: the sources worth keeping come first.
        </p>
        {data.sources.length === 0 ? <p className="text-sm text-foreground-secondary">No discoveries in the last 30 days.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-foreground-tertiary"><th>Source</th><th>Items</th><th>7 days</th><th>Relevant</th><th>Uncertain</th><th>No</th><th>% relevant</th><th>Units</th><th>Last</th></tr></thead>
            <tbody>{data.sources.map((s) => (
              <tr key={s.source} className="border-t border-border">
                <td>{s.source}</td><td>{s.events}</td><td>{s.events_7d}</td><td className="text-status-completed">{s.yes}</td><td>{s.uncertain}</td><td>{s.no}</td>
                <td>{s.relevant_pct === null ? '—' : `${s.relevant_pct} %`}</td><td>{s.units}</td><td>{day(s.last)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="relevant" className="grid md:grid-cols-2 gap-6">
        <div>
          <h2 id="relevant" className="text-lg font-semibold mb-2">Recently judged relevant</h2>
          {data.recent_relevant.length === 0 ? <p className="text-sm text-foreground-secondary">Nothing judged relevant yet.</p> : (
            <ul className="space-y-1 text-sm">{data.recent_relevant.map((r) => (
              <li key={r.ref}><span className="text-foreground">{r.title}</span> <span className="text-xs text-foreground-tertiary">· {r.source} · {day(r.at)}</span></li>
            ))}</ul>
          )}
        </div>
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold mb-2">Knowledge base in panels</h2>
            <p className="text-sm">{data.kb_retrieval.hits_30d} page hits in {data.kb_retrieval.panels_30d} panel reviews · last {day(data.kb_retrieval.last)}</p>
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-2">Interest profile sent to the scouts</h2>
            {data.interest_profile ? (
              <>
                <p className="text-xs text-foreground-tertiary mb-1">Published {day(data.interest_profile.at)}</p>
                <ul className="flex flex-wrap gap-1">{data.interest_profile.terms.map((t) => <li key={t} className="rounded bg-background-tertiary px-2 py-0.5 text-xs">{t}</li>)}</ul>
              </>
            ) : <p className="text-sm text-foreground-secondary">No profile published yet.</p>}
          </div>
        </div>
      </section>
    </>
  );
}
