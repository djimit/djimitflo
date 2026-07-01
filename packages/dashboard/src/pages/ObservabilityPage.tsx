import { useEffect, useState, useRef } from 'react';
import { Activity, AlertTriangle, CheckCircle, XCircle, Clock, Shield, BarChart3 } from 'lucide-react';
import type { ObservabilityMetrics } from '@djimitflo/shared';
import { api } from '../lib/api';

type LiveEvent = {
  timestamp?: string;
  type?: string;
  data?: unknown;
  [key: string]: unknown;
};

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ObservabilityPage() {
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [sseEvents, setSseEvents] = useState<LiveEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  // D10: SSE live event feed
  useEffect(() => {
    const es = new EventSource('/api/observability/stream');
    esRef.current = es;
    es.onmessage = (e) => {
      try { const event = JSON.parse(e.data) as LiveEvent; setSseEvents((prev) => [...prev.slice(-99), event]); } catch {}
    };
    return () => { es.close(); };
  }, []);

  useEffect(() => {
    api.getObservabilityMetrics().then(setMetrics).finally(() => setLoading(false));
  }, []);

  if (loading || !metrics) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-background-secondary rounded w-1/3" />
          <div className="h-32 bg-background-secondary rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Observability</h1>
        <p className="text-foreground-secondary mt-2">System-wide execution metrics, risk distribution, and policy decisions.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={<Activity className="w-5 h-5" />} label="Total Tasks" value={metrics.total_tasks} color="blue" />
        <MetricCard icon={<CheckCircle className="w-5 h-5" />} label="Completed" value={metrics.completed_tasks} color="green" />
        <MetricCard icon={<XCircle className="w-5 h-5" />} label="Failed" value={metrics.failed_tasks} color="red" />
        <MetricCard icon={<Clock className="w-5 h-5" />} label="Pending Approvals" value={metrics.pending_approvals} color="yellow" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5" />
            Risk Distribution
          </h2>
          <div className="space-y-3">
            <RiskBar label="Low" count={metrics.risk_distribution.low ?? 0} total={metrics.total_tasks || 1} color="green" />
            <RiskBar label="Medium" count={metrics.risk_distribution.medium ?? 0} total={metrics.total_tasks || 1} color="yellow" />
            <RiskBar label="High" count={metrics.risk_distribution.high ?? 0} total={metrics.total_tasks || 1} color="orange" />
            <RiskBar label="Critical" count={metrics.risk_distribution.critical ?? 0} total={metrics.total_tasks || 1} color="red" />
          </div>
        </div>

        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Policy Decisions
          </h2>
          <div className="space-y-3">
            <DecisionRow label="Allowed" count={metrics.policy_decisions.allow ?? 0} color="green" />
            <DecisionRow label="Require Approval" count={metrics.policy_decisions.require_approval ?? 0} color="yellow" />
            <DecisionRow label="Denied" count={metrics.policy_decisions.deny ?? 0} color="red" />
          </div>
          {metrics.avg_duration_ms && (
            <div className="mt-4 pt-4 border-t border-border">
              <span className="text-sm text-foreground-secondary">Avg. duration: </span>
              <span className="text-sm font-medium text-foreground">{formatDuration(metrics.avg_duration_ms)}</span>
            </div>
          )}
        </div>
      </div>

      {metrics.recent_errors.length > 0 && (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-status-error" />
            Recent Errors
          </h2>
          <div className="space-y-2">
            {metrics.recent_errors.map((error, i) => (
              <div key={i} className="flex items-start gap-2 p-2 rounded bg-status-error/5 border border-status-error/20">
                <XCircle className="w-4 h-4 text-status-error mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-foreground">{error.message}</p>
                  <p className="text-xs text-foreground-secondary">{error.task_id.slice(0, 8)}... &middot; {new Date(error.timestamp).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-4">Live Event Feed (SSE)</h2>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {sseEvents.length === 0 ? (
            <div className="text-center py-8 text-foreground-muted">Waiting for events...</div>
          ) : (
            sseEvents.slice().reverse().map((event, i) => (
              <div key={i} className="flex items-start gap-3 p-3 bg-background-elevated rounded-lg border border-border text-sm">
                <span className="text-xs text-foreground-muted font-mono">{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}</span>
                <span className="font-mono font-medium text-accent-secondary">{event.type || 'event'}</span>
                <span className="text-foreground-secondary flex-1 truncate">{JSON.stringify(event.data || event).slice(0, 200)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    green: 'bg-status-completed/10 text-status-completed border-status-completed/20',
    red: 'bg-status-error/10 text-status-error border-status-error/20',
    yellow: 'bg-status-paused/10 text-status-paused border-status-paused/20',
  };
  return (
    <div className={`border rounded-lg p-4 ${colors[color] || colors.blue}`}>
      <div className="flex items-center gap-2 mb-2">{icon}<span className="text-sm">{label}</span></div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function RiskBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const colors: Record<string, string> = {
    green: 'bg-risk-low',
    yellow: 'bg-risk-medium',
    orange: 'bg-risk-high',
    red: 'bg-risk-critical',
  };
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-foreground-secondary">{label}</span>
        <span className="text-foreground font-medium">{count} ({pct}%)</span>
      </div>
      <div className="h-2 bg-background-elevated rounded-full overflow-hidden">
        <div className={`h-full ${colors[color] || colors.green} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DecisionRow({ label, count, color }: { label: string; count: number; color: string }) {
  const colors: Record<string, string> = {
    green: 'text-status-completed',
    yellow: 'text-status-paused',
    red: 'text-status-error',
  };
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-foreground-secondary">{label}</span>
      <span className={`text-sm font-medium ${colors[color] || ''}`}>{count}</span>
    </div>
  );
}
