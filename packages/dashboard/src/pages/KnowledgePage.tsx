import { Library } from 'lucide-react';
import { api, type KnowledgeOverview, type SkillCardsView } from '../lib/api';
import { useResource } from '../hooks/useResource';

const fetchKnowledge = () => api.getKnowledgeOverview();
const fetchSkills = () => api.getSkillCards();

const day = (value: string | null) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—');

/** W5: what the knowledge pipeline brought in, per source, and whether jev judged it relevant (30 days). */
export function KnowledgePage() {
  const { data, error } = useResource(fetchKnowledge);
  const skills = useResource(fetchSkills);

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
      {skills.error && <p role="alert" className="text-status-error">{skills.error}</p>}
      {skills.data && <SkillCardsSection data={skills.data} />}
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

/** K4: skill cards distilled from verified runs and anti-patterns from maker failures — evidence only, never given to a maker. */
export function SkillCardsSection({ data }: { data: SkillCardsView }) {
  const lanes = [...new Set(data.by_lane.map((r) => r.lane))];
  const count = (lane: string, kind: string, status?: string) => data.by_lane.filter((r) => r.lane === lane && r.kind === kind && (!status || r.status === status)).reduce((a, r) => a + r.n, 0);
  return (
    <section aria-labelledby="skill-cards">
      <h2 id="skill-cards" className="text-lg font-semibold mb-2">Distilled skill cards</h2>
      <p className="text-xs text-foreground-tertiary mb-2">
        Mode {data.mode} · {data.total === null ? 'unknown (no cards recorded yet)' : `${data.total} card(s)`} · {data.note}.
      </p>
      {data.total === null ? <p className="text-sm text-foreground-secondary">{data.reason ?? 'No cards recorded yet.'}</p> : data.total === 0 ? <p className="text-sm text-foreground-secondary">No cards yet.</p> : (
        <>
          <table className="w-full text-sm mb-3">
            <thead><tr className="text-left text-foreground-tertiary"><th>Lane</th><th>Candidate</th><th>Survived</th><th>Regressed</th><th>Anti-patterns</th></tr></thead>
            <tbody>{lanes.map((lane) => (
              <tr key={lane} className="border-t border-border">
                <td>{lane}</td><td>{count(lane, 'skill', 'candidate')}</td><td className="text-status-completed">{count(lane, 'skill', 'survived')}</td>
                <td className="text-status-error">{count(lane, 'skill', 'regressed')}</td><td>{count(lane, 'anti_pattern')}</td>
              </tr>
            ))}</tbody>
          </table>
          <ul className="space-y-1 text-sm">{data.latest.map((c) => (
            <li key={c.run_id}>
              <span className="text-foreground">{c.kind === 'skill' ? 'skill' : 'anti-pattern'} · {c.status}</span>{' '}
              <span className="text-xs text-foreground-tertiary">
                · {c.card.lane ?? 'unknown lane'} · {c.card.task_kind ?? 'unknown kind'} · {(c.card.target_pattern ?? ['unknown files']).join(', ')}
                {' '}· {c.card.diff_shape.files_changed ?? '?'} file(s){c.card.diff_shape.test_only ? ', test-only' : ''}
                {c.card.failure ? ` · gate ${c.card.failure.gate ?? 'unknown'}` : ''} · {c.card.runtime ?? '?'}{c.card.model ? `@${c.card.model}` : ''} · {day(c.created_at)}
              </span>
            </li>
          ))}</ul>
        </>
      )}
    </section>
  );
}
