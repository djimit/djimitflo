import { useCallback, useEffect, useState } from 'react';
import { Clock, Shield, AlertTriangle, Filter } from 'lucide-react';
import type { AuditTrailEntry, AuditEvent } from '@djimitflo/shared';
import { api } from '../lib/api';

/** Exact event types per filter: the server filters (`?event_type=a,b`), not the latest 50 rows in the browser. */
const EVENT_TYPE_FILTERS: Record<string, string> = {
  approval: 'approval.requested,approval.granted,approval.denied,approval.expired,task.approved,task.denied',
  execution: 'task.executed,execution.paused,execution.resumed,execution.failed,execution.denied,execution.dirty_tree,shell.executed',
  policy: 'policy.created,policy.updated,policy.violation',
  auth: 'auth.login,auth.login_failed,auth.logout',
  config: 'config.changed',
};

type TrailEvent = AuditEvent & { actor_email?: string; actor_role?: string };

export function AuditPage() {
  const [trail, setTrail] = useState<AuditTrailEntry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hiddenServiceLogins, setHiddenServiceLogins] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>('all');
  const [showServiceLogins, setShowServiceLogins] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTrail = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: '50' });
    if (filterType !== 'all') params.set('event_type', EVENT_TYPE_FILTERS[filterType]);
    if (!showServiceLogins) params.set('hide_service_logins', '1');
    try {
      const result = await api.request<{ events: TrailEvent[]; total?: number; hidden_service_logins?: number }>(`/audit?${params}`);
      setTrail(result.events.map(event => ({
        timestamp: event.timestamp, event_type: event.event_type,
        action: event.action, resource_type: event.resource_type, resource_id: event.resource_id,
        summary: event.action,
        actor: event.actor_email ? `${event.actor_email}${event.actor_role ? ` (${event.actor_role})` : ''}` : event.user_id || event.agent_id || 'system',
        risk_level: event.risk_level, metadata: event.metadata,
      })));
      setTotal(result.total ?? null);
      setHiddenServiceLogins(result.hidden_service_logins ?? null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load audit trail');
    } finally {
      setLoading(false);
    }
  }, [filterType, showServiceLogins]);

  useEffect(() => {
    void loadTrail();
  }, [loadTrail]);


  return (
    <div className="p-8 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Audit Trail</h2>
        <p className="text-foreground-secondary mt-2">Latest 50 entries from the canonical audit trail.</p>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => void loadTrail()} disabled={loading}>Refresh</button>
        <Filter className="w-4 h-4 text-foreground-secondary" />
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="bg-background-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground"
        >
          <option value="all">All Events</option>
          <option value="approval">Approvals</option>
          <option value="execution">Execution</option>
          <option value="policy">Policy</option>
          <option value="auth">Auth</option>
          <option value="config">Config</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-foreground-secondary">
          <input type="checkbox" checked={showServiceLogins} onChange={(e) => setShowServiceLogins(e.target.checked)} />
          Show service-account logins
        </label>
        <span className="text-sm text-foreground-secondary">
          {total !== null ? `${trail.length} of ${total} events` : `${trail.length} events`}
          {hiddenServiceLogins ? ` · ${hiddenServiceLogins} service-account logins hidden` : ''}
        </span>
      </div>

      {error ? <p role="alert">{error}</p> : loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading audit trail...</div>
      ) : trail.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <Clock className="w-12 h-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-secondary">No audit events recorded yet.</p>
        </div>
      ) : (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <div className="space-y-3">
            {trail.slice(0, 50).map((entry, i) => (
              <div key={i} className="border-l-2 border-border pl-3 py-1">
                <div className="flex items-center gap-2 mb-0.5">
                  {entry.event_type.includes('denied') || entry.event_type.includes('violation') ? (
                    <AlertTriangle className="w-3.5 h-3.5 text-status-error" />
                  ) : entry.event_type.includes('approved') || entry.event_type.includes('granted') ? (
                    <Shield className="w-3.5 h-3.5 text-status-completed" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 text-foreground-tertiary" />
                  )}
                  <span className="text-xs font-mono text-foreground-tertiary">{new Date(entry.timestamp).toLocaleString()}</span>
                  <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-background-elevated text-foreground-secondary">{entry.event_type}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    entry.risk_level === 'critical' ? 'bg-risk-critical/10 text-risk-critical' :
                    entry.risk_level === 'high' ? 'bg-risk-high/10 text-risk-high' :
                    entry.risk_level === 'medium' ? 'bg-risk-medium/10 text-risk-medium' :
                    'bg-risk-low/10 text-risk-low'
                  }`}>{entry.risk_level}</span>
                </div>
                <p className="text-sm text-foreground">{entry.summary}</p>
                {entry.actor && <p className="text-xs text-foreground-tertiary">Actor: {entry.actor}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
