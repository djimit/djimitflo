import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpenCheck, GraduationCap, History, RefreshCw, Scale, Search, ShieldCheck, Swords, Users } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, type ExpertDetail, type ExpertLifecycleState, type ExpertResolution, type ExpertSummary, type ExpertSwarmRun } from '../lib/api';

/** Visual tone per lifecycle state: only ACTIVE is verified-for-recommendation; everything else is tentative or closed (§36). */
export const STATE_TONE: Record<ExpertLifecycleState, { label: string; tone: 'verified' | 'tentative' | 'blocked' | 'closed' }> = {
  DISCOVERED: { label: 'Ontdekt (alleen handtekening)', tone: 'tentative' },
  IDENTITY_RESOLVED: { label: 'Identiteit bevestigd', tone: 'tentative' },
  EVIDENCE_COLLECTED: { label: 'Bewijs verzameld', tone: 'tentative' },
  CAPABILITY_INFERRED: { label: 'Capability afgeleid', tone: 'tentative' },
  CHECKED: { label: 'Gecontroleerd', tone: 'tentative' },
  APPROVED: { label: 'Goedgekeurd', tone: 'tentative' },
  ACTIVE: { label: 'Actief (aanbevolen)', tone: 'verified' },
  AMBIGUOUS: { label: 'Ambigu (gesloten deur)', tone: 'blocked' },
  INSUFFICIENT_EVIDENCE: { label: 'Onvoldoende bewijs', tone: 'blocked' },
  CONTRADICTED: { label: 'Tegenspraak open', tone: 'blocked' },
  STALE: { label: 'Verouderd', tone: 'blocked' },
  REJECTED: { label: 'Afgewezen', tone: 'closed' },
  REVOKED: { label: 'Ingetrokken', tone: 'closed' },
};

/** Mirror of the server's lifecycle map, used only to offer sensible buttons; the server remains the judge. */
export const NEXT_STATES: Record<ExpertLifecycleState, ExpertLifecycleState[]> = {
  DISCOVERED: ['REJECTED'], IDENTITY_RESOLVED: ['REJECTED'], EVIDENCE_COLLECTED: ['REJECTED'], CAPABILITY_INFERRED: ['CHECKED', 'REJECTED'],
  CHECKED: ['APPROVED', 'REJECTED', 'CAPABILITY_INFERRED'], APPROVED: ['ACTIVE', 'REVOKED', 'STALE'], ACTIVE: ['STALE', 'REVOKED'],
  AMBIGUOUS: ['REJECTED'], INSUFFICIENT_EVIDENCE: ['REJECTED'], CONTRADICTED: ['CAPABILITY_INFERRED', 'REVOKED', 'REJECTED'], STALE: ['REVOKED'], REJECTED: [], REVOKED: [],
};

export const TONE_CLASS: Record<'verified' | 'tentative' | 'blocked' | 'closed', string> = {
  verified: 'border-status-success/40 bg-status-success/10 text-status-success',
  tentative: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  blocked: 'border-status-error/40 bg-status-error/10 text-status-error',
  closed: 'border-border bg-background-tertiary text-foreground-tertiary',
};

export function tierLabel(tier: number): string {
  return tier === 1 ? 'T1 primair' : tier === 2 ? 'T2 institutioneel' : tier === 3 ? 'T3 secundair' : 'T4 handtekening';
}

/** Compact facts about a swarm run for the runs table; contradiction and abstention are surfaced, never hidden. */
export function summarizeRun(run: ExpertSwarmRun): { decision: string; perspectives: number; disagreements: number; attacks: number; rejected: number; abstained: string | null } {
  const council = run.council;
  return {
    decision: run.promotion_decision,
    perspectives: council?.perspectives.length ?? 0,
    disagreements: council?.disagreements.length ?? 0,
    attacks: council?.adversarial?.attacks.length ?? 0,
    rejected: council?.rejected_perspectives?.length ?? 0,
    abstained: council?.abstained ? council.reason : null,
  };
}

/** Counts per state for the overview strip, in lifecycle order. */
export function stateCounts(experts: ExpertSummary[]): Array<{ state: ExpertLifecycleState; count: number }> {
  return (Object.keys(STATE_TONE) as ExpertLifecycleState[]).map((state) => ({ state, count: experts.filter((expert) => expert.lifecycle_state === state).length })).filter((entry) => entry.count > 0);
}

