import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle, XCircle, Clock, Shield, BarChart3 } from 'lucide-react';
import type { ObservabilityMetrics } from '@djimitflo/shared';
import { api } from '../lib/api';
import { authenticatedFetch, useAuthStore } from '../lib/auth-store';

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

/**
 * OBS-004: the feed has an explicit lifecycle. A clean EOF or an error is never shown as a quiet healthy stream:
 * it reconnects with backoff, at most MAX_RECONNECTS times per flapping episode, then shows 'closed'.
 * Live events are not replayed across a reconnect; the durable record is the audit log.
 */
type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';
const MAX_RECONNECTS = 5;
const STABLE_STREAM_MS = 60_000; // a stream that stayed open this long resets the reconnect budget
const reconnectDelay = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 15_000);

export function ObservabilityPage() {
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [sseEvents, setSseEvents] = useState<LiveEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const token = useAuthStore((state) => state.token);

  // D10: SSE live event feed
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = async (): Promise<void> => {
      let openedAt: number | null = null;
      setStreamState(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const response = await authenticatedFetch('/observability/stream', { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`Stream unavailable (${response.status})`);
        setStreamError(null);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || controller.signal.aborted) break;
          buffer += value;
          const messages = buffer.split('\n\n');
          buffer = messages.pop() || '';
          for (const message of messages) {
            const data = message.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
            if (!data) continue;
            try {
              const event = JSON.parse(data) as LiveEvent;
              // the handshake is a lifecycle marker, not an event
              if (event.type === 'connected') { openedAt = Date.now(); setStreamState('open'); continue; }
              setSseEvents((previous) => [...previous.slice(-99), event]);
            } catch { /* Ignore malformed external events. */ }
          }
        }
        if (!controller.signal.aborted) setStreamError('Stream ended by the server');
      } catch (error) {
        if (!controller.signal.aborted) setStreamError(error instanceof Error ? error.message : 'Stream unavailable');
      }
      if (controller.signal.aborted) return;
      if (openedAt !== null && Date.now() - openedAt >= STABLE_STREAM_MS) attempt = 0;
      if (attempt >= MAX_RECONNECTS) { setStreamState('closed'); return; }
      attempt += 1;
      setReconnectAttempt(attempt);
      setStreamState('reconnecting');
      retry = setTimeout(() => { void connect(); }, reconnectDelay(attempt));
    };

    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [token, streamGeneration]);

  useEffect(() => {
    api.getObservabilityMetrics().then(setMetrics)
      .catch(error => setMetricsError(error instanceof Error ? error.message : 'Metrics unavailable'))
      .finally(() => setLoading(false));
  }, []);

  // W7: keep the page title when the metrics call fails (the route smoke found a bare error line)
  if (metricsError) return <div className="p-8 space-y-4"><h1 className="text-3xl font-bold text-foreground">Observability</h1><div role="alert" className="text-status-error">{metricsError}</div></div>;

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

  const totalAssessments = Object.values(metrics.risk_distribution).reduce((sum, count) => sum + count, 0);

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
            Risk Assessments
          </h2>
          <div className="space-y-3">
            <RiskBar label="Low" count={metrics.risk_distribution.low ?? 0} total={totalAssessments} color="green" />
            <RiskBar label="Medium" count={metrics.risk_distribution.medium ?? 0} total={totalAssessments} color="yellow" />
            <RiskBar label="High" count={metrics.risk_distribution.high ?? 0} total={totalAssessments} color="orange" />
            <RiskBar label="Critical" count={metrics.risk_distribution.critical ?? 0} total={totalAssessments} color="red" />
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
        <h2 className="text-xl font-semibold text-foreground mb-2 flex items-center gap-3">
          Live Event Feed (SSE)
          <span data-testid="stream-status" className={`text-xs font-mono px-2 py-0.5 rounded border ${streamState === 'open' ? 'text-status-completed border-status-completed/30' : streamState === 'closed' ? 'text-status-error border-status-error/30' : 'text-status-paused border-status-paused/30'}`}>{streamState}</span>
        </h2>
        <p className="text-xs text-foreground-muted mb-4">
          Live only: the last 100 events while connected. Events during a disconnect are not replayed; the durable record is the <a href="/audit" className="underline">Audit log</a>.
        </p>
        {streamState !== 'open' && streamState !== 'connecting' && (
          <div role="status" className="mb-3 p-3 rounded border border-status-error/20 bg-status-error/5 text-sm text-status-error flex items-center justify-between gap-3">
            <span>
              {streamState === 'closed'
                ? `Live stream closed after ${reconnectAttempt} reconnect attempts${streamError ? ` (${streamError})` : ''}.`
                : `${streamError ?? 'Stream ended'}. Reconnecting (attempt ${reconnectAttempt}/${MAX_RECONNECTS})...`}
            </span>
            {streamState === 'closed' && (
              <button type="button" className="underline shrink-0" onClick={() => setStreamGeneration((g) => g + 1)}>Reconnect</button>
            )}
          </div>
        )}
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {sseEvents.length === 0 ? (
            <div className="text-center py-8 text-foreground-muted">
              {streamState === 'open' ? 'Connected. Waiting for events...' : streamState === 'connecting' ? 'Connecting to live stream...' : 'No live events received.'}
            </div>
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
