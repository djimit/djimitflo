import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Clock,
  Cpu,
  FileText,
  Gauge,
  Layers,
  Play,
  RefreshCw,
  Route,
  Server,
  ShieldCheck,
  Square,
  Zap,
} from 'lucide-react';
import {
  api,
  type RuntimeContract,
  type SchedulerTickResult,
  type SwarmRealityStatus,
  type WorkerPoolDecision,
  type WorkerPoolPlanResult,
} from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';

type RuntimeChoice = 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'mock' | 'manual';
type CheckerRuntimeChoice = Exclude<RuntimeChoice, 'manual'>;

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatBytes(value: number): string {
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${value} B`;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function statusTone(eligible: boolean, status: string): string {
  if (eligible) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700';
  if (status === 'running') return 'border-blue-500/30 bg-blue-500/10 text-blue-700';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-700';
}

function bottleneckCounts(plan: WorkerPoolPlanResult | null): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const decision of plan?.decisions || []) {
    for (const reason of decision.blocked_reasons) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function queueByRisk(decisions: WorkerPoolDecision[]): Record<string, number> {
  return decisions.reduce((acc, decision) => {
    if (decision.status !== 'prepared') return acc;
    acc[decision.risk_class] = (acc[decision.risk_class] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

export function FleetCockpitPage() {
  const [status, setStatus] = useState<SwarmRealityStatus | null>(null);
  const [plan, setPlan] = useState<WorkerPoolPlanResult | null>(null);
  const [contracts, setContracts] = useState<Record<string, RuntimeContract>>({});
  const [schedulerResult, setSchedulerResult] = useState<SchedulerTickResult | null>(null);
  const [runtime, setRuntime] = useState<RuntimeChoice>('mock');
  const [checkerRuntime, setCheckerRuntime] = useState<CheckerRuntimeChoice>('mock');
  const [maxWorkers, setMaxWorkers] = useState(2);
  const [repositoryPath, setRepositoryPath] = useState('/Users/dlandman/djimitflo');
  const [workItemIds, setWorkItemIds] = useState('');
  const [ignoreCapacity, setIgnoreCapacity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { subscribe } = useWebSocket(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextPlan, nextContracts] = await Promise.all([
        api.getSwarmStatus(),
        api.planWorkerPool({
          runtime,
          checker_runtime: checkerRuntime,
          max_workers: maxWorkers,
          ignore_capacity: ignoreCapacity,
        }),
        api.getRuntimeContracts(),
      ]);
      setStatus(nextStatus);
      setPlan(nextPlan);
      setContracts(nextContracts.runtimes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load fleet cockpit');
    } finally {
      setLoading(false);
    }
  }, [checkerRuntime, ignoreCapacity, maxWorkers, runtime]);

  async function runAction(name: string, fn: () => Promise<unknown>) {
    setAction(name);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fleet action failed');
    } finally {
      setAction(null);
    }
  }

  async function runScheduler(name: string, input: { plan_triaged?: boolean; prepare_planned?: boolean }) {
    await runAction(name, async () => {
      const ids = workItemIds
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const result = await api.runSchedulerTick({
        ...input,
        runtime,
        repository_path: repositoryPath.trim() || undefined,
        max_items: 50,
        max_assignments_per_item: 1,
        work_item_ids: ids.length > 0 ? ids : undefined,
      });
      setSchedulerResult(result);
    });
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubLoop = subscribe('LOOP_RUN_UPDATED' as any, () => void refresh());
    const unsubProof = subscribe('PROOF_RUN_UPDATED' as any, () => void refresh());
    return () => {
      unsubLoop();
      unsubProof();
    };
  }, [refresh, subscribe]);

  const queue = useMemo(() => (plan?.decisions || []).filter((decision) => decision.status === 'prepared'), [plan]);
  const running = useMemo(() => (plan?.decisions || []).filter((decision) => decision.status === 'running'), [plan]);
  const eligible = useMemo(() => queue.filter((decision) => decision.eligible), [queue]);
  const risks = useMemo(() => queueByRisk(queue), [queue]);
  const bottlenecks = useMemo(() => bottleneckCounts(plan), [plan]);
  const selectedPool = status?.fleet_pools.find((pool) => pool.runtime === runtime);
  const totalQueued = status?.fleet_pools.reduce((sum, pool) => sum + pool.queued_leases, 0) || 0;
  const totalRunning = status?.fleet_pools.reduce((sum, pool) => sum + pool.running_leases, 0) || 0;
  const totalCompleted = status?.fleet_pools.reduce((sum, pool) => sum + pool.completed_24h, 0) || 0;
  const totalFailed = status?.fleet_pools.reduce((sum, pool) => sum + pool.failed_24h, 0) || 0;
  const totalTokens = status?.fleet_pools.reduce((sum, pool) => sum + pool.tokens_used_24h, 0) || 0;
  const topology = status?.fleet_topology || [];
  const contractRows = Object.values(contracts);

  if (loading && !status) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="text-center text-foreground-secondary">
          <RefreshCw className="mx-auto mb-4 h-8 w-8 animate-spin" />
          Loading fleet cockpit...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Fleet Cockpit</h1>
          <p className="mt-2 text-sm text-foreground-secondary">
            Worker pool, queue, capacity, throughput, and next executable leases.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={runtime}
            onChange={(event) => setRuntime(event.target.value as RuntimeChoice)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="codex">codex</option>
            <option value="opencode">opencode</option>
            <option value="claude">claude</option>
            <option value="gemini">gemini</option>
            <option value="editor">editor</option>
            <option value="mock">mock</option>
            <option value="manual">manual</option>
          </select>
          <select
            value={checkerRuntime}
            onChange={(event) => setCheckerRuntime(event.target.value as CheckerRuntimeChoice)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            title="Checker runtime"
          >
            <option value="mock">checker mock</option>
            <option value="codex">checker codex</option>
            <option value="opencode">checker opencode</option>
            <option value="claude">checker claude</option>
            <option value="gemini">checker gemini</option>
            <option value="editor">checker editor</option>
          </select>
          <input
            type="number"
            min={1}
            max={20}
            value={maxWorkers}
            onChange={(event) => setMaxWorkers(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
            className="w-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            title="Max workers"
          />
          <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground-secondary">
            <input
              type="checkbox"
              checked={ignoreCapacity}
              onChange={(event) => setIgnoreCapacity(event.target.checked)}
              className="h-4 w-4"
            />
            ignore capacity
          </label>
          <button
            onClick={() => void refresh()}
            disabled={loading || action !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground hover:border-accent/40 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <Metric icon={<Layers className="h-5 w-5" />} label="Queued" value={totalQueued} detail={`${eligible.length} executable`} />
        <Metric icon={<Activity className="h-5 w-5" />} label="Running" value={totalRunning} detail={`${status?.active_execution_count || 0} evidenced`} />
        <Metric icon={<BarChart3 className="h-5 w-5" />} label="Completed 24h" value={totalCompleted} detail={`${totalFailed} failed`} />
        <Metric icon={<Zap className="h-5 w-5" />} label="Tokens 24h" value={formatNumber(totalTokens)} detail="runtime reported" />
        <Metric icon={<Cpu className="h-5 w-5" />} label="CPU Threads" value={status?.resource_snapshot.cpu_threads || 0} detail={`${formatBytes(status?.resource_snapshot.free_memory_bytes || 0)} free`} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_0.8fr]">
        <section className="rounded-lg border border-border bg-background-secondary p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Runtime Pools</h2>
              <p className="text-xs text-foreground-tertiary">Capacity and queue depth by runtime.</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void runAction('start-next', () => api.startNextWorker({ runtime, checker_runtime: checkerRuntime, ignore_capacity: ignoreCapacity }))}
                disabled={action !== null || !eligible.length}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Start next
              </button>
              <button
                onClick={() => void runAction('drain', () => api.drainWorkerPool({ runtime, checker_runtime: checkerRuntime, max_workers: maxWorkers, ignore_capacity: ignoreCapacity }))}
                disabled={action !== null || !eligible.length}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground hover:border-accent/40 disabled:opacity-50"
              >
                <Gauge className="h-4 w-4" />
                Drain
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {(status?.fleet_pools || []).map((pool) => (
              <button
                key={pool.runtime}
                onClick={() => setRuntime(pool.runtime as RuntimeChoice)}
                className={`rounded-lg border p-4 text-left transition-colors ${
                  runtime === pool.runtime ? 'border-accent/50 bg-accent/5' : 'border-border bg-background hover:border-accent/30'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Server className="h-4 w-4 text-accent" />
                      {pool.runtime}
                    </div>
                    <div className="mt-1 text-xs text-foreground-tertiary">
                      {pool.available ? 'available' : pool.bottleneck_reason || 'blocked'}
                    </div>
                  </div>
                  <span className="rounded-full bg-background-elevated px-2 py-1 text-xs text-foreground-secondary">
                    cap {pool.recommended_concurrency}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <SmallStat label="Queue" value={pool.queued_leases} />
                  <SmallStat label="Running" value={pool.running_leases} />
                  <SmallStat label="Capacity" value={`${pool.capacity_used_percent}%`} />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <SmallStat label="Avg runtime" value={formatDuration(pool.average_runtime_ms)} />
                  <SmallStat label="Fail rate" value={percent(pool.failure_rate_24h)} />
                  <SmallStat label="Tokens/worker" value={formatNumber(pool.tokens_per_successful_worker)} />
                  <SmallStat label="Tokens/diff" value={formatNumber(pool.tokens_per_diff_line)} />
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-background-secondary p-4">
          <h2 className="text-lg font-semibold text-foreground">Capacity Snapshot</h2>
          <div className="mt-4 space-y-3 text-sm">
            <InfoRow label="Selected runtime" value={runtime} />
            <InfoRow label="Recommended concurrency" value={selectedPool?.recommended_concurrency ?? 0} />
            <InfoRow label="Oldest queued" value={formatDuration(selectedPool?.oldest_queued_age_ms)} />
            <InfoRow label="Next action" value={selectedPool?.next_recommended_action || 'wait'} />
            <InfoRow label="Load average" value={(status?.resource_snapshot.load_average || []).map((value) => value.toFixed(2)).join(' / ') || '-'} />
            <InfoRow label="Backlog open" value={status?.task_count.open_work_items ?? 0} />
          </div>
          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Queue by risk</h3>
            <div className="flex flex-wrap gap-2">
              {Object.keys(risks).length === 0 ? (
                <span className="text-sm text-foreground-tertiary">No prepared queue for selected plan.</span>
              ) : Object.entries(risks).map(([risk, count]) => (
                <span key={risk} className="rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground-secondary">
                  {risk}: {count}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Top bottlenecks</h3>
            <div className="space-y-2">
              {bottlenecks.length === 0 ? (
                <span className="text-sm text-foreground-tertiary">No blocked prepared leases in this plan.</span>
              ) : bottlenecks.map((item) => (
                <div key={item.reason} className="flex items-center justify-between rounded-lg bg-background p-2 text-sm">
                  <span className="truncate text-foreground-secondary">{item.reason}</span>
                  <span className="font-semibold text-foreground">{item.count}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-background-secondary p-4">
        <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Backlog Batch Flow</h2>
            <p className="text-xs text-foreground-tertiary">Triaged work items {'>'} goals {'>'} loop runs {'>'} prepared leases.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={repositoryPath}
              onChange={(event) => setRepositoryPath(event.target.value)}
              className="w-72 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="repository path"
            />
            <input
              type="text"
              value={workItemIds}
              onChange={(event) => setWorkItemIds(event.target.value)}
              className="w-72 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="optional work item ids"
            />
            <button
              onClick={() => void runScheduler('plan-triaged', { plan_triaged: true })}
              disabled={action !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground hover:border-accent/40 disabled:opacity-50"
            >
              <FileText className="h-4 w-4" />
              Plan
            </button>
            <button
              onClick={() => void runScheduler('prepare-planned', { prepare_planned: true })}
              disabled={action !== null}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground hover:border-accent/40 disabled:opacity-50"
            >
              <Layers className="h-4 w-4" />
              Prepare
            </button>
            <button
              onClick={() => void runScheduler('plan-prepare', { plan_triaged: true, prepare_planned: true })}
              disabled={action !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <Route className="h-4 w-4" />
              Plan + prepare
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <SmallStat label="Created backlog" value={schedulerResult?.created_work_items.length ?? 0} />
          <SmallStat label="Planned goals" value={schedulerResult?.planned_work_items.length ?? 0} />
          <SmallStat label="Prepared items" value={schedulerResult?.prepared_work_items.length ?? 0} />
          <SmallStat label="Leases created" value={schedulerResult?.leases_created ?? 0} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Runtime Contracts</h2>
            <p className="text-xs text-foreground-tertiary">Adapter status before real worker execution.</p>
          </div>
          <ShieldCheck className="h-5 w-5 text-accent" />
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {contractRows.map((contract) => (
            <div key={contract.runtime} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-foreground">{contract.runtime}</span>
                <span className={`rounded-full px-2 py-1 text-xs ${contract.status === 'ok' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'}`}>
                  {contract.status}
                </span>
              </div>
              <div className="mt-2 space-y-1 text-xs text-foreground-tertiary">
                <div className="truncate">command: {contract.command || '-'}</div>
                <div>json: {Array.isArray(contract.json_flag) ? contract.json_flag.join(' ') : contract.json_flag || '-'}</div>
                <div>cwd: {contract.cwd_flag || '-'}</div>
                <div>probed: {contract.probed_at ? new Date(contract.probed_at).toLocaleTimeString() : '-'}</div>
              </div>
            </div>
          ))}
          {contractRows.length === 0 && (
            <div className="text-sm text-foreground-tertiary">No runtime contracts reported.</div>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Worker Queue</h2>
            <p className="text-xs text-foreground-tertiary">Sorted by priority, checker-first, then queue age.</p>
          </div>
          <div className="text-sm text-foreground-secondary">
            {queue.length} prepared, {running.length} running
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-foreground-tertiary">
              <tr>
                <th className="py-2 pr-3">Lease</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Runtime</th>
                <th className="py-2 pr-3">Risk</th>
                <th className="py-2 pr-3">Age</th>
                <th className="py-2 pr-3">Priority</th>
                <th className="py-2 pr-3">Action</th>
                <th className="py-2 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {(plan?.decisions || []).slice(0, 30).map((decision) => (
                <tr key={decision.lease_id} className="border-b border-border/60">
                  <td className="max-w-[180px] truncate py-3 pr-3 font-mono text-xs text-foreground">{decision.lease_id}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{decision.role}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{decision.effective_runtime}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{decision.risk_class}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{formatDuration(decision.queue_age_ms)}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{decision.priority_score}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">
                    <div className="flex items-center gap-2">
                      <span>{decision.next_action}</span>
                      {decision.status === 'running' && (
                        <button
                          onClick={() => void runAction(`stop-${decision.lease_id}`, () => api.stopWorkerLease(decision.lease_id))}
                          disabled={action !== null}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:border-status-error/40 disabled:opacity-50"
                          title="Stop worker lease"
                        >
                          <Square className="h-3 w-3" />
                          Stop
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="py-3 pr-3">
                    <span className={`rounded-full border px-2 py-1 text-xs ${statusTone(decision.eligible, decision.status)}`}>
                      {decision.eligible ? 'eligible' : decision.bottleneck_reason || decision.status}
                    </span>
                  </td>
                </tr>
              ))}
              {(!plan || plan.decisions.length === 0) && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-foreground-tertiary">
                    No worker leases in this pool plan.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Fleet Topology</h2>
            <p className="text-xs text-foreground-tertiary">Goal {'>'} loop {'>'} lease {'>'} runtime {'>'} artifact {'>'} gate {'>'} action.</p>
          </div>
          <div className="text-sm text-foreground-secondary">{topology.length} leases</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-foreground-tertiary">
              <tr>
                <th className="py-2 pr-3">Goal</th>
                <th className="py-2 pr-3">Loop</th>
                <th className="py-2 pr-3">Lease</th>
                <th className="py-2 pr-3">Runtime</th>
                <th className="py-2 pr-3">Artifact</th>
                <th className="py-2 pr-3">Gate</th>
                <th className="py-2 pr-3">Warnings</th>
                <th className="py-2 pr-3">Next</th>
              </tr>
            </thead>
            <tbody>
              {topology.slice(0, 40).map((item) => (
                <tr key={item.lease_id} className="border-b border-border/60">
                  <td className="max-w-[220px] truncate py-3 pr-3 text-foreground-secondary">{item.goal_objective || item.goal_id || '-'}</td>
                  <td className="py-3 pr-3">
                    <div className="text-foreground">{item.loop_name}</div>
                    <div className="text-xs text-foreground-tertiary">{item.run_status}</div>
                  </td>
                  <td className="py-3 pr-3">
                    <div className="font-mono text-xs text-foreground">{item.lease_id}</div>
                    <div className="text-xs text-foreground-tertiary">{item.role} / {item.lease_status}</div>
                  </td>
                  <td className="py-3 pr-3 text-foreground-secondary">{item.runtime}</td>
                  <td className="max-w-[220px] truncate py-3 pr-3 text-xs text-foreground-tertiary">{item.stdout_path || item.artifact_path || '-'}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{item.failed_gate || item.latest_gate || '-'}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">{item.warning_count}</td>
                  <td className="py-3 pr-3">
                    <span className="rounded-full border border-border bg-background px-2 py-1 text-xs text-foreground-secondary">
                      {item.bottleneck_reason || item.next_safe_action}
                    </span>
                  </td>
                </tr>
              ))}
              {topology.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-foreground-tertiary">
                    No worker topology yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-4">
        <div className="flex flex-wrap items-center gap-4 text-sm text-foreground-secondary">
          <span className="inline-flex items-center gap-2"><Route className="h-4 w-4" /> backlog {'>'} goals {'>'} loops {'>'} queue {'>'} workers {'>'} checker</span>
          <span className="inline-flex items-center gap-2"><Clock className="h-4 w-4" /> last refresh {new Date().toLocaleTimeString()}</span>
          <span className="inline-flex items-center gap-2"><Square className="h-4 w-4" /> action {action || 'idle'}</span>
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: ReactNode; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-background-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm text-foreground-secondary">{label}</div>
          <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
          <div className="mt-2 text-xs text-foreground-tertiary">{detail}</div>
        </div>
        <div className="text-accent">{icon}</div>
      </div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md bg-background-elevated px-2 py-2">
      <div className="text-[11px] text-foreground-tertiary">{label}</div>
      <div className="mt-1 font-semibold text-foreground">{value}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-tertiary">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