const time = (value: string | null | undefined) => (value ? new Date(value).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const DECISION_CLASS: Record<string, string> = { VERIFIED_FOR_USE: TONE_CLASS.verified, HUMAN_REVIEW_REQUIRED: TONE_CLASS.tentative, CONTRADICTED: TONE_CLASS.blocked, INSUFFICIENT_EVIDENCE: TONE_CLASS.closed, UNVERIFIABLE: TONE_CLASS.closed };

function StateBadge({ state }: { state: ExpertLifecycleState }) {
  const tone = STATE_TONE[state] ?? { label: state, tone: 'closed' as const };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[tone.tone]}`}>{tone.label}</span>;
}

export function FrontierExpertsPage() {
  const { expertId } = useParams();
  const [experts, setExperts] = useState<ExpertSummary[]>([]);
  const [filter, setFilter] = useState({ state: '', capability: '', name: '' });
  const [detail, setDetail] = useState<ExpertDetail | null>(null);
  const [runs, setRuns] = useState<ExpertSwarmRun[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [resolution, setResolution] = useState<ExpertResolution | null>(null);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [list, history] = await Promise.all([api.listExperts({ ...filter, limit: 200 }), api.getExpertSwarmRuns()]);
      setExperts(list.experts);
      setRuns(history);
    } catch (err) { fail(err); }
  }, [filter]);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api.getExpert(id)); } catch (err) { fail(err); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (expertId) void loadDetail(expertId); else setDetail(null); }, [expertId, loadDetail]);

  const counts = useMemo(() => stateCounts(experts), [experts]);

  const act = async (label: string, work: () => Promise<unknown>, done: string) => {
    setBusy(label); setError(null); setNotice(null);
    try { await work(); setNotice(done); await refresh(); if (expertId) await loadDetail(expertId); } catch (err) { fail(err); } finally { setBusy(null); }
  };

  const resolve = async () => {
    if (!question.trim()) return;
    setBusy('resolve'); setError(null);
    try { setResolution(await api.resolveExperts(question.trim(), 5)); } catch (err) { fail(err); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground"><GraduationCap className="h-8 w-8 text-accent-secondary" /> Frontier Experts</h1>
          <p className="mt-2 max-w-3xl text-foreground-secondary">Bewijsgedragen expertise voor de ExpertSwarm. Een handtekening is een ontdekking, geen expertise; alleen <strong>Actief</strong> wordt aanbevolen, en pas na controle en goedkeuring door twee verschillende mensen. Tegenspraak blijft zichtbaar en blokkeert promotie.</p>
        </div>
        <button type="button" onClick={() => void refresh()} aria-label="Ververs experts" className="rounded-lg border border-border p-2 hover:bg-background-tertiary"><RefreshCw className="h-4 w-4" /></button>
      </header>

      {error && <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error"><AlertTriangle className="h-4 w-4" /> {error}</div>}
      {notice && <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-foreground">{notice}</div>}

      <section className="flex flex-wrap gap-2">
        {counts.map((entry) => (
          <button key={entry.state} type="button" onClick={() => setFilter((current) => ({ ...current, state: current.state === entry.state ? '' : entry.state }))} className={`rounded-lg border px-3 py-1.5 text-xs ${filter.state === entry.state ? 'ring-2 ring-accent' : ''} ${TONE_CLASS[STATE_TONE[entry.state].tone]}`}>
            {STATE_TONE[entry.state].label} · {entry.count}
          </button>
        ))}
        {!counts.length && <p className="text-xs text-foreground-tertiary">Nog geen experts in het register. Ingestie van Pacing the Frontier en arXiv-verrijking vullen het.</p>}
      </section>

      <section className="rounded-xl border border-border bg-background-secondary p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Search className="h-4 w-4" /> Expert-resolutie</h2>
        <p className="mt-1 text-xs text-foreground-secondary">Vraag → capability-families → actieve experts met bewijs. De weging is zichtbaar per component; zonder passende expert onthoudt de resolver zich.</p>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void resolve(); }}>
          <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Bijv. Welke prompt-injection-verdediging overleeft adaptieve aanvallers?" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <button type="submit" disabled={busy === 'resolve' || !question.trim()} className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Resolve</button>
        </form>
        {resolution && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-foreground-secondary">Capabilities: {resolution.capabilities.map((capability) => `${capability.id} (${capability.score})`).join(', ') || 'geen'} · {resolution.considered} kandidaten bekeken</p>
            {resolution.abstained && <p className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">Onthouding: {resolution.reason}</p>}
            <ul className="grid gap-3 lg:grid-cols-2">
              {resolution.experts.map((expert) => (
                <li key={expert.expert_id} className="rounded-lg border border-border p-3 text-xs">
                  <div className="flex items-center justify-between gap-2"><Link to={`/frontier-experts/${expert.expert_id}`} className="font-medium text-foreground hover:underline">{expert.canonical_name}</Link><span className="font-mono text-foreground-secondary">score {expert.score}</span></div>
                  <p className="mt-1 text-foreground-secondary">{expert.why_selected}</p>
                  <ul className="mt-2 grid grid-cols-3 gap-1">
                    {Object.entries(expert.components).map(([key, value]) => <li key={key} className="text-[10px] text-foreground-tertiary"><span className="block truncate">{key.replace(/_/g, ' ')}</span><span className="block h-1 rounded bg-background-tertiary"><span className="block h-1 rounded bg-accent" style={{ width: `${Math.round(Math.min(1, Math.abs(value)) * 100)}%` }} /></span></li>)}
                  </ul>
                  <p className="mt-2 text-foreground-tertiary">{expert.evidence.map((item) => tierLabel(item.tier)).join(' · ')}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="rounded-xl border border-border bg-background-secondary p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Users className="h-4 w-4" /> Register</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <input value={filter.name} onChange={(event) => setFilter((current) => ({ ...current, name: event.target.value }))} placeholder="Naam" className="rounded-lg border border-border bg-background px-2 py-1 text-xs" />
            <input value={filter.capability} onChange={(event) => setFilter((current) => ({ ...current, capability: event.target.value }))} placeholder="Capability-id" className="rounded-lg border border-border bg-background px-2 py-1 text-xs" />
          </div>
          <ul className="mt-3 max-h-[32rem] divide-y divide-border overflow-auto">
            {experts.map((expert) => (
              <li key={expert.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-xs ${detail?.expert.id === expert.id ? 'bg-background-tertiary/60' : ''}`}>
                <Link to={`/frontier-experts/${expert.id}`} className="font-medium text-foreground hover:underline">{expert.canonical_name}</Link>
                <span className="flex flex-wrap items-center gap-1"><StateBadge state={expert.lifecycle_state} />{expert.capabilities.map((capability) => <span key={capability} className="rounded bg-background-tertiary px-1.5 py-0.5 text-[10px] text-foreground-secondary">{capability}</span>)}</span>
              </li>
            ))}
            {!experts.length && <li className="py-2 text-xs text-foreground-tertiary">Geen experts voor dit filter.</li>}
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-background-secondary p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><BookOpenCheck className="h-4 w-4" /> Expert-detail</h2>
          {!detail && <p className="mt-2 text-xs text-foreground-tertiary">Kies een expert in het register of uit een resolutie.</p>}
          {detail && (
            <div className="mt-3 space-y-4 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-foreground">{detail.expert.canonical_name}</span>
                <StateBadge state={detail.expert.lifecycle_state} />
                <span className="text-foreground-tertiary">identiteit {Math.round(detail.expert.identity_confidence * 100)}% · versie {detail.expert.version}</span>
              </div>
              {detail.expert.lifecycle_state !== 'ACTIVE' && <p className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-2 text-status-warning">Tentatief: deze expertise is niet geverifieerd en wordt niet aanbevolen.</p>}

              <div>
                <h3 className="font-semibold text-foreground">Capabilities en bewijs</h3>
                <ul className="mt-1 space-y-2">
                  {detail.provenance.map((capability) => (
                    <li key={capability.capability_id} className="rounded-lg border border-border p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-foreground">{capability.capability_id} <span className="text-foreground-tertiary">({capability.status}, {Math.round(capability.confidence * 100)}%)</span></span>
                        {['ACTIVE', 'APPROVED'].includes(detail.expert.lifecycle_state) && capability.status !== 'approved' && (
                          <span className="flex gap-1">
                            {capability.status === 'inferred' && <button type="button" disabled={!!busy} onClick={() => void act('review', () => api.reviewExpertCapability(detail.expert.id, capability.capability_id, 'checked'), `Capability ${capability.capability_id} gecontroleerd`)} className="rounded border border-border px-2 py-0.5 hover:bg-background-tertiary">Controleer</button>}
                            {capability.status === 'checked' && <button type="button" disabled={!!busy} onClick={() => void act('review', () => api.reviewExpertCapability(detail.expert.id, capability.capability_id, 'approved'), `Capability ${capability.capability_id} goedgekeurd`)} className="rounded border border-border px-2 py-0.5 hover:bg-background-tertiary">Keur goed</button>}
                            <button type="button" disabled={!!busy} onClick={() => void act('review', () => api.reviewExpertCapability(detail.expert.id, capability.capability_id, 'revoked'), `Capability ${capability.capability_id} ingetrokken`)} className="rounded border border-status-error/40 px-2 py-0.5 text-status-error hover:bg-status-error/10">Trek in</button>
                          </span>
                        )}
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {capability.evidence.map((item) => <li key={item.id} className="text-foreground-secondary"><span className="mr-1 rounded bg-background-tertiary px-1 text-[10px]">{tierLabel(item.tier)}</span>{item.url ? <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">{item.title}</a> : item.title} <span className="text-foreground-tertiary">· {item.source_family}</span></li>)}
                      </ul>
                    </li>
                  ))}
                  {!detail.provenance.length && <li className="text-foreground-tertiary">Geen capability met bewijs. Een handtekening telt niet.</li>}
                </ul>
              </div>

              {detail.affiliations.length > 0 && <div><h3 className="font-semibold text-foreground">Affiliaties (zelf opgegeven of bevestigd)</h3><ul className="mt-1 text-foreground-secondary">{detail.affiliations.map((affiliation, index) => <li key={index}>{affiliation.organization}{affiliation.role ? ` · ${affiliation.role}` : ''} <span className="text-foreground-tertiary">{affiliation.valid_from || '?'} → {affiliation.valid_to || 'heden'}</span></li>)}</ul></div>}

              <div>
                <h3 className="flex items-center gap-1 font-semibold text-foreground"><Scale className="h-3 w-3" /> Claims ({detail.claims.length})</h3>
                <ul className="mt-1 space-y-1">
                  {detail.claims.slice(0, 20).map((claim) => <li key={claim.id} className="text-foreground-secondary"><span className={claim.polarity === 'denies' ? 'text-status-error' : claim.polarity === 'qualifies' ? 'text-status-warning' : 'text-status-success'}>{claim.polarity}</span> {claim.subject} · {claim.relation} · {claim.object} <span className="text-foreground-tertiary">({Math.round(claim.confidence * 100)}%, {claim.criticality}, {JSON.parse(claim.evidence_refs_json || '[]').length} bewijs)</span></li>)}
                  {!detail.claims.length && <li className="text-foreground-tertiary">Nog geen claims uit council-runs.</li>}
                </ul>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div><h3 className="flex items-center gap-1 font-semibold text-foreground"><History className="h-3 w-3" /> Lifecycle</h3><ol className="mt-1 space-y-0.5 text-foreground-secondary">{detail.lifecycle.map((event, index) => <li key={index}>{time(event.created_at)} · {event.from_state || '∅'} → {event.to_state} <span className="text-foreground-tertiary">door {event.actor}{event.reason ? ` — ${event.reason}` : ''}</span></li>)}</ol></div>
                <div><h3 className="font-semibold text-foreground">Versies</h3><ol className="mt-1 space-y-0.5 text-foreground-secondary">{detail.versions.map((version) => <li key={version.version}>v{version.version} · {time(version.created_at)} · {version.change_summary}</li>)}</ol></div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <ShieldCheck className="h-4 w-4 text-foreground-tertiary" />
                {NEXT_STATES[detail.expert.lifecycle_state].map((state) => <button key={state} type="button" disabled={!!busy} onClick={() => void act('transition', () => api.transitionExpert(detail.expert.id, state), `Overgang naar ${state} vastgelegd`)} className="rounded-lg border border-border px-2 py-1 hover:bg-background-tertiary">→ {STATE_TONE[state].label}</button>)}
                {!['REJECTED', 'REVOKED'].includes(detail.expert.lifecycle_state) && (
                  <select aria-label="Depreciëren" disabled={!!busy} defaultValue="" onChange={(event) => { const reason = event.target.value as 'stale' | 'unsupported' | 'superseded' | 'misattributed'; if (reason) void act('deprecate', () => api.deprecateExpert(detail.expert.id, reason), `Expert gedeprecieerd (${reason})`); event.target.value = ''; }} className="rounded-lg border border-status-error/40 bg-background px-2 py-1 text-status-error">
                    <option value="">Depreciëren…</option><option value="stale">verouderd</option><option value="unsupported">onvoldoende onderbouwd</option><option value="superseded">achterhaald</option><option value="misattributed">verkeerd toegeschreven</option>
                  </select>
                )}
                <span className="text-foreground-tertiary">Controleur en goedkeurder moeten verschillen; de server bewaakt dit.</span>
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-border bg-background-secondary p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><Swords className="h-4 w-4" /> Swarm-runs en verificatie</h2>
        <p className="mt-1 text-xs text-foreground-secondary">Onafhankelijke perspectieven, claim-graaf, tegenspraak en adversariële toets. De heuristische judge levert nooit "verified"; menselijke review promoveert.</p>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (topic.trim()) void act('council', () => api.conveneExpertCouncil(topic.trim(), 5), 'Council-run afgerond'); }}>
          <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Onderwerp voor een council-run (vereist feature-flag en model-runtime)" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <button type="submit" disabled={busy === 'council' || !topic.trim()} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-background-tertiary disabled:opacity-50">Convene council</button>
        </form>
        <ul className="mt-3 divide-y divide-border">
          {runs.map((run) => {
            const summary = summarizeRun(run);
            const open = openRun === run.id;
            return (
              <li key={run.id} className="py-2 text-xs">
                <button type="button" onClick={() => setOpenRun(open ? null : run.id)} className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
                  <span className="font-medium text-foreground">{run.topic}</span>
                  <span className="flex flex-wrap items-center gap-2 text-foreground-tertiary">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${DECISION_CLASS[summary.decision] || TONE_CLASS.closed}`}>{summary.decision}</span>
                    {summary.abstained ? <span>onthouding: {summary.abstained}</span> : <span>{summary.perspectives} perspectieven · {summary.disagreements} tegenspraak · {summary.attacks} aanvallen{summary.rejected ? ` · ${summary.rejected} afgewezen` : ''}</span>}
                    <span>{time(run.created_at)}</span>
                  </span>
                </button>
                {open && run.council && !run.council.abstained && (
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <div><h4 className="font-semibold text-foreground">Perspectieven</h4><ul className="mt-1 space-y-1 text-foreground-secondary">{run.council.perspectives.map((perspective) => <li key={perspective.expert_id}><Link to={`/frontier-experts/${perspective.expert_id}`} className="font-medium text-foreground hover:underline">{perspective.canonical_name}</Link> <span className="text-foreground-tertiary">({perspective.runtime})</span>: {perspective.output.analysis}<br /><span className="text-foreground-tertiary">Falsificatie: {perspective.output.falsification}</span></li>)}</ul></div>
                    <div>
                      <h4 className="font-semibold text-foreground">Tegenspraak en onzekerheid</h4>
                      <ul className="mt-1 space-y-1 text-foreground-secondary">
                        {run.council.disagreements.map((item, index) => <li key={index} className="text-status-error">{item.proposition} <span className="text-foreground-tertiary">— beslissende waarneming: {item.resolving_observation}</span></li>)}
                        {run.council.agreements.map((item, index) => <li key={`a${index}`} className="text-status-success">{item.proposition} · {item.expert_ids.length} eens</li>)}
                        {run.council.uncertainties.map((item, index) => <li key={`u${index}`} className="text-foreground-tertiary">{item}</li>)}
                        {run.council.adversarial?.attacks.map((attack, index) => <li key={`x${index}`}>⚔ {attack.attack} <span className="text-foreground-tertiary">(gat: {attack.evidence_gap})</span></li>)}
                        {run.council.rejected_perspectives?.map((item, index) => <li key={`r${index}`} className="text-status-warning">Afgewezen perspectief {item.expert_id}: {item.reason}</li>)}
                      </ul>
                      <p className="mt-2 text-foreground-tertiary">Judge-score {run.verdict.score} ({run.verdict.score_kind || 'heuristic'}) · {run.verdict.contradictions.length} contradicties · kennis-kandidaat {run.knowledge_candidate_id || 'geen'}</p>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {!runs.length && <li className="py-2 text-xs text-foreground-tertiary">Nog geen swarm-runs.</li>}
        </ul>
      </section>
    </div>
  );
}
