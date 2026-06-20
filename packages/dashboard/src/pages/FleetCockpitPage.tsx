import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  Cpu,
  Gauge,
  Play,
  RefreshCw,
  TrendingUp,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Users,
  Layers,
} from 'lucide-react';
import { api, type LoopRunRecord, type WorkerLeaseRecord } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

interface FleetMetrics {
  totalRuntime: string;
  poolStatus: {
    available: number;
    prepared: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
  };
  tokenUsage: {
    used: number;
    budget: number;
    perSuccessful: number;
  };
  workerDistribution: {
    maker: number;
    checker: number;
    security_checker: number;
    memory_curator: number;
    governance_guard: number;
  };
  warnings: Array<{
    id: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    timestamp: string;
  }>;
  blockedReasons: {
    reason: string;
    count: number;
  }[];
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'prepared':
    case 'running':
      return 'text-blue-600';
    case 'completed':
      return 'text-green-600';
    case 'failed':
      return 'text-red-600';
    case 'queued':
      return 'text-amber-600';
    default:
      return 'text-gray-600';
  }
}

function getStatusBgColor(status: string): string {
  switch (status) {
    case 'prepared':
    case 'running':
      return 'bg-blue-100';
    case 'completed':
      return 'bg-green-100';
    case 'failed':
      return 'bg-red-100';
    case 'queued':
      return 'bg-amber-100';
    default:
      return 'bg-gray-100';
  }
}

function getWarningColor(severity: string): string {
  switch (severity) {
    case 'error':
      return 'bg-red-50 border-red-200';
    case 'warning':
      return 'bg-amber-50 border-amber-200';
    default:
      return 'bg-blue-50 border-blue-200';
  }
}

function getWarningIcon(severity: string) {
  switch (severity) {
    case 'error':
      return <XCircle className="w-5 h-5 text-red-600" />;
    case 'warning':
      return <AlertTriangle className="w-5 h-5 text-amber-600" />;
    default:
      return <AlertCircle className="w-5 h-5 text-blue-600" />;
  }
}

