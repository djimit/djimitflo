import { useEffect, useState } from 'react';
import { Clock, Shield, AlertTriangle, Filter } from 'lucide-react';
import type { AuditTrailEntry } from '@djimitflo/shared';
import { api } from '../lib/api';

export function AuditPage() {
  const [trail, setTrail] = useState<AuditTrailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>('all');

  useEffect(() => {
    loadTrail();
  }, []);

  const loadTrail = async () => {
    try {
      const metrics = await api.getObservabilityMetrics();
      const recentTasks = metrics.recent_errors.map((e) => e.task_id);
      const uniqueTasks = [...new Set(recentTasks)];
      const allTrails: AuditTrailEntry[] = [];
      for (const taskId of uniqueTasks.slice(0, 10)) {
        try {
          const result = await api.getAuditTrail(taskId);
          allTrails.push(...result.trail);
        } catch {}
      }
      allTrails.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setTrail(allTrails);
    } catch (error) {
      console.error('Failed to load audit trail:', error);
    } finally {
      setLoading(false);
    }
  };

  const filtered = filterType === 'all' ? trail : trail.filter((e) => e.event_type.includes(filterType));

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Audit Trail</h1>
        <p className="text-foreground-secondary mt-2">Chronological record of all policy decisions, approvals, and risk assessments.</p>
      </div>

      <div className="flex items-center gap-3">
        <Filter className="w-4 h-4 text-foreground-secondary" />
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="bg-background-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-foreground"
        >
          <option value="all">All Events</option>
          <option value="approval">Approvals</option>
          <option value="risk">Risk Assessments</option>
          <option value="execution">Execution</option>
          <option value="policy">Policy</option>
        </select>
        <span className="text-sm text-foreground-secondary">{filtered.length} events</span>
      </div>

      {loading ? (
        <div className="bg-background-secondary border border-border rounded-lg p-8 text-foreground-secondary">Loading audit trail...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-background-secondary border border-border rounded-lg p-12 text-center">
          <Clock className="w-12 h-12 text-foreground-muted mx-auto mb-4" />
          <p className="text-foreground-secondary">No audit events recorded yet.</p>
        </div>
      ) : (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <div className="space-y-3">
            {filtered.slice(0, 50).map((entry, i) => (
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