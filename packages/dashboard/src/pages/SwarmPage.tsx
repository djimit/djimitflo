import { useState, useEffect } from 'react';
import { Activity, Circle, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

interface Agent {
  id: string;
  name: string;
  status: 'active' | 'idle' | 'error' | 'offline';
  agent_type?: string;
  machine_ip?: string;
  last_heartbeat_at?: string;
  metadata?: string;
}

const STATUS_COLOR: Record<string, string> = {
  active: 'text-green-400',
  idle: 'text-yellow-400',
  error: 'text-red-400',
  offline: 'text-gray-500',
};

const STATUS_BG: Record<string, string> = {
  active: 'bg-green-500',
  idle: 'bg-yellow-500',
  error: 'bg-red-500',
  offline: 'bg-gray-500',
};

function AgentCard({ agent }: { agent: Agent }) {
  const color = STATUS_COLOR[agent.status] ?? 'text-gray-400';
  const dot = STATUS_BG[agent.status] ?? 'bg-gray-500';
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(agent.metadata || '{}'); } catch {}

  const lastSeen = agent.last_heartbeat_at
    ? new Date(agent.last_heartbeat_at).toLocaleTimeString()
    : '—';

  return (
    <div className="bg-background-secondary border border-border rounded-lg p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-content-primary">{agent.name}</h3>
          {agent.agent_type && (
            <span className="text-xs text-content-secondary">{agent.agent_type}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          <span className={`text-xs font-medium capitalize ${color}`}>{agent.status}</span>
        </div>
      </div>
      <div className="text-xs text-content-secondary space-y-1">
        {agent.machine_ip && <div>Machine: {agent.machine_ip}</div>}
        <div>Last seen: {lastSeen}</div>
        {typeof meta.active_tasks === 'number' && (
          <div>Active tasks: {meta.active_tasks}</div>
        )}
      </div>
    </div>
  );
}

export function SwarmPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'idle'>('all');

  const load = () => {
    setLoading(true);
    api.getAgents()
      .then(res => setAgents(res.agents as unknown as Agent[]))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const displayed = filter === 'all' ? agents : agents.filter(a => a.status === filter);
  const counts = {
    active: agents.filter(a => a.status === 'active').length,
    idle: agents.filter(a => a.status === 'idle').length,
    error: agents.filter(a => a.status === 'error').length,
  };

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-content-primary flex items-center gap-2">
            <Activity className="w-6 h-6 text-accent" />
            Swarm
          </h1>
          <p className="text-content-secondary mt-1">
            {agents.length} agents — {counts.active} active, {counts.idle} idle
            {counts.error > 0 && `, ${counts.error} error`}
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-content-secondary hover:bg-background-elevated transition-colors text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary dots */}
      <div className="flex gap-3">
        {(['all', 'active', 'idle'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === f
                ? 'bg-accent/10 text-accent border border-accent/20'
                : 'text-content-secondary hover:bg-background-elevated border border-transparent'
            }`}
          >
            {f === 'all' ? `All (${agents.length})` : f === 'active' ? `Active (${counts.active})` : `Idle (${counts.idle})`}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      )}

      {loading && !agents.length ? (
        <div className="flex items-center justify-center h-32">
          <RefreshCw className="w-6 h-6 animate-spin text-content-secondary" />
        </div>
      ) : displayed.length === 0 ? (
        <div className="bg-background-secondary rounded-lg p-8 text-center">
          <Circle className="w-8 h-8 text-content-secondary mx-auto mb-2" />
          <p className="text-content-secondary text-sm">No {filter !== 'all' ? filter : ''} agents found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayed.map(agent => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
