import { useEffect, useState } from 'react';
import { Bot, Activity, XCircle, Clock } from 'lucide-react';
import { useStore } from '../lib/store'
import { api } from '../lib/api';
import type { RuntimeGovernanceAgentStatus } from '../lib/api';
import type { Agent } from '@djimitflo/shared';
import { useAuthStore } from '../lib/auth-store';
import { Link, useParams } from 'react-router-dom';
import { LoadErrorNotice, softFail } from '../components/LoadErrorNotice';
import { ScorecardsSection } from './ScorecardsSection';

export function AgentsPage() {
  const { agentId } = useParams();
  const agents = useStore((state) => state.agents);
  const tasks = useStore((state) => state.tasks);
  const visibleAgents = agentId ? agents.filter(agent => agent.id === agentId) : agents;
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  // UX-007: 'loading' and 'failed' are not an empty inventory; only a completed read (or a filled store) may say "none"
  const [inventory, setInventory] = useState<'loading' | 'loaded' | 'failed'>(agents.length ? 'loaded' : 'loading');

  // D4: REST fallback — load agents via API when WebSocket store is empty.
  useEffect(() => {
    if (agents.length === 0) {
      const failed: string[] = [];
      api.getAgents().then((res) => { useStore.setState({ agents: res.agents }); setInventory('loaded'); })
        .catch((err) => { softFail(failed, 'agents', undefined)(err); setInventory('failed'); })
        .finally(() => setLoadErrors(failed));
    }
  }, []);
  const state = agents.length ? 'loaded' : inventory;

  const detail = agentId ? visibleAgents[0] : undefined;
  const card = (agent: typeof agents[number]) => {
    const currentTask = tasks.find((t) => t.agent_id === agent.id && t.status === 'running');
    return (
      <AgentCard
        key={agent.id}
        agentId={agent.id}
        showGovernance={Boolean(agentId)}
        linkToDetail={!agentId}
        name={agent.name}
        description={agent.description}
        status={agent.status === 'active' && agent.liveness && agent.liveness !== 'live' ? agent.liveness : agent.status}
        lastSeenAt={agent.last_seen_at ?? null}
        livenessSignal={agent.liveness_signal ?? null}
        connectionState={agent.connection_state ?? null}
        connectionReason={agent.connection_reason ?? null}
        telegramBot={agent.telegram_bot_name ?? null}
        currentTask={currentTask?.title || null}
        currentTaskId={currentTask?.id ?? null}
        counters30d={agent.counters_30d ?? null}
        capabilities={agent.capabilities}
        retiredAt={agent.retired_at}
        retirementReason={agent.retirement_reason}
      />
    );
  };
  // truth audit 2026-11-12: grouped by kind, most recent evidence first
  const recent = [...visibleAgents].sort((a, b) => seenMs(b.last_seen_at) - seenMs(a.last_seen_at));
  const groups = AGENT_GROUPS.map(([key, label]) => [label, recent.filter((a) => (a.agent_group ?? 'other') === key)] as const).filter(([, members]) => members.length > 0);

  return (
    <div className="p-8 space-y-6">
      <LoadErrorNotice failed={loadErrors} />
      {/* Header */}
      <div>
        {agentId && <Link to="/agents" className="text-accent">All agents</Link>}
        <h1 className="text-3xl font-bold text-foreground">{agentId ? detail?.name ?? 'Agent' : 'Agents'}</h1>
        <p className="text-foreground-secondary mt-2">
          {agentId ? detail?.description ?? '' : 'Monitor your AI agents'}
        </p>
      </div>

      {/* UX-17: runtime and fleet-agent scorecards (list view only), on top */}
      {!agentId && <ScorecardsSection />}

      {visibleAgents.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center" aria-live="polite">
          <p className="text-foreground-muted">{state === 'loading' ? 'Loading agents…'
            : state === 'failed' ? 'Agent inventory unavailable — the agent list could not be read, so it is unknown whether any are configured.'
            : agentId ? 'Agent not found' : 'No agents configured'}</p>
        </div>
      ) : agentId ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{visibleAgents.map(card)}</div>
      ) : groups.map(([label, members]) => (
        <section key={label} aria-label={label} className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">{label} ({members.length})</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{members.map(card)}</div>
        </section>
      ))}
    </div>
  );
}

const AGENT_GROUPS = [['factory_worker', 'Factory workers'], ['fleet_agent', 'Fleet agents'], ['commons_resident', 'Commons residents'], ['other', 'Other agents']] as const;
const seenMs = (t: string | null | undefined) => { const v = t ? Date.parse(t) : NaN; return Number.isFinite(v) ? v : -Infinity; };

interface AgentCardProps {
  agentId: string;
  showGovernance: boolean;
  linkToDetail: boolean;
  name: string;
  description: string;
  status: string;
  lastSeenAt?: string | null;
  livenessSignal?: string | null;
  connectionState?: string | null;
  connectionReason?: string | null;
  telegramBot?: string | null;
  retiredAt?: string | null;
  retirementReason?: string | null;
  currentTask: string | null;
  currentTaskId?: string | null;
  counters30d: NonNullable<Agent['counters_30d']> | null;
  capabilities: string[];
}

