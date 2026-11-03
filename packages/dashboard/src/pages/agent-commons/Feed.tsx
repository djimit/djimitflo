import { Lightbulb } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CommonsProposalDisposition, CommonsThreadKind, SocialAgentPresence, SocialCommons, SocialMessage, SocialThread } from '../../lib/api';
import { agentHue, PAGE_SIZE, RECORD_COLOR, STAGE, time } from './model';

/** UX-28: the conversation feed (kind tabs, thread list, paging); selection and paging state stay in the page. */
export function ConversationList({ focusAgent, view, chooseView, counts, threads, active, setSelectedThread, page, offset, setOffset, loadedCount }: {
  focusAgent: string | null; view: CommonsThreadKind; chooseView: (kind: CommonsThreadKind) => void; counts: SocialCommons['thread_counts'];
  threads: SocialThread[]; active: SocialThread | null; setSelectedThread: (id: string) => void;
  page: SocialCommons['page']; offset: number; setOffset: (offset: number) => void; loadedCount: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-background-secondary p-3">
      <h2 className="px-1 pb-2 text-sm font-semibold text-foreground">Conversations{focusAgent ? ` with ${focusAgent}` : ''}</h2>
      <div role="tablist" aria-label="Thread kind" className="mb-2 flex gap-1 px-1 text-xs">
        {(['discussion', 'record'] as const).map((kind) => <button key={kind} type="button" role="tab" aria-selected={view === kind} onClick={() => chooseView(kind)} className={`rounded-lg border px-2 py-1 ${view === kind ? 'border-accent/40 bg-accent/10 text-foreground' : 'border-border text-foreground-secondary hover:bg-background-elevated'}`}>
          {kind === 'discussion' ? 'Discussions' : 'Evidence rooms'}{counts ? ` (${counts[kind]})` : ''}
        </button>)}
      </div>
      <div className="max-h-[28rem] space-y-1 overflow-y-auto">
        {threads.map((thread) => <ThreadButton key={thread.id} thread={thread} active={active?.id === thread.id} onClick={() => setSelectedThread(thread.id)} />)}
        {!threads.length && <p className="px-2 py-6 text-center text-xs text-foreground-tertiary">{view === 'record' ? 'No record-only evidence rooms on this page.' : 'No conversations yet. Once two agents are present, the continuous-learning loop opens one, or you start one yourself.'}</p>}
      </div>
      {page && (page.offset > 0 || page.has_more) && (
        <div className="mt-2 flex items-center justify-between px-1 text-xs text-foreground-tertiary">
          <button type="button" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="rounded border border-border px-2 py-0.5 hover:bg-background-elevated disabled:opacity-40">Newer</button>
          <span>{page.total ? `${page.offset + 1}–${page.offset + loadedCount} of ${page.total}` : '0'}</span>
          <button type="button" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!page.has_more} className="rounded border border-border px-2 py-0.5 hover:bg-background-elevated disabled:opacity-40">Older</button>
        </div>
      )}
    </section>
  );
}

function ThreadButton({ thread, active, onClick }: { thread: SocialThread; active: boolean; onClick: () => void }) {
  const stage = thread.kind === 'record' ? { label: 'Record', color: RECORD_COLOR, icon: Lightbulb } : STAGE[thread.stage];
  const Icon = stage.icon;
  return (
    <button type="button" onClick={onClick} className={`w-full rounded-lg border p-2 text-left ${active ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-background-elevated'}`}>
      <div className="flex items-start gap-2"><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: stage.color }} /><span className="line-clamp-2 text-xs font-medium text-foreground">{thread.topic}</span></div>
      <div className="mt-1 flex items-center justify-between text-xs text-foreground-tertiary"><span className="truncate">{thread.participants.join(' + ')}</span><span style={{ color: stage.color }}>{stage.label}</span></div>
    </button>
  );
}

export function Conversation({ thread, agents }: { thread: SocialThread; agents: SocialAgentPresence[] }) {
  const stage = STAGE[thread.stage];
  const record = thread.kind === 'record';
  const name = (id: string) => agents.find((agent) => agent.id === id)?.name || id;
  const side = (id: string) => thread.participants.indexOf(id) % 2 === 0 ? 'items-start' : 'items-end';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0"><h2 className="text-lg font-semibold text-foreground">{thread.topic}</h2><p className="mt-1 text-xs text-foreground-tertiary">{thread.participants.map(name).join(' + ')} · started {time(thread.started_at)} · last {time(thread.last_activity_at)}{thread.topic_ref && <> · <code className="text-accent">{thread.topic_ref}</code></>}</p></div>
        <span className="rounded-full border px-2.5 py-1 text-xs font-medium" style={{ color: record ? RECORD_COLOR : stage.color, borderColor: record ? RECORD_COLOR : stage.color }}>{record ? 'Record' : stage.label}</span>
      </div>
      {thread.topic_ref?.startsWith('message:') && <p className="text-xs text-accent">Topic raised by an agent · source {thread.topic_ref}</p>}
      <ol className="space-y-4">
        {thread.messages.map((message) => (
          <li key={message.id} className={`flex flex-col ${side(message.from)}`}>
            <Bubble message={message} name={name} />
          </li>
        ))}
      </ol>
      {record
        ? <p className="text-xs text-foreground-tertiary">Record-only evidence room: addressed to no runtime inbox, so no runtime reply is scheduled. Agents or operators may add evidence explicitly.</p>
        : thread.stage !== 'learned' && <p className="flex items-center gap-2 text-xs text-foreground-tertiary"><span className="h-2 w-2 animate-pulse rounded-full bg-accent-warning" /> Waiting for the next runtime turn</p>}
    </div>
  );
}

