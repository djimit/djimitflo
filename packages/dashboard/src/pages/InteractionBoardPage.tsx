import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Link2, MessageSquare, Network, RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type AgentInteractionRecord, type EcosystemMapSummary } from '../lib/api';

type BoardFilters = {
  search: string;
  actor: string;
  source: string;
  scope: string;
  status: string;
};

type InteractionThread = {
  id: string;
  label: string;
  count: number;
  participants: string[];
  lastSeen: string;
};

type InteractionRelation = {
  from: string;
  to: string;
  count: number;
  actions: string[];
  scopes: string[];
  statuses: string[];
  lastSeen: string;
};

const EMPTY_FILTERS: BoardFilters = { search: '', actor: '', source: '', scope: '', status: '' };
const VISIBLE_STEP = 100;

function threadId(interaction: AgentInteractionRecord) {
  return interaction.correlation_id || `unattributed:${interaction.id}`;
}

export function filterInteractions(interactions: AgentInteractionRecord[], filters: BoardFilters) {
  const search = filters.search.trim().toLowerCase();
  return interactions.filter((interaction) => {
    const searchable = [
      interaction.actor.id,
      interaction.actor.role,
      interaction.actor.runtime,
      interaction.actor.model,
      interaction.action,
      interaction.target?.type,
      interaction.target?.id,
      interaction.capability_id,
      interaction.decision,
      interaction.summary,
      ...interaction.evidence_refs,
    ].filter(Boolean).join(' ').toLowerCase();
    return (!search || searchable.includes(search))
      && (!filters.actor || interaction.actor.id === filters.actor || interaction.target?.id === filters.actor)
      && (!filters.source || interaction.source === filters.source)
      && (!filters.scope || interaction.effect_scope === filters.scope)
      && (!filters.status || interaction.status === filters.status);
  });
}

export function buildInteractionThreads(interactions: AgentInteractionRecord[]): InteractionThread[] {
  const threads = new Map<string, InteractionThread>();
  for (const interaction of interactions) {
    const id = threadId(interaction);
    const current = threads.get(id);
    const participants = new Set(current?.participants || []);
    participants.add(interaction.actor.id);
    if (interaction.target?.type === 'agent') participants.add(interaction.target.id);
    threads.set(id, {
      id,
      label: interaction.correlation_id || `Unattributed · ${interaction.id}`,
      count: (current?.count || 0) + 1,
      participants: [...participants].sort(),
      lastSeen: current && current.lastSeen > interaction.timestamp ? current.lastSeen : interaction.timestamp,
    });
  }
  return [...threads.values()].sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
}

export function buildInteractionRelations(interactions: AgentInteractionRecord[]): InteractionRelation[] {
  const relations = new Map<string, InteractionRelation>();
  for (const interaction of interactions) {
    const to = interaction.target ? `${interaction.target.type}:${interaction.target.id}` : 'no-target';
    const key = `${interaction.actor.type}:${interaction.actor.id}\u0000${to}`;
    const current = relations.get(key);
    relations.set(key, {
      from: `${interaction.actor.type}:${interaction.actor.id}`,
      to,
      count: (current?.count || 0) + 1,
      actions: [...new Set([...(current?.actions || []), interaction.action])].sort(),
      scopes: [...new Set([...(current?.scopes || []), interaction.effect_scope])].sort(),
      statuses: [...new Set([...(current?.statuses || []), interaction.status])].sort(),
      lastSeen: current && current.lastSeen > interaction.timestamp ? current.lastSeen : interaction.timestamp,
    });
  }
  return [...relations.values()].sort((left, right) => right.count - left.count || right.lastSeen.localeCompare(left.lastSeen));
}

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

function statusTone(value: string) {
  if (['PASS', 'OBSERVED', 'completed', 'recorded', 'read', 'allowed'].includes(value)) return 'border-status-success/30 bg-status-success/10 text-status-success';
  if (['FAIL', 'blocked', 'denied', 'error'].includes(value)) return 'border-status-error/30 bg-status-error/10 text-status-error';
  return 'border-border bg-background-elevated text-foreground-secondary';
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'unknown';
}

