import { useEffect, useState } from 'react';
import { Bot, Activity, XCircle, Clock } from 'lucide-react';
import { useStore } from '../lib/store'
import { api } from '../lib/api';
import type { RuntimeGovernanceAgentStatus } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';
import { Link, useParams } from 'react-router-dom';

export function AgentsPage() {
  const { agentId } = useParams();
  const agents = useStore((state) => state.agents);
  const tasks = useStore((state) => state.tasks);
  const visibleAgents = agentId ? agents.filter(agent => agent.id === agentId) : agents;

  // D4: REST fallback — load agents via API when WebSocket store is empty.
  useEffect(() => {
    if (agents.length === 0) {
      api.getAgents().then((res) => useStore.setState({ agents: res.agents })).catch(() => {});
    }
  }, []);

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        {agentId && <Link to="/agents" className="text-accent">All agents</Link>}
        <h1 className="text-3xl font-bold text-foreground">Agents</h1>
        <p className="text-foreground-secondary mt-2">
          Monitor your AI agents
        </p>
      </div>
      
      {/* Agent Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {visibleAgents.length === 0 ? (
          <div className="col-span-2 bg-background-secondary border border-border rounded-lg p-12 text-center">
            <p className="text-foreground-muted">{agentId ? 'Agent not found' : 'No agents configured'}</p>
          </div>
        ) : (
          visibleAgents.map((agent) => {
            const agentTasks = tasks.filter((t) => t.agent_id === agent.id);
            const currentTask = agentTasks.find((t) => t.status === 'running');
            
            return (
              <AgentCard
                key={agent.id}
                agentId={agent.id}
                showGovernance={Boolean(agentId)}
                name={agent.name}
                description={agent.description}
                status={agent.status}
                currentTask={currentTask?.title || null}
                totalTasks={agent.total_tasks}
                completedTasks={agent.completed_tasks}
                failedTasks={agent.failed_tasks}
                capabilities={agent.capabilities}
                retiredAt={agent.retired_at}
                retirementReason={agent.retirement_reason}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

interface AgentCardProps {
  agentId: string;
  showGovernance: boolean;
  name: string;
  description: string;
  status: string;
  retiredAt?: string | null;
  retirementReason?: string | null;
  currentTask: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  capabilities: string[];
}

function AgentCard({
  agentId,
  showGovernance,
  name,
  description,
  status,
  currentTask,
  totalTasks,
  completedTasks,
  failedTasks,
  capabilities,
  retiredAt,
  retirementReason,
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
  };
  const appearance = statusConfig[status] ?? statusConfig.offline;
  
  const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  
  return (
    <div className="bg-background-secondary border border-border rounded-lg p-6 hover:border-accent/30 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent/10 rounded-lg">
            <Bot className="w-6 h-6 text-accent" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">{name}</h3>
            <p className="text-sm text-foreground-secondary mt-1">{description}</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-2 ${appearance.color}`}>
          {appearance.icon}
          {status}
        </span>
      </div>

      {retiredAt && <p className="mb-4 text-sm text-foreground-secondary">Retired at {retiredAt}{retirementReason ? ` — ${retirementReason}` : ''}</p>}
      
      {/* Current Task */}
      {currentTask && (
        <div className="mb-4 p-3 bg-background-elevated border border-border rounded-lg">
          <div className="text-xs text-foreground-tertiary mb-1">Current Task</div>
          <div className="text-sm text-foreground font-medium">{currentTask}</div>
        </div>
      )}
      
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-2xl font-bold text-foreground">{totalTasks}</div>
          <div className="text-xs text-foreground-tertiary">Total</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-status-completed">{completedTasks}</div>
          <div className="text-xs text-foreground-tertiary">Completed</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-status-error">{failedTasks}</div>
          <div className="text-xs text-foreground-tertiary">Failed</div>
        </div>
      </div>
      
      {/* Success Rate */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-foreground-secondary">Success Rate</span>
          <span className="text-foreground font-semibold">{successRate}%</span>
        </div>
        <div className="w-full bg-background-elevated rounded-full h-2">
          <div
            className="bg-status-completed h-2 rounded-full transition-all"
            style={{ width: `${successRate}%` }}
          />
        </div>
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

function formatCapability(cap: string): string {
  return cap
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