export function FleetCockpitPage() {
  const [runs, setRuns] = useState<LoopRunRecord[]>([]);
  const [allLeases, setAllLeases] = useState<WorkerLeaseRecord[]>([]);
  const [metrics, setMetrics] = useState<FleetMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { subscribe } = useWebSocket(true);

  const computeMetrics = useCallback((runs: LoopRunRecord[], leases: WorkerLeaseRecord[]) => {
    const poolStatus = {
      available: runs.filter(r => r.status === 'created').length,
      prepared: leases.filter(l => l.status === 'prepared').length,
      queued: leases.filter(l => l.status === 'prepared' && Date.now() - new Date(l.created_at).getTime() > 5000).length,
      running: leases.filter(l => l.status === 'running').length,
      completed: leases.filter(l => l.status === 'completed').length,
      failed: leases.filter(l => l.status === 'failed').length,
    };

    const workerDistribution = {
      maker: leases.filter(l => l.role === 'maker').length,
      checker: leases.filter(l => l.role === 'checker').length,
      security_checker: leases.filter(l => l.role === 'security_checker').length,
      memory_curator: leases.filter(l => l.role === 'memory_curator').length,
      governance_guard: leases.filter(l => l.role === 'governance_guard').length,
    };

    const successfulLeases = leases.filter(l => l.status === 'completed').length || 1;
    const totalTokens = leases.reduce((sum, l) => {
      const budget = l.budget as Record<string, unknown>;
      return sum + (typeof budget?.token_used === 'number' ? budget.token_used : 0);
    }, 0);

    const warnings: FleetMetrics['warnings'] = [];

    // Token budget warning
    if (totalTokens > 1000000) {
      warnings.push({
        id: 'token-budget',
        severity: 'warning',
        message: `High token usage: ${formatTokens(totalTokens)} tokens used across fleet`,
        timestamp: new Date().toISOString(),
      });
    }

    // Failed leases
    const failedCount = poolStatus.failed;
    if (failedCount > 0) {
      warnings.push({
        id: 'failed-workers',
        severity: 'error',
        message: `${failedCount} worker lease(s) failed. Review leases for errors.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Queue depth
    if (poolStatus.queued > 10) {
      warnings.push({
        id: 'queue-depth',
        severity: 'warning',
        message: `High queue depth: ${poolStatus.queued} leases queued. Capacity may be strained.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Escalated loops
    const escalatedRuns = runs.filter(r => r.status === 'escalated').length;
    if (escalatedRuns > 0) {
      warnings.push({
        id: 'escalated-loops',
        severity: 'warning',
        message: `${escalatedRuns} loop(s) escalated. Human review required.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Blocked loops
    const blockedRuns = runs.filter(r => r.status === 'blocked').length;
    if (blockedRuns > 0) {
      warnings.push({
        id: 'blocked-loops',
        severity: 'info',
        message: `${blockedRuns} loop(s) blocked by gates. Check gate verdicts.`,
        timestamp: new Date().toISOString(),
      });
    }

    const blockedReasons = [
      { reason: 'checker_verdict', count: runs.filter(r => r.gates?.some(g => g.name === 'checker_verdict' && g.status === 'fail')).length },
      { reason: 'security_checker', count: runs.filter(r => r.gates?.some(g => g.name === 'security_checker_verdict' && g.status === 'fail')).length },
      { reason: 'deterministic_gate', count: runs.filter(r => r.gates?.some(g => g.name === 'deterministic_checks' && g.status === 'fail')).length },
    ].filter(r => r.count > 0);

    return {
      totalRuntime: new Date().toLocaleString(),
      poolStatus,
      tokenUsage: {
        used: totalTokens,
        budget: 10000000, // 10M token fleet budget
        perSuccessful: Math.ceil(totalTokens / successfulLeases),
      },
      workerDistribution,
      warnings: warnings.sort((a, b) => {
        const severityOrder = { error: 0, warning: 1, info: 2 };
        return severityOrder[a.severity as keyof typeof severityOrder] - severityOrder[b.severity as keyof typeof severityOrder];
      }),
      blockedReasons,
    };
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [runsRes] = await Promise.all([api.getLoopRuns()]);
      setRuns(runsRes.runs || []);

      // Collect all leases from all runs
      const allLeases: WorkerLeaseRecord[] = [];
      for (const run of runsRes.runs || []) {
        try {
          const bundle = await api.getLoopReviewBundle(run.id);
          allLeases.push(...(bundle.leases || []));
        } catch (err) {
          console.error(`Failed to load leases for run ${run.id}:`, err);
        }
      }
      setAllLeases(allLeases);

      const newMetrics = computeMetrics(runsRes.runs || [], allLeases);
      setMetrics(newMetrics);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load fleet data');
    } finally {
      setLoading(false);
    }
  }, [computeMetrics]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  // WebSocket subscriptions
  useEffect(() => {
    const unsub = subscribe('LOOP_RUN_UPDATED' as any, () => {
      void fetchData();
    });
    return unsub;
  }, [subscribe, fetchData]);

  if (loading && !metrics) {
    return (
      <div className="p-8 flex items-center justify-center min-h-screen">
        <div className="text-center">
          <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-4 text-foreground-secondary" />
          <p className="text-foreground-secondary">Loading fleet status...</p>
        </div>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-900">Error Loading Fleet Data</h3>
              <p className="text-red-700 mt-1">{error || 'Failed to load fleet metrics'}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const tokenUsagePercent = Math.round((metrics.tokenUsage.used / metrics.tokenUsage.budget) * 100);

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Fleet Cockpit</h1>
          <p className="text-foreground-secondary mt-2">Real-time pool status, queue depth, and resource utilization.</p>
        </div>
        <button
          onClick={() => void fetchData()}
          disabled={loading}
          className="p-2 hover:bg-background-elevated rounded-lg transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-5 h-5 text-foreground-secondary ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Top Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Pool Status */}
        <div className="bg-background-elevated rounded-lg p-4 border border-background-border">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-foreground-secondary text-sm font-medium">Total Leases</p>
              <p className="text-3xl font-bold text-foreground mt-1">
                {metrics.poolStatus.prepared + metrics.poolStatus.queued + metrics.poolStatus.running}
              </p>
            </div>
            <Users className="w-6 h-6 text-blue-600" />
          </div>
          <p className="text-foreground-secondary text-xs mt-3">
            {metrics.poolStatus.running} running, {metrics.poolStatus.prepared} prepared
          </p>
        </div>

        {/* Token Usage */}
        <div className="bg-background-elevated rounded-lg p-4 border border-background-border">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-foreground-secondary text-sm font-medium">Tokens Used</p>
              <p className="text-3xl font-bold text-foreground mt-1">
                {formatTokens(metrics.tokenUsage.used)}
              </p>
            </div>
            <Zap className={`w-6 h-6 ${tokenUsagePercent > 80 ? 'text-red-600' : 'text-green-600'}`} />
          </div>
          <div className="mt-3">
            <div className="bg-background rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all ${
                  tokenUsagePercent > 80 ? 'bg-red-600' : tokenUsagePercent > 50 ? 'bg-amber-600' : 'bg-green-600'
                }`}
                style={{ width: `${Math.min(tokenUsagePercent, 100)}%` }}
              />
            </div>
            <p className="text-foreground-secondary text-xs mt-1">{tokenUsagePercent}% of budget</p>
          </div>
        </div>

        {/* Queue Depth */}
        <div className="bg-background-elevated rounded-lg p-4 border border-background-border">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-foreground-secondary text-sm font-medium">Queue Depth</p>
              <p className="text-3xl font-bold text-foreground mt-1">{metrics.poolStatus.queued}</p>
            </div>
            <Layers className="w-6 h-6 text-amber-600" />
          </div>
          <p className="text-foreground-secondary text-xs mt-3">
            {metrics.poolStatus.queued > 10 ? '⚠️ High' : 'Normal'} queue load
          </p>
        </div>

        {/* Success Rate */}
        <div className="bg-background-elevated rounded-lg p-4 border border-background-border">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-foreground-secondary text-sm font-medium">Completion</p>
              <p className="text-3xl font-bold text-foreground mt-1">
                {allLeases.length > 0
                  ? Math.round(
                      (metrics.poolStatus.completed / (metrics.poolStatus.completed + metrics.poolStatus.failed || 1)) * 100
                    )
                  : 0}
                %
              </p>
            </div>
            <CheckCircle2 className="w-6 h-6 text-green-600" />
          </div>
          <p className="text-foreground-secondary text-xs mt-3">
            {metrics.poolStatus.completed} completed
          </p>
        </div>
      </div>

      {/* Pool Status & Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Pool Status Breakdown */}
        <div className="bg-background-elevated rounded-lg p-6 border border-background-border">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-blue-600" />
            Pool Status
          </h2>
          <div className="space-y-3">
            {[
              { label: 'Running', count: metrics.poolStatus.running, color: 'bg-blue-100 text-blue-700', icon: '▶' },
              { label: 'Prepared', count: metrics.poolStatus.prepared, color: 'bg-teal-100 text-teal-700', icon: '◐' },
              { label: 'Queued', count: metrics.poolStatus.queued, color: 'bg-amber-100 text-amber-700', icon: '⏳' },
              { label: 'Completed', count: metrics.poolStatus.completed, color: 'bg-green-100 text-green-700', icon: '✓' },
              { label: 'Failed', count: metrics.poolStatus.failed, color: 'bg-red-100 text-red-700', icon: '✕' },
            ].map((status) => (
              <div key={status.label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 rounded text-sm font-medium ${status.color}`}>
                    {status.icon} {status.label}
                  </span>
                </div>
                <span className="text-2xl font-bold text-foreground">{status.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Worker Distribution */}
        <div className="bg-background-elevated rounded-lg p-6 border border-background-border">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-purple-600" />
            Worker Roles
          </h2>
          <div className="space-y-3">
            {[
              { role: 'Maker', count: metrics.workerDistribution.maker, color: 'text-blue-700' },
              { role: 'Checker', count: metrics.workerDistribution.checker, color: 'text-green-700' },
              { role: 'Security', count: metrics.workerDistribution.security_checker, color: 'text-red-700' },
              { role: 'Memory', count: metrics.workerDistribution.memory_curator, color: 'text-purple-700' },
              { role: 'Governance', count: metrics.workerDistribution.governance_guard, color: 'text-amber-700' },
            ].map((worker) => (
              <div key={worker.role} className="flex items-center justify-between">
                <span className={`font-medium ${worker.color}`}>{worker.role}</span>
                <span className="text-lg font-bold text-foreground">{worker.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Warnings & Issues */}
      {metrics.warnings.length > 0 && (
        <div className="bg-background-elevated rounded-lg p-6 border border-background-border">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            Fleet Alerts ({metrics.warnings.length})
          </h2>
          <div className="space-y-3">
            {metrics.warnings.map((warning) => (
              <div
                key={warning.id}
                className={`rounded-lg p-4 border flex items-start gap-3 ${getWarningColor(warning.severity)}`}
              >
                {getWarningIcon(warning.severity)}
                <div className="flex-1">
                  <p className="text-foreground font-medium">{warning.message}</p>
                  <p className="text-foreground-secondary text-xs mt-1">
                    {new Date(warning.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocked Reasons */}
      {metrics.blockedReasons.length > 0 && (
        <div className="bg-background-elevated rounded-lg p-6 border border-background-border">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-amber-600" />
            Gate Failures
          </h2>
          <div className="space-y-2">
            {metrics.blockedReasons.map((reason) => (
              <div key={reason.reason} className="flex items-center justify-between p-3 bg-background rounded-lg">
                <span className="text-foreground font-medium capitalize">{reason.reason.replace(/_/g, ' ')}</span>
                <span className="px-3 py-1 bg-red-100 text-red-700 rounded-full font-semibold">{reason.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Token Efficiency */}
      <div className="bg-background-elevated rounded-lg p-6 border border-background-border">
        <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-green-600" />
          Efficiency Metrics
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p className="text-foreground-secondary text-sm font-medium">Tokens per Successful Worker</p>
            <p className="text-2xl font-bold text-foreground mt-2">
              {formatTokens(metrics.tokenUsage.perSuccessful)}
            </p>
          </div>
          <div>
            <p className="text-foreground-secondary text-sm font-medium">Fleet Budget Remaining</p>
            <p className="text-2xl font-bold text-foreground mt-2">
              {formatTokens(metrics.tokenUsage.budget - metrics.tokenUsage.used)}
            </p>
          </div>
          <div>
            <p className="text-foreground-secondary text-sm font-medium">Loop Runs (Total)</p>
            <p className="text-2xl font-bold text-foreground mt-2">{runs.length}</p>
          </div>
        </div>
      </div>

      {/* System Status Footer */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-blue-600" />
          <div>
            <p className="text-blue-900 font-medium">Fleet Status: Operational</p>
            <p className="text-blue-700 text-sm">Last updated: {metrics.totalRuntime}</p>
          </div>
        </div>
        <button className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2">
          <Play className="w-4 h-4" />
          Start Loop
        </button>
      </div>
    </div>
  );
}