export function InteractionBoardPage() {
  const [interactions, setInteractions] = useState<AgentInteractionRecord[]>([]);
  const [ecosystem, setEcosystem] = useState<EcosystemMapSummary | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [selectedThread, setSelectedThread] = useState('all');
  const [view, setView] = useState<'chat' | 'relations'>('chat');
  const [visible, setVisible] = useState(VISIBLE_STEP);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const [interactionResult, ecosystemResult] = await Promise.allSettled([
      api.getAgentInteractions({ limit: 500 }),
      api.getSwarmMissionControl(),
    ]);
    if (interactionResult.status === 'fulfilled') setInteractions(interactionResult.value.interactions || []);
    if (ecosystemResult.status === 'fulfilled') setEcosystem(ecosystemResult.value.ecosystem_map || null);
    const failures = [interactionResult, ecosystemResult].filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length) setError(failures.length === 2 ? 'Interaction ledger and ecosystem map are unavailable' : 'One evidence source is unavailable');
    setLastUpdated(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => void refresh(true), 10_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh]);

  const filtered = useMemo(() => filterInteractions(interactions, filters), [interactions, filters]);
  const threads = useMemo(() => buildInteractionThreads(filtered), [filtered]);
  const selected = useMemo(
    () => selectedThread === 'all' ? filtered : filtered.filter((interaction) => threadId(interaction) === selectedThread),
    [filtered, selectedThread],
  );
  const relations = useMemo(() => buildInteractionRelations(filtered), [filtered]);
  const actors = useMemo(() => unique(interactions.flatMap((item) => [item.actor.id, item.target?.type === 'agent' ? item.target.id : '']).filter(Boolean)), [interactions]);
  const sources = useMemo(() => unique(interactions.map((item) => item.source)), [interactions]);
  const statuses = useMemo(() => unique(interactions.map((item) => item.status)), [interactions]);

  function updateFilter(key: keyof BoardFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelectedThread('all');
    setVisible(VISIBLE_STEP);
  }

  return (
    <div className="space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground"><MessageSquare className="h-8 w-8 text-accent" /> Interaction Board</h1>
          <p className="mt-2 max-w-3xl text-foreground-secondary">Read-only chat- en relatiebeeld uit dezelfde operationele evidence als Mission Control. Simulatie, isolatie en productie blijven expliciet gescheiden.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-foreground-secondary"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> live · 10s</label>
          <button type="button" onClick={() => void refresh()} disabled={loading} title="Refresh" aria-label="Refresh interaction board" className="rounded-lg border border-border p-2 hover:bg-background-elevated disabled:opacity-50"><RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </header>

      {error && <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error"><AlertTriangle className="h-4 w-4" />{error}</div>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Interactions" value={filtered.length} />
        <Metric label="Social exchanges" value={filtered.filter((item) => item.action.startsWith('social.')).length} />
        <Metric label="Threads" value={threads.length} />
        <Metric label="Relations" value={relations.length} />
        <Metric label="Declared contracts" value={ecosystem?.declared_contracts.length || 0} />
        <Metric label="Production events" value={filtered.filter((item) => item.effect_scope === 'production').length} />
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="relative xl:col-span-1"><span className="sr-only">Search interactions</span><Search className="absolute left-3 top-2.5 h-4 w-4 text-foreground-tertiary" /><input value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="Search actor, action, evidence…" className="w-full rounded border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground" /></label>
          <Filter label="Actor" value={filters.actor} values={actors} onChange={(value) => updateFilter('actor', value)} />
          <Filter label="Source" value={filters.source} values={sources} onChange={(value) => updateFilter('source', value)} />
          <Filter label="Scope" value={filters.scope} values={['simulated', 'isolated', 'production']} onChange={(value) => updateFilter('scope', value)} />
          <Filter label="Status" value={filters.status} values={statuses} onChange={(value) => updateFilter('status', value)} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-foreground-tertiary">
          <span>Loaded {interactions.length} most recent evidence records · updated {time(lastUpdated)}</span>
          <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setSelectedThread('all'); setVisible(VISIBLE_STEP); }} className="text-accent hover:underline">Clear filters</button>
        </div>
      </section>

      <div className="flex gap-2" role="tablist" aria-label="Interaction board view">
        <Tab active={view === 'chat'} onClick={() => setView('chat')}><MessageSquare className="h-4 w-4" /> Chat timeline</Tab>
        <Tab active={view === 'relations'} onClick={() => setView('relations')}><Network className="h-4 w-4" /> Relations</Tab>
        <Link to="/swarm-mission-control" className="ml-auto inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-background-elevated"><Link2 className="h-4 w-4" /> Mission Control</Link>
      </div>

      {view === 'chat' ? (
        <div className="grid min-h-[32rem] gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="rounded-lg border border-border bg-background-secondary p-3">
            <h2 className="px-2 pb-2 text-sm font-semibold text-foreground">Correlation threads</h2>
            <div className="max-h-[42rem] space-y-1 overflow-y-auto">
              <ThreadButton active={selectedThread === 'all'} label="All visible interactions" count={filtered.length} onClick={() => { setSelectedThread('all'); setVisible(VISIBLE_STEP); }} />
              {threads.map((thread) => <ThreadButton key={thread.id} active={selectedThread === thread.id} label={thread.label} detail={thread.participants.join(' · ')} count={thread.count} onClick={() => { setSelectedThread(thread.id); setVisible(VISIBLE_STEP); }} />)}
            </div>
          </aside>
          <main className="rounded-lg border border-border bg-background-secondary p-4">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold text-foreground">{selectedThread === 'all' ? 'All interactions' : threads.find((thread) => thread.id === selectedThread)?.label || 'Thread'}</h2><span className="text-xs text-foreground-tertiary">{selected.length} records</span></div>
            <div className="space-y-3">
              {selected.slice(0, visible).map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} />)}
              {!selected.length && <p className="py-16 text-center text-sm text-foreground-tertiary">No interactions match these filters.</p>}
            </div>
            {visible < selected.length && <button type="button" onClick={() => setVisible((current) => current + VISIBLE_STEP)} className="mt-4 w-full rounded-lg border border-border py-2 text-sm text-accent hover:bg-background-elevated">Show next {Math.min(VISIBLE_STEP, selected.length - visible)}</button>}
          </main>
        </div>
      ) : (
        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-background-secondary p-4">
            <h2 className="font-semibold text-foreground">Observed actor → target relations</h2>
            <p className="mt-1 text-sm text-foreground-secondary">Derived only from the currently loaded ledger evidence; ordering alone is not presented as causality.</p>
            <RelationTable relations={relations} />
          </section>
          <section className="rounded-lg border border-border bg-background-secondary p-4">
            <h2 className="font-semibold text-foreground">Declared ecosystem contracts</h2>
            <p className="mt-1 text-sm text-foreground-secondary">Normative routes remain separate from observed traffic.</p>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {(ecosystem?.declared_contracts || []).map((contract) => (
                <article key={contract.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground"><span>{contract.from}</span><span className="text-foreground-tertiary">→</span><span>{contract.to}</span><Badge value={contract.evidence_state} /></div>
                  <p className="mt-2 text-sm text-foreground-secondary">{contract.exchange}</p>
                  <p className="mt-2 text-xs text-foreground-tertiary">Boundary: {contract.boundary} · observed {contract.observed_count} · last {time(contract.last_seen)}</p>
                  {contract.trace && <details className="mt-2 text-xs text-foreground-secondary"><summary className="cursor-pointer text-accent">Replayable trace ({contract.trace.evidence_refs.length})</summary><div className="mt-2 space-y-1 font-mono"><div>actions: {contract.trace.actions.join(', ')}</div><div>scope: {contract.trace.effect_scopes.join(', ')}</div><div>status: {contract.trace.statuses.join(', ')}</div>{contract.trace.evidence_refs.map((reference) => <div key={reference} className="break-all">{reference}</div>)}</div></details>}
                </article>
              ))}
              {!ecosystem?.declared_contracts.length && <p className="text-sm text-foreground-tertiary">No declared contracts available.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-border bg-background-secondary p-4"><div className="text-2xl font-bold text-foreground">{value}</div><div className="text-xs text-foreground-tertiary">{label}</div></div>;
}

function Filter({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <label><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"><option value="">All {label.toLowerCase()}s</option>{values.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-foreground-secondary hover:bg-background-elevated'}`}>{children}</button>;
}

function ThreadButton({ active, label, detail, count, onClick }: { active: boolean; label: string; detail?: string; count: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`w-full rounded-lg border p-2 text-left ${active ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-background-elevated'}`}><div className="flex items-start justify-between gap-2"><span className="truncate text-xs font-medium text-foreground">{label}</span><span className="rounded bg-background-elevated px-1.5 py-0.5 text-[10px] text-foreground-secondary">{count}</span></div>{detail && <div className="mt-1 truncate text-[10px] text-foreground-tertiary">{detail}</div>}</button>;
}

function Badge({ value }: { value: string }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(value)}`}>{value}</span>;
}

function InteractionCard({ interaction }: { interaction: AgentInteractionRecord }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submit(action: 'request_evidence' | 'challenge_claim' | 'request_reproduction' | 'start_experiment') {
    if (!reason.trim()) return;
    setSubmitting(action);
    setResult(null);
    try {
      const response = await api.submitInteractionAction({
        action,
        interaction_id: interaction.id,
        correlation_id: interaction.correlation_id,
        reason: reason.trim(),
        evidence_refs: interaction.evidence_refs,
      });
      setResult(response.work_item ? `Recorded · research item ${response.work_item.id}` : 'Recorded in decision ledger');
      setReason('');
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <article className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold text-foreground">{interaction.actor.id}</span><span className="text-foreground-tertiary">→</span><code className="text-accent">{interaction.action}</code><span className="text-foreground-tertiary">→</span><span className="break-all text-foreground-secondary">{interaction.target ? `${interaction.target.type}:${interaction.target.id}` : 'no target'}</span></div><p className="mt-2 text-sm text-foreground-secondary">{interaction.summary}</p></div>
        <div className="flex shrink-0 gap-1"><Badge value={interaction.effect_scope} /><Badge value={interaction.status} /></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-tertiary"><span>{time(interaction.timestamp)}</span><span>source: {interaction.source}</span>{interaction.actor.role && <span>role: {interaction.actor.role}</span>}{interaction.actor.runtime && <span>runtime: {interaction.actor.runtime}</span>}{interaction.actor.model && <span>model: {interaction.actor.model}</span>}{interaction.decision && <span>decision: {interaction.decision}</span>}</div>
      {(interaction.causation_id || interaction.evidence_refs.length > 0) && <details className="mt-3 text-xs text-foreground-secondary"><summary className="cursor-pointer text-accent">Evidence & lineage ({interaction.evidence_refs.length})</summary><div className="mt-2 space-y-1 font-mono">{interaction.correlation_id && <div>correlation: {interaction.correlation_id}</div>}{interaction.causation_id && <div>causation: {interaction.causation_id}</div>}{interaction.evidence_refs.map((reference) => <div key={reference} className="break-all">{reference}</div>)}</div></details>}
      <details className="mt-3 text-xs text-foreground-secondary">
        <summary className="cursor-pointer text-accent">Governed action</summary>
        <label className="mt-2 block"><span className="sr-only">Reason for interaction action</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Question, challenge or falsifiable reason…" className="w-full rounded border border-border bg-background-elevated px-3 py-2 text-sm text-foreground" /></label>
        <div className="mt-2 flex flex-wrap gap-2">
          {([
            ['request_evidence', 'Request evidence'],
            ['challenge_claim', 'Challenge claim'],
            ['request_reproduction', 'Request reproduction'],
            ['start_experiment', 'Start bounded experiment'],
          ] as const).map(([action, label]) => <button key={action} type="button" disabled={!reason.trim() || submitting !== null} onClick={() => void submit(action)} className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary hover:bg-background-elevated disabled:opacity-40">{submitting === action ? 'Recording…' : label}</button>)}
        </div>
        {result && <p role="status" className="mt-2 text-foreground-tertiary">{result}</p>}
        <p className="mt-2 text-foreground-tertiary">Actions create governed decisions or inert research items; they never invoke tools directly.</p>
      </details>
    </article>
  );
}

function RelationTable({ relations }: { relations: InteractionRelation[] }) {
  return <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-foreground-tertiary"><tr><th className="py-2 pr-4">From</th><th className="py-2 pr-4">To</th><th className="py-2 pr-4">Interactions</th><th className="py-2 pr-4">Actions</th><th className="py-2 pr-4">Scopes</th><th className="py-2">Last observed</th></tr></thead><tbody className="divide-y divide-border">{relations.map((relation) => <tr key={`${relation.from}:${relation.to}`}><td className="py-3 pr-4 font-mono text-xs text-foreground">{relation.from}</td><td className="py-3 pr-4 font-mono text-xs text-foreground">{relation.to}</td><td className="py-3 pr-4 text-foreground-secondary">{relation.count}</td><td className="max-w-xs py-3 pr-4 text-xs text-foreground-secondary">{relation.actions.join(', ')}</td><td className="py-3 pr-4 text-xs text-foreground-secondary">{relation.scopes.join(', ')}</td><td className="whitespace-nowrap py-3 text-xs text-foreground-tertiary">{time(relation.lastSeen)}</td></tr>)}</tbody></table>{!relations.length && <p className="py-12 text-center text-sm text-foreground-tertiary">No observed relations match these filters.</p>}</div>;
}
