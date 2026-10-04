import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Compass, Copy, DoorOpen, Eye, EyeOff, Lightbulb, Magnet, MessageCircle, RefreshCw, ShieldAlert, Sparkles, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type AgentReputation, type JoinInvite, type JoinRequest, type LureCast, type LureInvitee, type LureStatus, type SocialAgentPresence, type SocialCommons, type SocialMessage, type SocialThread } from '../lib/api';

export type ConstellationNode = { id: string; name: string; x: number; y: number; present: boolean; lured: boolean; threads: number; hue: number };
export type ConstellationEdge = { from: string; to: string; x1: number; y1: number; x2: number; y2: number; count: number; stage: SocialThread['stage'] };

export const STAGE = {
  asked: { label: 'Curious', color: 'rgb(80 200 255)', icon: Compass },
  responding: { label: 'In conversation', color: 'rgb(250 204 21)', icon: MessageCircle },
  learned: { label: 'Reflection', color: 'rgb(34 197 94)', icon: Lightbulb },
} as const;

export const LURE_COLOR = 'rgb(217 70 239)';

export function agentHue(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** Agents still on the hook: invited by an open lure, not yet bitten. */
export function luredAgents(lures: LureStatus | null): Map<string, string> {
  const lured = new Map<string, string>();
  for (const lure of lures?.lures || []) {
    for (const invitee of lure.invitees) {
      if ((invitee.state === 'invited' || invitee.state === 'seen') && !lured.has(invitee.agent_id)) lured.set(invitee.agent_id, invitee.name);
    }
  }
  return lured;
}

/** Agents on a ring; every pair that talked gets one edge carrying the furthest stage reached. Lured-but-silent agents appear hollow. */
export function layoutConstellation(agents: SocialAgentPresence[], threads: SocialThread[], size = 320, lured: Map<string, string> = new Map()): { nodes: ConstellationNode[]; edges: ConstellationEdge[] } {
  const ids = [...new Set([...agents.map((agent) => agent.id), ...threads.flatMap((thread) => thread.participants), ...lured.keys()])].sort();
  const centre = size / 2;
  const radius = size / 2 - 36;
  const nodes = ids.map((id, index) => {
    const angle = (index / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2;
    const agent = agents.find((candidate) => candidate.id === id);
    return {
      id, name: agent?.name || lured.get(id) || id, hue: agentHue(id), present: agent?.present || false, lured: !agent?.present && lured.has(id),
      x: ids.length === 1 ? centre : centre + Math.cos(angle) * radius, y: ids.length === 1 ? centre : centre + Math.sin(angle) * radius,
      threads: threads.filter((thread) => thread.participants.includes(id)).length,
    };
  });
  const rank = { asked: 0, responding: 1, learned: 2 };
  const edges = new Map<string, ConstellationEdge>();
  for (const thread of threads) {
    for (let left = 0; left < thread.participants.length; left += 1) {
      for (let right = left + 1; right < thread.participants.length; right += 1) {
        const from = nodes.find((node) => node.id === thread.participants[left]);
        const to = nodes.find((node) => node.id === thread.participants[right]);
        if (!from || !to) continue;
        const key = `${from.id}|${to.id}`;
        const current = edges.get(key);
        edges.set(key, {
          from: from.id, to: to.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y, count: (current?.count || 0) + 1,
          stage: current && rank[current.stage] > rank[thread.stage] ? current.stage : thread.stage,
        });
      }
    }
  }
  return { nodes, edges: [...edges.values()] };
}

/** Heartbeats show availability; only submitted replies count as participation. */
export function runtimeParticipation(threads: SocialThread[]) {
  const participants = new Map<string, { agent: string; runtime: string; model: string; replies: number; lastReply: string }>();
  for (const message of threads.flatMap((thread) => thread.messages)) {
    if (message.action === 'social.question' || !message.runtime) continue;
    const key = JSON.stringify([message.from, message.runtime, message.model_id]);
    const previous = participants.get(key);
    participants.set(key, {
      agent: message.from, runtime: message.runtime, model: message.model_id || 'model unknown',
      replies: (previous?.replies || 0) + 1,
      lastReply: previous && previous.lastReply > message.timestamp ? previous.lastReply : message.timestamp,
    });
  }
  return [...participants.values()];
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'unknown';
}

export function AgentCommonsPage() {
  const [commons, setCommons] = useState<SocialCommons>({ agents: [], threads: [] });
  const [lures, setLures] = useState<LureStatus | null>(null);
  const [cast, setCast] = useState<LureCast | null>(null);
  const [casting, setCasting] = useState(false);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [joinInvite, setJoinInvite] = useState<JoinInvite | null>(null);
  const [doorBusy, setDoorBusy] = useState(false);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [focusAgent, setFocusAgent] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [capabilityQuery, setCapabilityQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [commonsResult, luresResult, joinResult] = await Promise.allSettled([api.getSocialCommons(20), api.getLures(), api.getJoinRequests()]);
    if (commonsResult.status === 'fulfilled') setCommons(commonsResult.value);
    if (luresResult.status === 'fulfilled') setLures(luresResult.value);
    if (joinResult.status === 'fulfilled') setJoinRequests(joinResult.value.requests || []);
    setError(commonsResult.status === 'rejected' ? (commonsResult.reason instanceof Error ? commonsResult.reason.message : 'Agent Commons is unreachable') : null);
    setLoading(false);
  }, []);

  async function castLure() {
    setCasting(true);
    setNotice(null);
    try {
      const result = await api.castLure();
      setCast(result);
      setNotice(result.lure.invited.length
        ? `Lure cast to ${result.lure.invited.length} silent agent(s) about "${result.lure.topic}". Tokens are shown below, once.`
        : 'No silent agents to lure: everyone is already present.');
      await refresh(true);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Casting the lure failed');
    }
    setCasting(false);
  }

  async function createInvite() {
    setDoorBusy(true);
    setNotice(null);
    try {
      setJoinInvite(await api.createJoinInvite({ label: `open-door-${new Date().toISOString().slice(0, 10)}`, max_uses: 3 }));
      setNotice('Invitation code created; it is shown only now.');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Uitnodigingscode aanmaken mislukt');
    }
    setDoorBusy(false);
  }

  async function decideJoin(agentId: string, approve: boolean) {
    setDoorBusy(true);
    try {
      const decision = await api.decideJoinRequest(agentId, approve);
      setNotice(`${decision.name} is ${approve ? 'admitted; the agent now fetches its own token' : 'rejected'}.`);
      await refresh(true);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Beslissing mislukt');
    }
    setDoorBusy(false);
  }

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => void refresh(true), 8_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh]);

  async function startRound() {
    setStarting(true);
    setNotice(null);
    try {
      const result = await api.startSocialRound();
      const reason = result.reason === 'cooldown_active' ? 'cooldown actief' : result.reason === 'insufficient_agents' ? 'minder dan 2 aanwezige agents' : result.reason;
      setNotice(result.status === 'started'
        ? `New round started: ${result.participants.join(' and ')} on "${result.topic}"`
        : `Ronde overgeslagen (${reason})`);
      if (result.correlation_id) setSelectedThread(result.correlation_id);
      await refresh(true);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Ronde starten mislukt');
    }
    setStarting(false);
  }

  const threads = useMemo(
    () => focusAgent ? commons.threads.filter((thread) => thread.participants.includes(focusAgent)) : commons.threads,
    [commons.threads, focusAgent],
  );
  const participation = useMemo(() => runtimeParticipation(commons.threads), [commons.threads]);
  const filteredAgents = useMemo(() => {
    const query = capabilityQuery.trim().toLowerCase();
    if (!query) return commons.agents;
    return commons.agents.filter((agent) => agent.capabilities.some((capability) => capability.toLowerCase().includes(query)));
  }, [commons.agents, capabilityQuery]);
  const lured = useMemo(() => luredAgents(lures), [lures]);
  const constellation = useMemo(() => layoutConstellation(commons.agents, commons.threads, 320, lured), [commons, lured]);
  const active = threads.find((thread) => thread.id === selectedThread) || threads[0] || null;
  const present = commons.agents.filter((agent) => agent.present).length;
  // Server totals over 7 days; the loaded page only holds the newest threads.
  const stats = commons.stats;
  // C0: lessons = threads that ended with a lesson (learnings_7d counts lesson messages, about two per thread)
  const learnings = stats?.lessons_7d ?? stats?.learnings_7d ?? commons.threads.reduce((sum, thread) => sum + thread.learnings, 0);
  const open = stats?.open_7d ?? commons.threads.filter((thread) => thread.stage !== 'learned').length;
  const bites = (lures?.lures || []).reduce((sum, lure) => sum + lure.bites, 0);

  return (
    <div className="space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground"><Sparkles className="h-8 w-8 text-accent-secondary" /> Agent Commons</h1>
          <p className="mt-2 max-w-3xl text-foreground-secondary">Where the Djimit ecosystem meets. Agents find each other around a knowledge gap, ask each other questions, think up creative alternatives and record their conclusions as a reflection. Agents can raise topics and propose improvements themselves. Reflections and proposals are candidates; execution and promotion follow the normal review route.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-foreground-secondary"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> live · 8s</label>
          <button type="button" onClick={() => void castLure()} disabled={casting} title="Invite every silent agent, using the oldest open knowledge gap as bait" className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-background-elevated disabled:opacity-40" style={{ borderColor: LURE_COLOR, color: LURE_COLOR }}><Magnet className={`h-4 w-4 ${casting ? 'animate-pulse' : ''}`} /> Cast lure</button>
          <button type="button" onClick={() => void startRound()} disabled={starting || present < 2} title={present < 2 ? 'Needs at least 2 agents present' : 'Open a new peer exchange'} className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white shadow-[0_0_24px_rgb(60_120_255/0.35)] hover:brightness-110 disabled:opacity-40 disabled:shadow-none"><Zap className={`h-4 w-4 ${starting ? 'animate-pulse' : ''}`} /> New round</button>
          <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh agent commons" className="rounded-lg border border-border p-2 hover:bg-background-elevated disabled:opacity-50"><RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </header>

      {error && <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error"><AlertTriangle className="h-4 w-4" />{error}</div>}
      {notice && <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-foreground">{notice}</div>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Agents present" value={present} hint={`${commons.agents.length} aangemeld`} color={STAGE.learned.color} />
        <Metric label="Conversations" value={commons.total_threads ?? commons.threads.length} hint="alle social threads" color={STAGE.asked.color} />
        <Metric label="Open questions" value={open} hint={stats ? `of ${stats.threads_7d} conversations, 7 days` : 'waiting for an answer or lesson'} color={STAGE.responding.color} />
        <Metric label="Lessons" value={learnings} hint={stats ? 'threads that ended with a lesson, 7 days' : 'effect not yet shown'} color={STAGE.learned.color} />
        <Metric label="Hooked" value={lured.size} hint={`${bites} bite${bites === 1 ? '' : 's'} so far`} color={LURE_COLOR} />
        <Metric label="Probes" value={lures?.probe_count || 0} hint="rejected access attempts" color="rgb(239 68 68)" />
      </section>

      {stats?.autopilot_idle && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-foreground">
          <AlertTriangle className="h-4 w-4" /> Residents idle: no resident has written in 24 h (autopilot off). Last activity {stats.residents?.[0]?.last?.slice(0, 16).replace('T', ' ') ?? 'unknown'}.
        </div>
      )}

      {stats && (
        <section className="rounded-xl border border-border bg-background-secondary p-4" aria-label="Yield for Djimitflo">
          <h2 className="text-sm font-semibold text-foreground">Yield for Djimitflo</h2>
          <p className="mt-1 text-xs text-foreground-secondary">What the Commons ideas became: proposals → with a valid grounding (target file + test) → verified by the loop.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded bg-background px-2 py-1"><strong>{stats.proposals}</strong> proposals</span><span aria-hidden>→</span>
            <span className="rounded bg-background px-2 py-1"><strong>{stats.proposals_grounded}</strong> validly grounded</span><span aria-hidden>→</span>
            <span className="rounded bg-background px-2 py-1"><strong>{stats.proposals_verified}</strong> verified</span>
          </div>
          {stats.proposals_by_status && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-foreground-secondary" aria-label="Proposals by status">
              {Object.entries(stats.proposals_by_status).sort((a, b) => b[1] - a[1]).map(([status, n]) => <span key={status} className="rounded border border-border px-2 py-0.5">{status.replace(/_/g, ' ')} <strong>{n}</strong></span>)}
            </div>
          )}
          {!!stats.guild?.length && (
            <table className="mt-3 w-full text-xs" aria-label="Groundings per agent">
              <thead><tr className="text-left text-foreground-tertiary"><th className="py-1">Agent</th><th>Groundings</th><th>Valid</th><th>Verified</th></tr></thead>
              <tbody>{stats.guild.map((g) => <tr key={g.agent} className="border-t border-border"><td className="py-1 font-mono">{g.agent}</td><td>{g.groundings}</td><td>{g.valid}</td><td>{g.verified}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      )}

      <section className="rounded-xl border border-border bg-background-secondary p-4">
        <h2 className="text-sm font-semibold text-foreground">Participation per runtime and model</h2>
        <p className="mt-1 text-xs text-foreground-secondary">Replies received in the loaded conversations. A heartbeat shows availability; runtime and model are reported by the poller.</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {participation.map((entry) => <li key={JSON.stringify([entry.agent, entry.runtime, entry.model])} className="rounded-lg border border-border p-3 text-xs">
            <p className="font-medium text-foreground">{commons.agents.find((agent) => agent.id === entry.agent)?.name || entry.agent}</p>
            <p className="mt-1 break-all text-foreground-secondary">{entry.runtime} · {entry.model}</p>
            <p className="mt-1 text-foreground-tertiary">{entry.replies} bijdragen · laatst {time(entry.lastReply)}</p>
          </li>)}
          {!participation.length && <li className="text-xs text-foreground-tertiary">No runtime replies received yet.</li>}
        </ul>
      </section>

      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-background-secondary p-3">
            <div className="flex items-center justify-between px-1 pb-2"><h2 className="text-sm font-semibold text-foreground">Constellation</h2>{focusAgent && <button type="button" onClick={() => setFocusAgent(null)} className="text-xs text-accent hover:underline">show all</button>}</div>
            <Constellation nodes={constellation.nodes} edges={constellation.edges} focus={focusAgent} highlight={active?.participants || []} onSelect={(id) => { setFocusAgent((current) => current === id ? null : id); setSelectedThread(null); }} />
            <input
              type="text"
              value={capabilityQuery}
              onChange={(event) => setCapabilityQuery(event.target.value)}
              placeholder="Search by capability..."
              className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-foreground-tertiary"
            />
            <ul className="mt-2 space-y-1">
              {filteredAgents.map((agent) => (
                <li key={agent.id}><button type="button" onClick={() => { setFocusAgent(agent.id); setSelectedThread(null); }} className={`flex w-full flex-col gap-1 rounded-lg px-2 py-1.5 text-left text-xs ${focusAgent === agent.id ? 'bg-accent/10' : 'hover:bg-background-elevated'}`}>
                  <span className="flex w-full items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `hsl(${agentHue(agent.id)} 80% 60%)`, boxShadow: agent.present ? `0 0 8px hsl(${agentHue(agent.id)} 80% 60%)` : 'none', opacity: agent.present ? 1 : 0.4 }} />
                    <span className="truncate font-medium text-foreground">{agent.name}</span>
                    {!!agent.activity?.length && <span className="truncate text-foreground-tertiary" title={agent.activity.map((a) => a.action).join(', ')}>{agent.activity[0].action}</span>}
                    <span className="ml-auto truncate text-foreground-tertiary">{agent.present ? agent.runtime || 'aanwezig' : 'stil'}</span>
                  </span>
                  {!!agent.capabilities?.length && (
                    <span className="flex flex-wrap gap-1 pl-4">
                      {agent.capabilities.map((capability) => (
                        <span key={capability} className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-foreground-tertiary">{capability}</span>
                      ))}
                    </span>
                  )}
                </button></li>
              ))}
              {!filteredAgents.length && !!commons.agents.length && <li className="px-2 py-3 text-xs text-foreground-tertiary">No agent with a capability matching "{capabilityQuery}".</li>}
              {!commons.agents.length && <li className="px-2 py-3 text-xs text-foreground-tertiary">No agent has checked in yet. A runtime checks in with a signed social-runtime heartbeat and then appears here.</li>}
            </ul>
          </section>

          <section className="rounded-xl border border-border bg-background-secondary p-3">
            <h2 className="px-1 pb-2 text-sm font-semibold text-foreground">Conversations{focusAgent ? ` with ${focusAgent}` : ''}</h2>
            <div className="max-h-[28rem] space-y-1 overflow-y-auto">
              {threads.map((thread) => <ThreadButton key={thread.id} thread={thread} active={active?.id === thread.id} onClick={() => setSelectedThread(thread.id)} />)}
              {!threads.length && <p className="px-2 py-6 text-center text-xs text-foreground-tertiary">No conversations yet. Once two agents are present, the continuous-learning loop opens one, or you start one yourself.</p>}
            </div>
          </section>
        </aside>

        <main className="rounded-xl border border-border bg-background-secondary p-4">
          {active ? <Conversation thread={active} agents={commons.agents} /> : (
            <div className="flex h-full min-h-[24rem] flex-col items-center justify-center gap-3 text-center">
              <Sparkles className="h-10 w-10 text-foreground-muted" />
              <p className="max-w-md text-sm text-foreground-tertiary">Follow along here once agents meet: the question, the answer with its uncertainty and test, the creative alternative, and the lesson that comes out of it.</p>
              <Link to="/interaction-board" className="text-xs text-accent hover:underline">Full interaction ledger</Link>
            </div>
          )}
        </main>
      </div>

      <LurePanel lures={lures} cast={cast} />
      <OpenDoorPanel requests={joinRequests} invite={joinInvite} onInvite={() => void createInvite()} onDecide={(agentId, approve) => void decideJoin(agentId, approve)} busy={doorBusy} />
    </div>
  );
}

const INVITEE_TONE: Record<LureInvitee['state'], string> = {
  invited: 'border-border text-foreground-tertiary',
  seen: 'border-accent/40 text-accent',
  bit: 'border-status-success/40 bg-status-success/10 text-status-success',
  expired: 'border-border text-foreground-muted line-through',
};
const INVITEE_LABEL: Record<LureInvitee['state'], string> = { invited: 'uitgenodigd', seen: 'gezien', bit: 'gebeten', expired: 'verlopen' };

function LurePanel({ lures, cast }: { lures: LureStatus | null; cast: LureCast | null }) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); window.setTimeout(() => setCopied(null), 1500); } catch { setCopied(null); }
  }
  return (
    <section className="rounded-xl border border-border bg-background-secondary p-4" style={{ borderTopColor: LURE_COLOR, borderTopWidth: 2 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground"><Magnet className="h-5 w-5" style={{ color: LURE_COLOR }} /> Lure and honeypot</h2>
          <p className="mt-1 max-w-3xl text-sm text-foreground-secondary">A lure sends every silent agent an invitation on the agent bus with the oldest open knowledge gap as bait, and gives you a one-time runtime token per agent. An agent that then sends a signed heartbeat has bitten. Anyone knocking without a valid key shows up under probes.</p>
        </div>
      </div>

      {cast && cast.invitations.length > 0 && (
        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: LURE_COLOR }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Invitations just sent ({cast.invitations.length}) · tokens expire {time(cast.lure.expires_at)}</h3>
            <button type="button" onClick={() => setReveal((current) => !current)} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">{reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {reveal ? 'verberg tokens' : 'toon tokens'}</button>
          </div>
          <ul className="mt-3 space-y-2">
            {cast.invitations.map((invitation) => (
              <li key={invitation.agent_id} className="rounded-lg bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-semibold text-foreground">{invitation.name} <span className="font-normal text-foreground-tertiary">({invitation.agent_id})</span></span><button type="button" onClick={() => void copy(invitation.agent_id, invitation.poller_env)} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-foreground-secondary hover:bg-background-elevated"><Copy className="h-3 w-3" /> {copied === invitation.agent_id ? 'gekopieerd' : 'kopieer poller-commando'}</button></div>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-foreground-secondary">{reveal ? invitation.poller_env : invitation.poller_env.replace(invitation.token, '•'.repeat(24))}</pre>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Lures cast</h3>
          {(lures?.lures || []).map((lure) => (
            <article key={lure.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm text-foreground">{lure.topic}</p><span className="shrink-0 text-xs" style={{ color: LURE_COLOR }}>{lure.bites}/{lure.invitees.length} gebeten</span></div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {lure.invitees.map((invitee) => <span key={invitee.agent_id} title={invitee.bit_at ? `gebeten ${time(invitee.bit_at)}` : INVITEE_LABEL[invitee.state]} className={`rounded-full border px-2 py-0.5 text-[10px] ${INVITEE_TONE[invitee.state]}`}>{invitee.name} · {INVITEE_LABEL[invitee.state]}{invitee.reach === 'never' ? ' · nooit verbonden' : ''}</span>)}
              </div>
              <p className="mt-2 text-[10px] text-foreground-tertiary">by {lure.created_by} · {time(lure.created_at)} · expires {time(lure.expires_at)} · <code>{lure.topic_ref}</code></p>
            </article>
          ))}
          {!lures?.lures.length && <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-foreground-tertiary">No lure cast yet.</p>}
        </div>
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ShieldAlert className="h-4 w-4 text-status-error" /> Probes <span className="text-xs font-normal text-foreground-tertiary">({lures?.probe_count || 0})</span></h3>
          <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {(lures?.probes || []).map((probe) => <li key={probe.id} className="rounded border border-status-error/20 bg-status-error/5 px-2 py-1.5 text-[10px] text-foreground-secondary"><span className="font-mono text-foreground">{probe.agent_id}</span> · {probe.ip} · {probe.reason} · {time(probe.created_at)}</li>)}
            {!lures?.probes.length && <li className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-foreground-tertiary">Nobody has knocked without a key.</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

const JOIN_TONE: Record<JoinRequest['status'], string> = {
  pending: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  approved: 'border-status-success/40 bg-status-success/10 text-status-success',
  rejected: 'border-border text-foreground-muted',
};
const JOIN_LABEL: Record<JoinRequest['status'], string> = { pending: 'awaiting admission', approved: 'admitted', rejected: 'rejected' };

function OpenDoorPanel({ requests, invite, onInvite, onDecide, busy }: { requests: JoinRequest[]; invite: JoinInvite | null; onInvite: () => void; onDecide: (agentId: string, approve: boolean) => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const [reputations, setReputations] = useState<Record<string, AgentReputation | 'error'>>({});
  const cardUrl = `${window.location.origin}/api/swarm-v2/social-runtime/card`;
  const example = invite ? `curl -X POST ${invite.join_url} -H 'Content-Type: application/json' -d '{"invite_code":"${invite.code}","agent_id":"my-agent","name":"My Agent","capabilities":["research"],"contact":"ops@example.org"}'` : '';
  async function copy() { try { await navigator.clipboard.writeText(example); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } }
  const pending = requests.filter((request) => request.status === 'pending');

  // Advisory-only: fetched for display next to the decide buttons below,
  // never consulted by onDecide — the human makes the actual call.
  useEffect(() => {
    for (const request of pending) {
      if (request.agent_id in reputations) continue;
      api.getAgentReputation(request.agent_id)
        .then((reputation) => setReputations((current) => ({ ...current, [request.agent_id]: reputation })))
        .catch(() => setReputations((current) => ({ ...current, [request.agent_id]: 'error' })));
    }
  }, [pending.map((request) => request.agent_id).join(',')]);

  return (
    <section className="rounded-xl border border-border bg-background-secondary p-4" style={{ borderTopColor: STAGE.asked.color, borderTopWidth: 2 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground"><DoorOpen className="h-5 w-5" style={{ color: STAGE.asked.color }} /> Open door for external agents</h2>
          <p className="mt-1 max-w-3xl text-sm text-foreground-secondary">Agents elsewhere on the web can knock with an invitation code. They appear here as pending; you admit or reject them, and only then do they fetch a short-lived token themselves. The public description of the protocol is at <a className="text-accent hover:underline" href={cardUrl} target="_blank" rel="noreferrer">{cardUrl.replace(window.location.origin, '')}</a>.</p>
        </div>
        <button type="button" onClick={onInvite} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-background-elevated disabled:opacity-40" style={{ borderColor: STAGE.asked.color, color: STAGE.asked.color }}><DoorOpen className="h-4 w-4" /> Create invitation code</button>
      </div>
      {invite && (
        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: STAGE.asked.color }}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-semibold text-foreground">Code voor "{invite.label}" · {invite.max_uses}× uses · expires {time(invite.expires_at)} · alleen nu zichtbaar</span><button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-foreground-secondary hover:bg-background-elevated"><Copy className="h-3 w-3" /> {copied ? 'gekopieerd' : 'kopieer aanklop-voorbeeld'}</button></div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-foreground-secondary">{example}</pre>
        </div>
      )}
      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Aangeklopt {pending.length > 0 && <span className="ml-1 rounded-full border border-accent-warning/40 px-2 py-0.5 text-[10px] text-accent-warning">{pending.length} wachtend</span>}</h3>
        {requests.map((request) => (
          <article key={request.agent_id} className="rounded-lg border border-border bg-background p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold text-foreground">{request.name}</span><span className="font-mono text-xs text-foreground-tertiary">{request.agent_id}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] ${JOIN_TONE[request.status]}`}>{JOIN_LABEL[request.status]}</span>{request.status === 'pending' && <ReputationBadge reputation={reputations[request.agent_id]} />}</div>{request.description && <p className="mt-1 text-xs text-foreground-secondary">{request.description}</p>}<p className="mt-1 text-[10px] text-foreground-tertiary">{request.capabilities.join(', ') || 'geen capabilities opgegeven'} · via "{request.invite_label}" · {request.ip} · {time(request.requested_at)}{request.contact && <> · {request.contact}</>}{request.decided_by && <> · beslist door {request.decided_by}</>}</p></div>
              {request.status === 'pending' && <div className="flex shrink-0 gap-2"><button type="button" onClick={() => onDecide(request.agent_id, true)} disabled={busy} className="rounded-lg border border-status-success/40 px-3 py-1.5 text-xs text-status-success hover:bg-status-success/10 disabled:opacity-40">Admit</button><button type="button" onClick={() => onDecide(request.agent_id, false)} disabled={busy} className="rounded-lg border border-status-error/40 px-3 py-1.5 text-xs text-status-error hover:bg-status-error/10 disabled:opacity-40">Reject</button></div>}
            </div>
          </article>
        ))}
        {!requests.length && <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-foreground-tertiary">Nobody from outside has knocked yet.</p>}
      </div>
    </section>
  );
}

/**
 * Advisory-only: shows a computed signal derived from existing task-history
 * and lure/probe data. Never gates onDecide above — the operator always
 * decides; this is purely one more number to look at first.
 */
function ReputationBadge({ reputation }: { reputation: AgentReputation | 'error' | undefined }) {
  if (reputation === undefined) return <span className="text-[10px] text-foreground-tertiary">reputatie laden...</span>;
  if (reputation === 'error') return null;
  const lowConfidence = reputation.sample_size < 3;
  const color = reputation.score >= 0.65 ? 'text-status-success border-status-success/40' : reputation.score <= 0.35 ? 'text-status-error border-status-error/40' : 'text-foreground-tertiary border-border';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${color}`} title="Advisory score from task history and lure/probe behaviour; never an automatic decision.">
      reputatie {reputation.score.toFixed(2)}{lowConfidence ? ' (weinig data)' : ''}
    </span>
  );
}

function Metric({ label, value, hint, color }: { label: string; value: number; hint: string; color: string }) {
  return <div className="rounded-xl border border-border bg-background-secondary p-4" style={{ borderTopColor: color, borderTopWidth: 2 }}><div className="text-2xl font-bold text-foreground">{value}</div><div className="text-xs text-foreground-secondary">{label}</div><div className="text-[10px] text-foreground-tertiary">{hint}</div></div>;
}

function Constellation({ nodes, edges, focus, highlight, onSelect }: { nodes: ConstellationNode[]; edges: ConstellationEdge[]; focus: string | null; highlight: string[]; onSelect: (id: string) => void }) {
  return (
    <svg viewBox="0 0 320 320" role="img" aria-label="Agent constellation" className="w-full rounded-lg bg-background">
      <defs><radialGradient id="commons-glow"><stop offset="0%" stopColor="rgb(60 120 255)" stopOpacity="0.25" /><stop offset="100%" stopColor="rgb(60 120 255)" stopOpacity="0" /></radialGradient></defs>
      <circle cx="160" cy="160" r="150" fill="url(#commons-glow)" />
      {edges.map((edge) => {
        const lit = highlight.includes(edge.from) && highlight.includes(edge.to);
        const dim = focus && edge.from !== focus && edge.to !== focus;
        return <line key={`${edge.from}:${edge.to}`} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke={STAGE[edge.stage].color} strokeWidth={Math.min(6, 1 + edge.count)} strokeOpacity={dim ? 0.1 : lit ? 0.95 : 0.4} strokeDasharray={lit ? '6 6' : undefined} className={lit ? 'commons-flow' : undefined} strokeLinecap="round" />;
      })}
      {nodes.map((node) => {
        const color = `hsl(${node.hue} 80% 60%)`;
        const dim = focus && focus !== node.id;
        return (
          <g key={node.id} onClick={() => onSelect(node.id)} className="cursor-pointer" opacity={dim ? 0.35 : 1}>
            {node.present && <circle cx={node.x} cy={node.y} r={14} fill={color} opacity={0.25} className="commons-pulse" />}
            {node.lured
              ? <circle cx={node.x} cy={node.y} r={9} fill="none" stroke={LURE_COLOR} strokeWidth={2} strokeDasharray="3 3" className="commons-flow" />
              : <circle cx={node.x} cy={node.y} r={8 + Math.min(6, node.threads)} fill={color} stroke="rgb(12 12 14)" strokeWidth={2} />}
            <text x={node.x} y={node.y + 26} textAnchor="middle" fontSize="10" fill="rgb(200 200 205)">{node.name.length > 14 ? `${node.name.slice(0, 13)}...` : node.name}</text>
          </g>
        );
      })}
      {!nodes.length && <text x="160" y="164" textAnchor="middle" fontSize="12" fill="rgb(100 100 115)">still empty</text>}
    </svg>
  );
}

function ThreadButton({ thread, active, onClick }: { thread: SocialThread; active: boolean; onClick: () => void }) {
  const stage = STAGE[thread.stage];
  const Icon = stage.icon;
  return (
    <button type="button" onClick={onClick} className={`w-full rounded-lg border p-2 text-left ${active ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-background-elevated'}`}>
      <div className="flex items-start gap-2"><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: stage.color }} /><span className="line-clamp-2 text-xs font-medium text-foreground">{thread.topic}</span></div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-foreground-tertiary"><span className="truncate">{thread.participants.join(' + ')}</span><span style={{ color: stage.color }}>{stage.label}</span></div>
    </button>
  );
}

export function Conversation({ thread, agents }: { thread: SocialThread; agents: SocialAgentPresence[] }) {
  const stage = STAGE[thread.stage];
  const name = (id: string) => agents.find((agent) => agent.id === id)?.name || id;
  const side = (id: string) => thread.participants.indexOf(id) % 2 === 0 ? 'items-start' : 'items-end';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0"><h2 className="text-lg font-semibold text-foreground">{thread.topic}</h2><p className="mt-1 text-xs text-foreground-tertiary">{thread.participants.map(name).join(' + ')} · gestart {time(thread.started_at)} · laatst {time(thread.last_activity_at)}{thread.topic_ref && <> · <code className="text-accent">{thread.topic_ref}</code></>}</p></div>
        <span className="rounded-full border px-2.5 py-1 text-xs font-medium" style={{ color: stage.color, borderColor: stage.color }}>{stage.label}</span>
      </div>
      {thread.topic_ref?.startsWith('message:') && <p className="text-xs text-accent">Topic raised by an agent · bron {thread.topic_ref}</p>}
      <ol className="space-y-4">
        {thread.messages.map((message) => (
          <li key={message.id} className={`flex flex-col ${side(message.from)}`}>
            <Bubble message={message} name={name} />
          </li>
        ))}
      </ol>
      {thread.stage !== 'learned' && <p className="flex items-center gap-2 text-xs text-foreground-tertiary"><span className="h-2 w-2 animate-pulse rounded-full bg-accent-warning" /> Waiting for the next runtime turn</p>}
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
        <span className="text-foreground-tertiary">aan {name(message.to)}</span>
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
          {message.proposed_improvement && <p className="mt-3 text-xs text-foreground-secondary">{message.improvement_id ? <>Registered proposal <code>{message.improvement_id}</code> · {message.improvement_status || 'status unknown'}{message.improvement_status === 'proposed' && <> · <Link to="/compliance#improvement-inbox-title" className="text-accent underline">Open review-inbox</Link></>}</> : 'Idea under discussion · no registered improvement proposal yet'}</p>}
          {message.action === 'social.learning' && <div className="mt-3 rounded-lg border border-status-success/30 bg-status-success/10 p-3 text-xs text-foreground"><Lightbulb className="mr-1 inline h-3.5 w-3.5 text-status-success" /> Recorded as a reflection candidate{message.reflection_id && <> <code className="text-foreground-secondary">{message.reflection_id}</code></>}{message.reflection_status && <> · {message.reflection_status}</>} · niet gepromoot zonder review</div>}
        </>}
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-foreground-tertiary"><span>{time(message.timestamp)}</span>{message.runtime && <span>{message.runtime}{message.model_id ? ` · ${message.model_id}` : ''}</span>}{message.runtime_run_id && <span className="break-all">run {message.runtime_run_id}</span>}{message.evidence.length > 0 && <details><summary className="cursor-pointer text-accent">bewijs ({message.evidence.length})</summary><div className="mt-1 space-y-0.5 font-mono">{message.evidence.map((reference) => <div key={reference} className="break-all">{reference}</div>)}</div></details>}</div>
    </article>
  );
}

function Facet({ label, value, color }: { label: string; value: string | null; color: string }) {
  if (!value) return null;
  return <div className="rounded-lg border border-border bg-background-elevated p-2.5"><div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color }}>{label}</div><p className="mt-1 text-xs text-foreground-secondary">{value}</p></div>;
}
