import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle, XCircle, Clock, Shield, BarChart3 } from 'lucide-react';
import type { ObservabilityMetrics } from '@djimitflo/shared';
import { api } from '../lib/api';
import { authenticatedFetch, useAuthStore } from '../lib/auth-store';
import { SelfHealingSection } from './SelfHealingSection';

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

// Truth audit 2026-11-12: every count is windowed and says so; a 7,377-char error is clamped, not repeated.
const WINDOWS = [1, 7, 30, 90, 365];
const windowLabel = (days: number) => (days === 1 ? 'last 24 hours' : `last ${days} days`);
const ERROR_CLAMP = 300;
const DOMINANT_SHARE = 0.95;

export function ObservabilityPage() {
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [sseEvents, setSseEvents] = useState<LiveEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
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
    api.getObservabilityMetrics(windowDays).then((next) => { setMetrics(next); setExpandedErrors(new Set()); })
      .catch(error => setMetricsError(error instanceof Error ? error.message : 'Metrics unavailable'))
      .finally(() => setLoading(false));
  }, [windowDays]);

  // W7: keep the page title when the metrics call fails (the route smoke found a bare error line)
  if (metricsError) return <div className="p-8 space-y-4"><h1 className="text-3xl font-bold text-foreground">Observability</h1><div role="alert" className="text-status-error">{metricsError}</div><SelfHealingSection /></div>;

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
  const dominant = Object.entries(metrics.risk_distribution).find(([, count]) => totalAssessments > 0 && count / totalAssessments > DOMINANT_SHARE);
  // an older server ignores ?days and returns all-time counts (no window_days): say so rather than mislabel them
  const period = metrics.window_days ? windowLabel(metrics.window_days) : 'all time';
  const outcomes = metrics.approval_outcomes;

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Observability</h1>
        <p className="text-foreground-secondary mt-2">System-wide execution metrics, risk-engine recommendations and approval outcomes.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-foreground-secondary">
            Window
            <select aria-label="Window" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}
              className="bg-background-secondary border border-border rounded-md px-2 py-1 text-foreground">
              {WINDOWS.map((days) => <option key={days} value={days}>{windowLabel(days)}</option>)}
            </select>
          </label>
          <span data-testid="metrics-window" className="text-xs text-foreground-muted">
            Counts cover the {period}: tasks by creation, assessments by time, approvals by when they were decided or expired.
            Pending approvals are current.
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={<Activity className="w-5 h-5" />} label="Tasks created" value={metrics.total_tasks} color="blue" />
        <MetricCard icon={<CheckCircle className="w-5 h-5" />} label="Completed" value={metrics.completed_tasks} color="green" />
        <MetricCard icon={<XCircle className="w-5 h-5" />} label="Failed" value={metrics.failed_tasks} color="red" />
        <MetricCard icon={<Clock className="w-5 h-5" />} label="Pending approvals (now)" value={metrics.pending_approvals} color="yellow" />
      </div>
      {metrics.avg_duration_ms ? (
        <p className="text-sm text-foreground-secondary">
          Avg. duration of completed tasks: <span className="font-medium text-foreground">{formatDuration(metrics.avg_duration_ms)}</span>
        </p>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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
          {dominant && (
            <p role="note" className="mt-4 text-xs text-foreground-secondary">
              {Math.round((dominant[1] / totalAssessments) * 100)}% of assessments are {dominant[0]}: this distribution carries little signal in this window.
            </p>
          )}
        </div>

        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Risk-engine recommendations
          </h2>
          <p className="text-xs text-foreground-muted mb-3">What the risk engine recommended per assessment. Not a decision: see approval outcomes.</p>
          <div className="space-y-3">
            <DecisionRow label="Allow" count={metrics.policy_decisions.allow ?? 0} color="green" />
            <DecisionRow label="Require approval" count={metrics.policy_decisions.require_approval ?? 0} color="yellow" />
            <DecisionRow label="Deny" count={metrics.policy_decisions.deny ?? 0} color="red" />
          </div>
        </div>

        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <CheckCircle className="w-5 h-5" />
            Approval outcomes
          </h2>
          <p className="text-xs text-foreground-muted mb-3">Approvals decided or expired in the {period}.</p>
          {outcomes ? (
            <div className="space-y-3">
              <DecisionRow label="Approved" count={outcomes.approved} color="green" />
              <DecisionRow label="Denied" count={outcomes.denied} color="red" />
              <DecisionRow label="Expired" count={outcomes.expired} color="yellow" />
            </div>
          ) : <p className="text-sm text-foreground-secondary">Not reported by this server version.</p>}
        </div>
      </div>

      {metrics.recent_errors.length > 0 && (
        <div className="bg-background-secondary border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-status-error" />
            Recent errors
            <span className="text-xs font-normal text-foreground-muted">identical messages grouped</span>
          </h2>
          <div className="space-y-2">
            {metrics.recent_errors.map((error, i) => {
              const long = error.message.length > ERROR_CLAMP;
              const expanded = expandedErrors.has(i);
              return (
                <div key={i} data-testid="recent-error" className="flex items-start gap-2 p-2 rounded bg-status-error/5 border border-status-error/20">
                  <XCircle className="w-4 h-4 text-status-error mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground break-words whitespace-pre-wrap">
                      {(error.count ?? 1) > 1 && <span className="mr-2 rounded bg-status-error/10 px-1.5 text-xs font-semibold text-status-error">×{error.count}</span>}
                      {long && !expanded ? `${error.message.slice(0, ERROR_CLAMP)}…` : error.message}
                    </p>
                    {long && (
                      <button type="button" className="text-xs underline text-foreground-secondary"
                        onClick={() => setExpandedErrors((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; })}>
                        {expanded ? 'Show less' : `Show full message (${error.message.length} chars)`}
                      </button>
                    )}
                    <p className="text-xs text-foreground-secondary">
                      {error.task_id.slice(0, 8)}... &middot; {(error.count ?? 1) > 1 ? 'latest ' : ''}{new Date(error.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
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

      <SelfHealingSection />
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