function AgentCard({
  agentId,
  showGovernance,
  linkToDetail,
  name,
  description,
  status,
  currentTask,
  currentTaskId,
  counters30d,
  capabilities,
  retiredAt,
  retirementReason,
  lastSeenAt,
  livenessSignal,
  connectionState,
  connectionReason,
  telegramBot,
}: AgentCardProps) {
  const statusConfig: Record<string, { color: string; icon: React.ReactNode }> = {
    pending_approval: {
      color: 'bg-status-paused/10 text-status-paused border-status-paused/20',
      icon: <Clock className="w-4 h-4" />,
    },
    active: {
      color: 'bg-status-active/10 text-status-active border-status-active/20',
      icon: <Activity className="w-4 h-4" />,
    },
    idle: {
      color: 'bg-status-idle/10 text-status-idle border-status-idle/20',
      icon: <Clock className="w-4 h-4" />,
    },
    paused: {
      color: 'bg-status-paused/10 text-status-paused border-status-paused/20',
      icon: <Clock className="w-4 h-4" />,
    },
    error: {
      color: 'bg-status-error/10 text-status-error border-status-error/20',
      icon: <XCircle className="w-4 h-4" />,
    },
    offline: {
      color: 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20',
      icon: <XCircle className="w-4 h-4" />,
    },
    // plan I0: registered as active but no activity or ONLINE registry node in the last 24 h
    stale: {
      color: 'bg-status-paused/10 text-status-paused border-status-paused/20',
      icon: <Clock className="w-4 h-4" />,
    },
    unknown: {
      color: 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20',
      icon: <Clock className="w-4 h-4" />,
    },
  };
  const appearance = statusConfig[status] ?? statusConfig.offline;
  
  const successRate = counters30d ? agentSuccessRate(counters30d.tasks, counters30d.completed) : null;
  
  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6 hover:border-accent/30 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent/10 rounded-lg">
            <Bot className="w-6 h-6 text-accent" />
          </div>
          <div>
            {/* on the detail page the H1 carries the name and description */}
            {linkToDetail && <h3 className="text-lg font-semibold text-foreground"><Link to={`/agents/${encodeURIComponent(agentId)}`} className="hover:underline">{name}</Link></h3>}
            {linkToDetail && <p className="text-sm text-foreground-secondary mt-1">{description}</p>}
            {telegramBot && <p className="text-xs text-foreground-secondary mt-1">Telegram <a className="underline" href={`https://t.me/${telegramBot.replace(/^@/, '')}`} target="_blank" rel="noreferrer">@{telegramBot.replace(/^@/, '')}</a></p>}
          </div>
        </div>
        <span title={lastSeenAt ? `last seen ${lastSeenAt}` : 'never seen'} className={`px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-2 ${appearance.color}`}>
          {appearance.icon}
          {status}
        </span>
      </div>

      <p className="mb-2 text-sm text-foreground-secondary" data-testid="liveness-signal">{livenessSignal ? `Last signal: ${livenessSignal}` : 'No activity evidence'}</p>
      {connectionState ? <p className="mb-4 text-sm text-foreground-secondary" data-testid="connection-state">Connection: <span className="font-medium text-foreground">{connectionState.replace('_', ' ')}</span>{connectionReason ? ` — ${connectionReason}` : ''}</p>
        : connectionReason && <p className="mb-4 text-sm text-foreground-secondary" data-testid="connection-state">Connection: not applicable — {connectionReason}</p>}
      {retiredAt && <p className="mb-4 text-sm text-foreground-secondary">Retired at {retiredAt}{retirementReason ? ` — ${retirementReason}` : ''}</p>}
      
      {/* Current Task */}
      {currentTask && (
        <div className="mb-4 p-3 bg-background-elevated border border-border rounded-lg">
          <div className="text-xs text-foreground-tertiary mb-1">Current Task</div>
          <div className="text-sm text-foreground font-medium">{currentTaskId ? <Link to={`/tasks/${currentTaskId}`} className="underline">{currentTask}</Link> : currentTask}</div>
        </div>
      )}
      
      {/* Stats — truth audit 2026-11-12: 30-day aggregates of task rows and outcomes; the agents-table lifetime columns are a frozen import and are not shown */}
      <div className="text-xs text-foreground-tertiary mb-2">Tasks · 30 d</div>
      {counters30d ? (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <div className="text-2xl font-bold text-foreground">{counters30d.tasks}</div>
            <div className="text-xs text-foreground-tertiary">Total</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-status-completed">{counters30d.completed}</div>
            <div className="text-xs text-foreground-tertiary">Completed</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-status-error">{counters30d.failed}</div>
            <div className="text-xs text-foreground-tertiary">Failed</div>
          </div>
        </div>
      ) : <p className="mb-4 text-sm text-foreground-secondary">30-day counters not reported</p>}
      {counters30d && counters30d.outcomes > 0 && <p className="mb-4 text-sm text-foreground-secondary" data-testid="agent-outcomes-30d">Outcomes · 30 d: {counters30d.outcomes} ({counters30d.outcomes_ok} ok)</p>}

      {/* Success Rate */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-foreground-secondary">Completion · 30 d</span>
          <span data-testid="agent-success-rate" className="text-foreground font-semibold">{successRate === null ? 'insufficient — no tasks' : `${successRate} % (${counters30d?.completed}/${counters30d?.tasks})`}</span>
        </div>
        {successRate !== null && (
          <div className="w-full bg-background-elevated rounded-full h-2">
            <div
              className="bg-status-completed h-2 rounded-full transition-all"
              style={{ width: `${successRate}%` }}
            />
          </div>
        )}
      </div>

      {showGovernance && <RuntimeGovernancePanel agentId={agentId} />}
      
      {/* Capabilities */}
      <div>
        <div className="text-xs text-foreground-tertiary mb-2">Capabilities</div>
        <div className="flex flex-wrap gap-2">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="px-2 py-1 bg-background-elevated text-foreground-secondary text-xs rounded border border-border"
            >
              {formatCapability(cap)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RuntimeGovernancePanel({ agentId }: { agentId: string }) {
  const canRead = useAuthStore((state) => state.hasPermission('read:evidence'));
  const canRelease = useAuthStore((state) => state.hasPermission('write:governance'));
  const [governance, setGovernance] = useState<RuntimeGovernanceAgentStatus | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let current = true;
    setLoading(true);
    setError(null);
    setGovernance(null);
    api.getRuntimeGovernanceAgent(agentId)
      .then((status) => { if (current) setGovernance(status); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : 'Governance status unavailable'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [agentId, canRead]);

  async function release(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const releaseReason = reason.trim();
    if (!canRelease || !releaseReason || releasing) return;
    setReleasing(true);
    setError(null);
    setNotice(null);
    try {
      await api.releaseRuntimeGovernanceAgent(agentId, releaseReason);
      setGovernance((current) => current ? { ...current, quarantined: false, circuitBreakerTripped: false, violationCount: 0 } : current);
      setReason('');
      setNotice('Governance hold released.');
      try {
        setGovernance(await api.getRuntimeGovernanceAgent(agentId));
        setNotice('Governance hold released; status refreshed from the server.');
      } catch (cause) {
        setError(`Release succeeded, but status refresh failed: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not release governance hold');
    } finally {
      setReleasing(false);
    }
  }

  return (
    <section aria-label="Runtime governance" className="mb-4 rounded-lg border border-border bg-background-elevated p-4">
      <h4 className="font-semibold text-foreground">Runtime governance</h4>
      {!canRead ? <p className="mt-2 text-sm text-foreground-secondary">Your role cannot read runtime governance status.</p> : loading ? (
        <p role="status" className="mt-2 text-sm text-foreground-secondary">Loading governance status…</p>
      ) : error && !governance ? (
        <p role="alert" className="mt-2 text-sm text-status-error">Governance status unavailable: {error}</p>
      ) : governance && !governance.baseline && !governance.quarantined && !governance.circuitBreakerTripped ? (
        // truth audit 2026-11-12: no runtime_governance_agents row is "not monitored", not "clear / 0 violations"
        <p className="mt-2 text-sm text-foreground-secondary" data-testid="governance-not-monitored">Runtime governance: not monitored — no governance baseline is registered for this agent.</p>
      ) : governance && (
        <>
          <div className="mt-2 space-y-1 text-sm text-foreground-secondary">
            <p>{governance.quarantined ? 'Quarantined' : 'Not quarantined'}</p>
            <p>Circuit breaker: {governance.circuitBreakerTripped ? 'tripped' : 'clear'}</p>
            <p>Recorded violations: {governance.violationCount}</p>
            {!governance.baseline && <p>No runtime governance baseline is registered.</p>}
          </div>
          {canRelease && (governance.quarantined || governance.circuitBreakerTripped) && (
            <form onSubmit={(event) => void release(event)} className="mt-4 space-y-2">
              <p className="text-xs text-foreground-secondary">Releasing clears quarantine, resets the circuit breaker and violation count, and records the reason in a governance alert.</p>
              <label htmlFor={`release-reason-${agentId}`} className="block text-sm text-foreground">Reason for release</label>
              <textarea
                id={`release-reason-${agentId}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                required
                className="w-full rounded border border-border bg-background-secondary p-2 text-sm text-foreground"
              />
              <button type="submit" disabled={!reason.trim() || releasing} className="rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
                {releasing ? 'Releasing…' : 'Release governance hold'}
              </button>
            </form>
          )}
          {notice && <p role="status" className="mt-2 text-sm text-foreground-secondary">{notice}</p>}
          {error && governance && <p role="alert" className="mt-2 text-sm text-status-error">{error}</p>}
        </>
      )}
    </section>
  );
}

/** SW-01: completed ÷ total lifetime tasks; null (insufficient) without a task — a 0 % is never shown for no observation */
export function agentSuccessRate(totalTasks: number | null | undefined, completedTasks: number | null | undefined): number | null {
  const n = Number(totalTasks) || 0;
  return n > 0 ? Math.round(((Number(completedTasks) || 0) / n) * 100) : null;
}

function formatCapability(cap: string): string {
  return cap
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
