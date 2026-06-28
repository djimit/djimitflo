import { useState, useEffect, Component } from 'react';
import { Activity, Circle, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

// Error boundary — catches render crashes and shows fallback instead of black screen
class SwarmErrorBoundary extends Component<{children: React.ReactNode}, {hasError: boolean}> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) { console.error('[SwarmPage] render error:', err); }
  render() {
    if (this.state.hasError) {
      return <div className="p-8 text-foreground-secondary">Swarm data failed to render. <button onClick={() => this.setState({hasError: false})} className="text-accent underline">Retry</button></div>;
    }
    return this.props.children;
  }
}

interface Agent {
  id: string;
  name: string;
  status: string;
  agent_type?: string;
  machine_ip?: string;
  last_heartbeat_at?: string;
  metadata?: string;
}

export function SwarmPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [missionControl, setMissionControl] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');

  const load = () => {
    setLoading(true);
    setError(null);
    api.getAgents()
      .then((res: any) => { setAgents(res?.agents ?? []); })
      .catch((e: any) => { setError(e?.message ?? 'Failed to load agents'); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // D6: load claims + mission control — fully defensive
    api.getSwarmClaims().then((res: any) => { setClaims(res?.claims ?? []); }).catch(() => {});
    api.getSwarmMissionControl().then((res: any) => { setMissionControl(res ?? null); }).catch(() => {});
  }, []);

  const safeAgents = Array.isArray(agents) ? agents : [];
  const safeClaims = Array.isArray(claims) ? claims : [];
  const displayed = filter === 'all' ? safeAgents : safeAgents.filter(a => a?.status === filter);
  const counts = {
    active: safeAgents.filter(a => a?.status === 'active').length,
    idle: safeAgents.filter(a => a?.status === 'idle').length,
    error: safeAgents.filter(a => a?.status === 'error').length,
  };

  return (
    <SwarmErrorBoundary>
      <div className="p-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Activity className="w-6 h-6 text-accent" />
              Swarm
            </h1>
            <p className="text-foreground-secondary mt-1">
              {safeAgents.length} agents — {counts.active} active, {counts.idle} idle
              {counts.error > 0 ? `, ${counts.error} error` : ''}
            </p>
          </div>
          <button
            onClick={load}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-foreground-secondary hover:bg-background-elevated text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="flex gap-3">
          {['all', 'active', 'idle'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                filter === f ? 'bg-accent/10 text-accent border border-accent/20' : 'text-foreground-secondary hover:bg-background-elevated border border-transparent'
              }`}
            >
              {f === 'all' ? `All (${safeAgents.length})` : f === 'active' ? `Active (${counts.active})` : `Idle (${counts.idle})`}
            </button>
          ))}
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">{error}</div>}

        {loading && safeAgents.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-6 h-6 animate-spin text-foreground-secondary" />
          </div>
        ) : displayed.length === 0 ? (
          <div className="bg-background-secondary rounded-lg p-8 text-center">
            <Circle className="w-8 h-8 text-foreground-secondary mx-auto mb-2" />
            <p className="text-foreground-secondary text-sm">No agents registered. Agents appear via heartbeat.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayed.map(agent => (
              <div key={agent?.id ?? Math.random()} className="bg-background-secondary border border-border rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{agent?.name ?? 'Unknown'}</h3>
                    {agent?.agent_type && <span className="text-xs text-foreground-secondary">{agent.agent_type}</span>}
                  </div>
                  <span className="text-xs text-foreground-tertiary capitalize">{agent?.status ?? 'unknown'}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Claims */}
        {safeClaims.length > 0 && (
          <div className="bg-background-secondary border border-border rounded-lg p-6">
            <h2 className="text-xl font-semibold text-foreground mb-4">Claim Ledger ({safeClaims.length})</h2>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {safeClaims.slice(0, 20).map((claim) => {
                if (!claim) return null;
                const status = claim.status || 'unknown';
                const statusColor = status === 'supported' ? 'text-status-active' : status === 'contradicted' ? 'text-status-error' : 'text-status-paused';
                const claimText = typeof claim.claim === 'string' ? claim.claim.slice(0, 100) : '';
                return (
                  <div key={claim.id ?? Math.random()} className="flex items-start gap-3 p-3 bg-background-elevated rounded-lg border border-border text-sm">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${statusColor}`}>{status}</span>
                    <span className="font-mono text-xs text-foreground-tertiary">{claim.predicate || ''}</span>
                    <span className="text-foreground-secondary flex-1 truncate">{claimText}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Mission Control */}
        {missionControl && typeof missionControl === 'object' && (
          <div className="bg-background-secondary border border-border rounded-lg p-6">
            <h2 className="text-xl font-semibold text-foreground mb-4">Mission Control Summary</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-3 bg-background-elevated rounded-lg">
                <div className="text-2xl font-bold text-foreground">{missionControl?.capability_health?.total ?? missionControl?.capability_count ?? 0}</div>
                <div className="text-xs text-foreground-tertiary">Capabilities</div>
              </div>
              <div className="text-center p-3 bg-background-elevated rounded-lg">
                <div className="text-2xl font-bold text-foreground">{missionControl?.claim_health?.total ?? missionControl?.claim_count ?? 0}</div>
                <div className="text-xs text-foreground-tertiary">Claims</div>
              </div>
              <div className="text-center p-3 bg-background-elevated rounded-lg">
                <div className="text-2xl font-bold text-foreground">{missionControl?.manifest_health?.total ?? missionControl?.manifest_count ?? 0}</div>
                <div className="text-xs text-foreground-tertiary">Manifests</div>
              </div>
              <div className="text-center p-3 bg-background-elevated rounded-lg">
                <div className="text-2xl font-bold text-foreground">{missionControl?.swarm_truth?.prepared_leases ?? missionControl?.lease_count ?? 0}</div>
                <div className="text-xs text-foreground-tertiary">Prepared Leases</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </SwarmErrorBoundary>
  );
}
