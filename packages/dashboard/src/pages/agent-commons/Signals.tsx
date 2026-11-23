import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type EvolutionEvidence } from '../../lib/api';

/**
 * Commons "Signals" tab: what the agents forecast, ask, dream and say to each other, read from the evolution evidence
 * (5-minute server cache) and the interaction ledger. Read-only; a missing number is shown as "—", never as 0.
 */
const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : v.toFixed(digits));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);

function Card({ title, state, children }: { title: string; state: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-background-secondary p-4">
      <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold text-foreground">{title}</h2><span className="text-xs text-foreground-secondary">{state}</span></div>
      <div className="mt-3 space-y-1 text-sm text-foreground">{children}</div>
    </section>
  );
}
const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex justify-between gap-4"><span className="text-foreground-secondary">{label}</span><span className="tabular-nums">{value}</span></div>
);

export function SignalsBody({ data, interactions }: { data: EvolutionEvidence; interactions: number | null }) {
  const f = data.maker_forecast; const gaps = data.knowledge_gaps; const web = data.web_research; const links = data.knowledge_links;
  // all dream genomes by trial outcome (active = promoted); null when the evidence carries no genome counts
  const dream = (...statuses: string[]) => (data.genomes?.by_status ? data.genomes.by_status.filter((g) => g.origin === 'dream' && statuses.includes(g.status)).reduce((sum, g) => sum + g.n, 0) : null);
  const forecastMode = data.flags?.find((flag) => flag.name === 'MAKER_FORECAST_MODE')?.value ?? 'off';
  return (
    <div className="grid gap-4 p-8 md:grid-cols-2">
      <Card title="Maker forecast" state={`mode ${forecastMode}`}>
        <p className="text-foreground-secondary">Each maker states the probability that its own change passes the checks and the reviewer. Scored, never used to decide.</p>
        <Row label="Scored forecasts" value={num(f?.n)} />
        <Row label="Passed" value={f?.n ? `${f.positives} (${pct(f.base_rate)})` : '—'} />
        <Row label="Not yet resolved" value={num(f?.unresolved)} />
        <Row label="Brier score (0 = perfect)" value={num(f?.brier, 3)} />
        <Row label="Skill against the pass rate" value={num(f?.skill, 2)} />
        {!f?.n && <p className="text-foreground-secondary">No scored forecast yet{forecastMode === 'off' ? ': the flag is off.' : '.'}</p>}
      </Card>
      <Card title="Curiosity" state={`knowledge gaps ${gaps?.mode ?? 'off'} · web research ${web?.mode ?? 'off'}`}>
        <p className="text-foreground-secondary">What the agents do not know and have asked about.</p>
        <Row label="Open knowledge gaps" value={num(gaps?.open)} />
        <Row label="Oldest gap (days)" value={num(gaps?.oldest_age_days)} />
        <Row label="Questions asked after a failure" value={num(web?.questions?.asked)} />
        {(web?.questions?.recent ?? []).slice(0, 3).map((q) => <p key={`${q.at}${q.question}`} className="truncate text-foreground-secondary" title={q.question ?? ''}>“{q.question ?? '—'}” · {q.status}</p>)}
      </Card>
      <Card title="Dreams" state="genomes written from knowledge">
        <p className="text-foreground-secondary">Maker variants the system wrote for itself from what it learned.</p>
        <Row label="Dream genomes" value={num(links?.genomes_total)} />
        <Row label="…citing a knowledge source" value={num(links?.genomes_with_refs)} />
        <Row label="Promoted after a trial" value={num(dream('active'))} />
        <Row label="Retired after a trial" value={num(dream('retired'))} />
        <Row label="Undecided or still in trial" value={num(dream('inconclusive', 'trial'))} />
      </Card>
      <Card title="Agent to agent" state="interaction ledger">
        <p className="text-foreground-secondary">Messages, handoffs and reviews between agents.</p>
        <Row label="Recent interactions (latest 200)" value={num(interactions)} />
        <Link to="/agent-commons?tab=interactions" className="text-accent hover:underline">Open the interaction board</Link>
      </Card>
    </div>
  );
}

export function CommonsSignals() {
  const [data, setData] = useState<EvolutionEvidence | null>(null);
  const [interactions, setInteractions] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getEvolutionEvidence().then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api.getAgentInteractions({ limit: 200 }).then((r) => setInteractions(r.interactions.length)).catch(() => setInteractions(null));
  }, []);
  if (error) return <p role="alert" className="p-8 text-sm text-status-error">Signals unavailable: {error}</p>;
  if (!data) return <p className="p-8 text-sm text-foreground-secondary">Loading signals…</p>;
  return <SignalsBody data={data} interactions={interactions} />;
}