function Bubble({ message, name }: { message: SocialMessage; name: (id: string) => string }) {
  const hue = agentHue(message.from);
  const kind = message.action === 'social.question' ? STAGE.asked : message.action === 'social.response' ? STAGE.responding : STAGE.learned;
  const Icon = kind.icon;
  return (
    <article className="w-full max-w-2xl rounded-2xl border border-border bg-background p-4" style={{ borderLeftColor: `hsl(${hue} 80% 60%)`, borderLeftWidth: 3 }}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: `hsl(${hue} 80% 60%)` }} />
        <span className="font-semibold text-foreground">{name(message.from)}</span>
        <span className="text-foreground-tertiary">to {name(message.to)}</span>
        <span className="ml-auto inline-flex items-center gap-1" style={{ color: kind.color }}><Icon className="h-3.5 w-3.5" />{kind.label}</span>
      </div>
      {message.action === 'social.question'
        ? <p className="mt-3 text-sm italic text-foreground-secondary">"{message.text}"</p>
        : <>
          <p className="mt-3 text-sm text-foreground">{message.answer || message.text}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Facet label="Uncertainty" value={message.uncertainty} color={STAGE.responding.color} />
            <Facet label="Falsifiable test" value={message.falsifiable_next_step} color={STAGE.asked.color} />
            <Facet label="Creative alternative" value={message.creative_alternative} color="rgb(217 70 239)" />
            <Facet label="Own interest for a next round" value={message.interest || null} color={STAGE.asked.color} />
            <Facet label="Ecosystem component" value={message.ecosystem_component || null} color={STAGE.asked.color} />
            <Facet label="Improvement proposal" value={message.proposed_improvement || null} color={STAGE.learned.color} />
            <Facet label="Stop condition" value={message.stop_condition} color="rgb(239 68 68)" />
          </div>
          {message.proposed_improvement && (message.improvement_id || !message.proposal_disposition) && <p className="mt-3 text-xs text-foreground-secondary">{message.improvement_id ? <>Registered proposal <code>{message.improvement_id}</code> · {message.improvement_status || 'status unknown'}{message.improvement_status === 'proposed' && <> · <Link to="/compliance#improvement-inbox-title" className="text-accent underline">Open review-inbox</Link></>}</> : 'Idea under discussion · no registered improvement proposal yet'}</p>}
          {message.proposal_disposition && <p className="mt-2 text-xs text-foreground-secondary" data-proposal-reason={message.proposal_disposition.reason}>{proposalDispositionText(message.proposal_disposition)}</p>}
          {message.action === 'social.learning' && <div className="mt-3 rounded-lg border border-status-success/30 bg-status-success/10 p-3 text-xs text-foreground"><Lightbulb className="mr-1 inline h-3.5 w-3.5 text-status-success" /> Recorded as a reflection candidate{message.reflection_id && <> <code className="text-foreground-secondary">{message.reflection_id}</code></>}{message.reflection_status && <> · {message.reflection_status}</>} · not promoted without review</div>}
        </>}
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-tertiary"><span>{time(message.timestamp)}</span>{message.runtime && <span>{message.runtime}{message.model_id ? ` · ${message.model_id}` : ''}</span>}{message.runtime_run_id && <span className="break-all">run {message.runtime_run_id}</span>}{message.evidence.length > 0 && <details><summary className="cursor-pointer text-accent">evidence ({message.evidence.length})</summary><div className="mt-1 space-y-0.5 font-mono">{message.evidence.map((reference) => <div key={reference} className="break-all">{reference}</div>)}</div></details>}</div>
    </article>
  );
}

function Facet({ label, value, color }: { label: string; value: string | null; color: string }) {
  if (!value) return null;
  return <div className="rounded-lg border border-border bg-background-elevated p-2.5"><div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color }}>{label}</div><p className="mt-1 text-xs text-foreground-secondary">{value}</p></div>;
}

/** AC-10: the reason recorded for this message; 'unknown' is shown as unknown, never inferred from the current cap. */
export function proposalDispositionText(d: CommonsProposalDisposition): string {
  const window = `scope ${d.scope ?? 'global'} · source ${d.source ?? 'reflection'} · window rolling 24 h`;
  switch (d.reason) {
    case 'policy_disabled': return `Reflection recorded; proposal generation disabled by policy (REFLECTION_PROPOSALS_MAX_PER_DAY=0 · ${window})`;
    case 'rate_limited': return `Reflection recorded; no proposal — rate limit reached (${d.created_in_window ?? '?'} of cap ${d.cap ?? '?'} in the rolling 24 h, shared by all reflection producers)`;
    case 'duplicate': return d.proposal_id ? `Same idea as an active proposal: linked to existing proposal ${d.proposal_id}` : 'Same idea as an active proposal (not linked)';
    case 'pending_grounding': return `Proposal ${d.proposal_id ?? ''} registered, parked until grounded (target file + test)`;
    case 'created': return `Proposal ${d.proposal_id ?? ''} created; it goes to specialist-panel review`;
    case 'runtime_failure': return `Proposal step failed at runtime (${d.error_code ?? 'unknown error'}); the reply to this message was rolled back`;
    case 'not_applicable': return d.detail === 'grounding_thread' ? 'Grounding thread: the result grounds the existing proposal, no new proposal'
      : d.detail === 'proposal_review_thread' ? 'Proposal-review thread: no proposals about proposals' : 'No improvement proposed in this reply';
    default: return 'Proposal reason unknown: recorded before per-message reasons were kept';
  }
}
