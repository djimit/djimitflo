import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, BrainCircuit, CheckCircle2, Database, Network, Play, RefreshCw, ServerCog, ShieldCheck, Workflow } from 'lucide-react';
import { api, type AgentAssuranceSummary, type MemoryCandidateRecord, type SchedulerTickResult, type SpecialistPanelRecord, type SpecialistProfile, type SwarmRealityStatus, type WorkItemRecord, type WorkerPoolDrainResult, type WorkerPoolPlanResult, type WorkerPoolStartResult } from '../lib/api';

type ReviewDraft = {
  specialist_id: string;
  stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
  confidence: number;
  finding: string;
  recommendation: string;
  evidence_ref: string;
  limitations: string;
};

export function SwarmResourcesPage() {
  const [status, setStatus] = useState<SwarmRealityStatus | null>(null);
  const [workItems, setWorkItems] = useState<WorkItemRecord[]>([]);
  const [memoryCandidates, setMemoryCandidates] = useState<MemoryCandidateRecord[]>([]);
  const [specialists, setSpecialists] = useState<SpecialistProfile[]>([]);
  const [specialistPanels, setSpecialistPanels] = useState<SpecialistPanelRecord[]>([]);
  const [assuranceSummary, setAssuranceSummary] = useState<AgentAssuranceSummary | null>(null);
  const [panelTopic, setPanelTopic] = useState('Skill and swarm capability review');
  const [panelQuestion, setPanelQuestion] = useState('Which bounded improvement should become backlog before workers are leased?');
  const [panelRisk, setPanelRisk] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [tickResult, setTickResult] = useState<SchedulerTickResult | null>(null);
  const [workerPoolPlan, setWorkerPoolPlan] = useState<WorkerPoolPlanResult | null>(null);
  const [workerPoolResult, setWorkerPoolResult] = useState<WorkerPoolStartResult | WorkerPoolDrainResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [swarmStatus, backlog, memory, catalog, panels, assurance] = await Promise.all([
        api.getSwarmStatus(),
        api.getWorkItems({ limit: 50 }),
        api.getMemoryCandidates(25),
        api.getSpecialistCatalog(),
        api.getSpecialistPanels(25),
        api.getAssuranceSummary(),
      ]);
      setStatus(swarmStatus);
      setWorkItems(backlog.work_items);
      setMemoryCandidates(memory.candidates);
      setSpecialists(catalog.specialists);
      setSpecialistPanels(panels.panels);
      setAssuranceSummary(assurance);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load swarm resources');
    } finally {
      setLoading(false);
    }
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    setActionId(label);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionId(null);
    }
  }

  async function runScheduler() {
    const result = await api.runSchedulerTick({ max_items: 10, plan_triaged: true });
    setTickResult(result);
  }

  async function planWorkerPool() {
    const result = await api.planWorkerPool({ checker_runtime: 'mock' });
    setWorkerPoolPlan(result);
    setWorkerPoolResult(null);
  }

  async function startNextWorker() {
    const result = await api.startNextWorker({ checker_runtime: 'mock', timeout_ms: 120_000, diff_max_lines: 200 });
    setWorkerPoolResult(result);
    setWorkerPoolPlan(result.plan);
  }

  async function drainWorkerPool() {
    const result = await api.drainWorkerPool({ checker_runtime: 'mock', max_workers: 2, timeout_ms: 120_000, diff_max_lines: 200 });
    setWorkerPoolResult(result);
    setWorkerPoolPlan(result.final_plan);
  }

  async function createPanel() {
    await api.createSpecialistPanel({
      topic: panelTopic,
      question: panelQuestion,
      risk_class: panelRisk,
    });
  }

  async function runMemoryEval() {
    await api.runAssuranceEval({
      suite_name: 'memory-quality',
      target_type: 'memory',
      target_ref: 'dashboard',
    });
  }

  function draftFor(panel: SpecialistPanelRecord): ReviewDraft {
    const existing = reviewDrafts[panel.id];
    if (existing) return existing;
    const reviewed = new Set((panel.reviews || []).map((review) => review.specialist_id));
    const nextSpecialist = panel.panel.find((specialist) => !reviewed.has(specialist.id)) || panel.panel[0];
    return {
      specialist_id: nextSpecialist?.id || '',
      stance: 'needs_evidence',
      confidence: 0.7,
      finding: '',
      recommendation: '',
      evidence_ref: '',
      limitations: '',
    };
  }

  function updateDraft(panelId: string, patch: Partial<ReviewDraft>) {
    const panel = specialistPanels.find((candidate) => candidate.id === panelId);
    if (!panel) return;
    setReviewDrafts((current) => ({
      ...current,
      [panelId]: { ...draftFor(panel), ...patch },
    }));
  }

  async function submitReview(panel: SpecialistPanelRecord) {
    const draft = draftFor(panel);
    await api.submitSpecialistReview(panel.id, {
      specialist_id: draft.specialist_id,
      stance: draft.stance,
      confidence: draft.confidence,
      findings: draft.finding ? [draft.finding] : [],
      recommendations: draft.recommendation ? [draft.recommendation] : [],
      evidence_refs: draft.evidence_ref ? [draft.evidence_ref] : [],
      limitations: draft.limitations || undefined,
    });
    setReviewDrafts((current) => {
      const next = { ...current };
      delete next[panel.id];
      return next;
    });
  }

  const availableMemory = useMemo(() => {
    if (!status) return '0 GiB';
    return `${(status.resource_snapshot.free_memory_bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  }, [status]);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Swarm Resources</h1>
          <p className="text-foreground-secondary mt-2">Workstation reality checks for agents, workers, backlog, scheduler, memory and loop throughput.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void runAction('scheduler', runScheduler)}
            disabled={actionId !== null}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            Scheduler Tick
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading || actionId !== null}
            className="p-2 hover:bg-background-elevated rounded-lg transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-5 h-5 text-foreground-secondary ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Metric icon={<Bot className="h-5 w-5" />} label="Registry Agents" value={status?.registry_agent_count ?? 0} />
        <Metric icon={<CheckCircle2 className="h-5 w-5" />} label="Live Agents" value={status?.live_agent_count ?? 0} />
        <Metric icon={<Workflow className="h-5 w-5" />} label="Worker Leases" value={status?.worker_lease_count ?? 0} />
        <Metric icon={<ServerCog className="h-5 w-5" />} label="Active Execution" value={status?.active_execution_count ?? 0} />
      </div>

      <section className="bg-background-secondary border border-border rounded-lg p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Fleet Cockpit</h2>
          <p className="mt-1 text-sm text-foreground-secondary">Runtime pools, queue pressure, recommended concurrency, throughput and blocked capacity reasons.</p>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-3">
          {status?.fleet_pools?.length ? status.fleet_pools.map((pool) => (
            <div key={pool.runtime} className="rounded border border-border bg-background p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-foreground">{pool.runtime}</div>
                <StatusBadge status={pool.available ? 'available' : 'blocked'} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <SmallStat label="Prepared" value={pool.prepared_leases} />
                <SmallStat label="Running" value={pool.running_leases} />
                <SmallStat label="Done 24h" value={pool.completed_24h} />
                <SmallStat label="Failed 24h" value={pool.failed_24h} />
                <SmallStat label="Rec. Conc." value={pool.recommended_concurrency} />
                <SmallStat label="Tokens 24h" value={pool.tokens_used_24h} />
              </div>
              <div className="mt-3 text-xs text-foreground-tertiary">
                Tokens/success: {pool.tokens_per_successful_worker == null ? 'n/a' : pool.tokens_per_successful_worker.toFixed(0)}
              </div>
              <div className="mt-2 text-xs text-foreground-tertiary">
                Queue risk: {Object.entries(pool.queue_depth_by_risk || {}).map(([risk, count]) => `${risk}:${count}`).join(', ') || 'none'}
              </div>
              {pool.blocked_capacity_reasons.length > 0 && (
                <div className="mt-3 rounded border border-status-error/20 bg-status-error/10 p-2 text-xs text-status-error">
                  {pool.blocked_capacity_reasons.join(', ')}
                </div>
              )}
            </div>
          )) : (
            <p className="text-sm text-foreground-secondary">No fleet pool data available.</p>
          )}
        </div>
      </section>

      <section className="bg-background-secondary border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Worker Pool Runner</h2>
            <p className="mt-1 text-sm text-foreground-secondary">Policy-gated plan, start-next and bounded drain for prepared worker leases.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void runAction('worker-plan', planWorkerPool)}
              disabled={actionId !== null}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              <Workflow className="h-4 w-4" />
              Plan
            </button>
            <button
              onClick={() => void runAction('worker-start-next', startNextWorker)}
              disabled={actionId !== null}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Start Next
            </button>
            <button
              onClick={() => void runAction('worker-drain', drainWorkerPool)}
              disabled={actionId !== null}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              <Network className="h-4 w-4" />
              Drain 2
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SmallStat label="Eligible" value={workerPoolPlan?.eligible_count ?? 0} />
          <SmallStat label="Blocked" value={workerPoolPlan?.blocked_count ?? 0} />
          <SmallStat label="Running" value={workerPoolPlan?.running_count ?? 0} />
          <SmallStat label="Max Start" value={workerPoolPlan?.max_workers ?? 0} />
        </div>
        {workerPoolResult && (
          <div className="rounded border border-accent/20 bg-accent/5 p-3 text-sm text-foreground-secondary">
            {'started' in workerPoolResult
              ? `Worker pool drained ${workerPoolResult.started.length} worker(s).`
              : `Worker pool ${workerPoolResult.action}${workerPoolResult.decision ? ` ${workerPoolResult.decision.role}:${workerPoolResult.decision.lease_id.slice(0, 8)}` : ''}.`}
          </div>
        )}
        <div className="space-y-2">
          {workerPoolPlan?.decisions.length ? workerPoolPlan.decisions.slice(0, 8).map((decision) => (
            <div key={decision.lease_id} className="rounded border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">{decision.role} · {decision.effective_runtime}</div>
                <StatusBadge status={decision.eligible ? 'eligible' : 'blocked'} />
              </div>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-foreground-secondary">
                <span className="truncate">Lease: {decision.lease_id.slice(0, 8)}</span>
                <span className="truncate">Risk: {decision.risk_class}</span>
                <span className="truncate">Action: {decision.next_action}</span>
              </div>
              {decision.blocked_reasons.length > 0 && (
                <div className="mt-2 text-xs text-status-warning">
                  {decision.blocked_reasons.join(', ')}
                </div>
              )}
            </div>
          )) : (
            <p className="text-sm text-foreground-secondary">No worker-pool plan loaded.</p>
          )}
        </div>
      </section>

      <section className="bg-background-secondary border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Agent Assurance Harness</h2>
            <p className="mt-1 text-sm text-foreground-secondary">Causal traces, replay checkpoints, deterministic evals, scoped capabilities and governed reflection candidates.</p>
          </div>
          <button
            onClick={() => void runAction('memory-eval', runMemoryEval)}
            disabled={actionId !== null}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            Run Memory Eval
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
          <SmallStat label="Traces" value={assuranceSummary?.trace_count ?? 0} />
          <SmallStat label="Spans" value={assuranceSummary?.trace_span_count ?? 0} />
          <SmallStat label="Checkpoints" value={assuranceSummary?.checkpoint_count ?? 0} />
          <SmallStat label="Eval Runs" value={assuranceSummary?.eval_run_count ?? 0} />
          <SmallStat label="Active Caps" value={assuranceSummary?.active_capability_count ?? 0} />
          <SmallStat label="Pending Caps" value={assuranceSummary?.pending_capability_count ?? 0} />
          <SmallStat label="Reflections" value={assuranceSummary?.reflection_review_required_count ?? 0} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-[0.7fr_1.3fr] gap-3">
          <div className="rounded border border-border bg-background p-3 text-sm text-foreground-secondary">
            Eval guardrails: {assuranceSummary?.guardrails.external_writes_from_evals ?? 0} external writes; replay lease copy is {assuranceSummary?.guardrails.replay_copies_worker_leases ? 'enabled' : 'blocked'}.
          </div>
          <div className="space-y-2">
            {assuranceSummary?.latest_evals.length ? assuranceSummary.latest_evals.map((evalRun) => (
              <div key={evalRun.id} className="rounded border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">{evalRun.suite_name}</div>
                  <StatusBadge status={evalRun.status} />
                </div>
                <div className="mt-1 text-xs text-foreground-tertiary">{evalRun.target_type} · score {(evalRun.score * 100).toFixed(0)}% · {evalRun.created_at}</div>
              </div>
            )) : (
              <p className="text-sm text-foreground-secondary">No assurance evals recorded yet.</p>
            )}
          </div>
        </div>
      </section>

      {status?.reality_check.agent_count_is_registry_only && (
        <div className="rounded-lg border border-status-paused/20 bg-status-paused/10 p-4 text-sm text-status-paused">
          Registry agent count is not equal to live agents. Treat registry rows as inventory, not proof of active swarm execution.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[0.85fr_1.15fr] gap-6">
        <section className="bg-background-secondary border border-border rounded-lg p-5 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Workstation Capacity</h2>
          <div className="grid grid-cols-2 gap-3">
            <SmallStat label="CPU Threads" value={status?.resource_snapshot.cpu_threads ?? 0} />
            <SmallStat label="Free Memory" value={availableMemory} />
            <SmallStat label="Open Work Items" value={status?.task_count.open_work_items ?? 0} />
            <SmallStat label="Open Loops" value={status?.task_count.open_loop_runs ?? 0} />
          </div>
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
              <Network className="h-4 w-4 text-accent" />
              Stale Agents
            </div>
            <div className="space-y-2">
              {status?.stale_agents.length ? status.stale_agents.map((agent) => (
                <div key={agent.id} className="rounded border border-border bg-background p-3 text-sm">
                  <div className="font-medium text-foreground">{agent.name}</div>
                  <div className="text-xs text-foreground-tertiary">{agent.status} · {agent.last_active_at || 'no heartbeat'}</div>
                </div>
              )) : (
                <p className="text-sm text-foreground-secondary">No stale active/idle agents.</p>
              )}
            </div>
          </div>
          {tickResult && (
            <div className="rounded border border-accent/20 bg-accent/5 p-3 text-sm text-foreground-secondary">
              Scheduler inspected {tickResult.inspected_loop_runs} loop run(s), created {tickResult.created_work_items.length} backlog candidate(s), planned {tickResult.planned_work_items.length} work item(s), prepared {tickResult.prepared_work_items.length} work item(s), skipped {tickResult.skipped_existing} duplicate(s), and created {tickResult.leases_created} lease(s).
            </div>
          )}
        </section>

        <section className="bg-background-secondary border border-border rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-lg font-semibold text-foreground">Backlog Work Items</h2>
            <div className="flex items-center gap-2 text-xs text-foreground-tertiary">
              <Database className="h-4 w-4" />
              Djimitflo DB canonical
            </div>
          </div>
          <div className="space-y-3">
            {workItems.length ? workItems.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                busy={actionId !== null}
                onTriage={() => void runAction(`triage-${item.id}`, () => api.updateWorkItem(item.id, { status: 'triaged' }))}
                onGoal={() => void runAction(`goal-${item.id}`, () => api.convertWorkItemToGoal(item.id))}
                onDiscard={() => void runAction(`discard-${item.id}`, () => api.updateWorkItem(item.id, { status: 'discarded' }))}
              />
            )) : (
              <p className="text-sm text-foreground-secondary">No work items yet.</p>
            )}
          </div>
        </section>
      </div>

      <section className="bg-background-secondary border border-border rounded-lg p-5">
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold text-foreground">Memory Candidates</h2>
          <div className="text-xs text-foreground-tertiary">Candidate-only until reviewed or explicitly approved</div>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {memoryCandidates.length ? memoryCandidates.map((candidate) => (
            <div key={candidate.id} className="rounded border border-border bg-background p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">{candidate.title}</div>
                  <div className="mt-1 text-xs text-foreground-secondary line-clamp-2">{candidate.content}</div>
                </div>
                <StatusBadge status={candidate.status} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-foreground-tertiary">
                <span>{candidate.memory_type}</span>
                <span>{candidate.promotion_status}</span>
                <span>{candidate.sensitivity}</span>
                {candidate.human_required && <span>human required</span>}
              </div>
              {candidate.promotion_status === 'proposed' && (
                <div className="mt-3">
                  <button
                    onClick={() => void runAction(`promote-memory-${candidate.id}`, () => api.promoteMemoryCandidate(candidate.id))}
                    disabled={actionId !== null}
                    className="px-2 py-1 rounded border border-status-completed/20 text-xs text-status-completed hover:bg-status-completed/10 disabled:opacity-50"
                  >
                    Promote to OKF
                  </button>
                </div>
              )}
            </div>
          )) : (
            <p className="text-sm text-foreground-secondary">No memory candidates yet.</p>
          )}
        </div>
      </section>

      <section className="bg-background-secondary border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Specialist Swarm Panels</h2>
            <p className="mt-1 text-sm text-foreground-secondary">Independent expert reviews with preserved dissent; panels project to backlog before workers are leased.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-foreground-tertiary">
            <BrainCircuit className="h-4 w-4" />
            {specialists.length} specialist profiles
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-foreground-tertiary">Topic</span>
              <input
                value={panelTopic}
                onChange={(event) => setPanelTopic(event.target.value)}
                className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            </label>
            <label className="block">
              <span className="text-xs text-foreground-tertiary">Question</span>
              <input
                value={panelQuestion}
                onChange={(event) => setPanelQuestion(event.target.value)}
                className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            </label>
          </div>
          <div className="flex items-end gap-2">
            <select
              value={panelRisk}
              onChange={(event) => setPanelRisk(event.target.value as typeof panelRisk)}
              className="rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
            <button
              onClick={() => void runAction('create-panel', createPanel)}
              disabled={actionId !== null || !panelTopic.trim() || !panelQuestion.trim()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              <BrainCircuit className="h-4 w-4" />
              Create Panel
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
          {specialistPanels.length ? specialistPanels.map((panel) => (
            <SpecialistPanelCard
              key={panel.id}
              panel={panel}
              draft={draftFor(panel)}
              busy={actionId !== null}
              onDraft={(patch) => updateDraft(panel.id, patch)}
              onSubmitReview={() => void runAction(`review-panel-${panel.id}`, () => submitReview(panel))}
              onBacklog={() => void runAction(`backlog-panel-${panel.id}`, () => api.projectSpecialistPanelToBacklog(panel.id))}
            />
          )) : (
            <p className="text-sm text-foreground-secondary">No specialist panels yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background-secondary p-4">
      <div className="flex items-center gap-2 text-sm text-foreground-secondary">{icon}<span>{label}</span></div>
      <div className="mt-2 text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="text-xs text-foreground-tertiary">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function WorkItemRow({
  item,
  busy,
  onTriage,
  onGoal,
  onDiscard,
}: {
  item: WorkItemRecord;
  busy: boolean;
  onTriage: () => void;
  onGoal: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="rounded border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{item.title}</div>
          <div className="mt-1 text-xs text-foreground-secondary line-clamp-2">{item.description}</div>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-foreground-tertiary">
        <span>{item.risk_class} risk</span>
        <span>value {item.value_score}</span>
        <span>confidence {(item.confidence * 100).toFixed(0)}%</span>
        {item.recommended_loop && <span>{item.recommended_loop}</span>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={onTriage} disabled={busy || item.status !== 'candidate'} className="px-2 py-1 rounded border border-accent/20 text-xs text-accent hover:bg-accent/10 disabled:opacity-50">Triage</button>
        <button onClick={onGoal} disabled={busy || item.status === 'discarded' || item.status === 'done'} className="px-2 py-1 rounded border border-status-completed/20 text-xs text-status-completed hover:bg-status-completed/10 disabled:opacity-50">Goal</button>
        <button onClick={onDiscard} disabled={busy || item.status === 'discarded'} className="px-2 py-1 rounded border border-status-error/20 text-xs text-status-error hover:bg-status-error/10 disabled:opacity-50">Discard</button>
      </div>
    </div>
  );
}

function SpecialistPanelCard({
  panel,
  draft,
  busy,
  onDraft,
  onSubmitReview,
  onBacklog,
}: {
  panel: SpecialistPanelRecord;
  draft: ReviewDraft;
  busy: boolean;
  onDraft: (patch: Partial<ReviewDraft>) => void;
  onSubmitReview: () => void;
  onBacklog: () => void;
}) {
  const reviewed = new Set((panel.reviews || []).map((review) => review.specialist_id));
  const canReview = !['backlog_created', 'goal_created', 'cancelled'].includes(panel.status);
  const canBacklog = panel.status === 'consensus_ready' && panel.consensus.decision !== 'blocked';

  return (
    <div className="rounded border border-border bg-background p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{panel.topic}</div>
          <div className="mt-1 text-xs text-foreground-secondary line-clamp-2">{panel.question}</div>
        </div>
        <StatusBadge status={panel.status} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SmallStat label="Risk" value={panel.risk_class} />
        <SmallStat label="Reviews" value={`${panel.consensus.submitted_reviews}/${panel.consensus.required_reviews}`} />
        <SmallStat label="Consensus" value={panel.consensus.consensus_level} />
        <SmallStat label="Decision" value={panel.consensus.decision} />
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-foreground-tertiary">
        {panel.panel.map((specialist) => (
          <span key={specialist.id} className={`rounded border px-2 py-1 ${reviewed.has(specialist.id) ? 'border-status-completed/20 text-status-completed' : 'border-border'}`}>
            {specialist.title}
          </span>
        ))}
      </div>

      {panel.consensus.dissent.length > 0 && (
        <div className="rounded border border-status-paused/20 bg-status-paused/10 p-3 text-xs text-status-paused">
          Dissent: {panel.consensus.dissent.map((item) => `${item.specialist_title} ${item.stance}`).join(', ')}
        </div>
      )}

      {canReview && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <select
            value={draft.specialist_id}
            onChange={(event) => onDraft({ specialist_id: event.target.value })}
            className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
          >
            {panel.panel.map((specialist) => (
              <option key={specialist.id} value={specialist.id}>{specialist.title}</option>
            ))}
          </select>
          <div className="grid grid-cols-[1fr_96px] gap-2">
            <select
              value={draft.stance}
              onChange={(event) => onDraft({ stance: event.target.value as ReviewDraft['stance'] })}
              className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
            >
              <option value="support">support</option>
              <option value="oppose">oppose</option>
              <option value="uncertain">uncertain</option>
              <option value="needs_evidence">needs_evidence</option>
            </select>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={draft.confidence}
              onChange={(event) => onDraft({ confidence: Number(event.target.value) })}
              className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
            />
          </div>
          <input
            value={draft.finding}
            onChange={(event) => onDraft({ finding: event.target.value })}
            placeholder="Finding"
            className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
          />
          <input
            value={draft.recommendation}
            onChange={(event) => onDraft({ recommendation: event.target.value })}
            placeholder="Recommendation"
            className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
          />
          <input
            value={draft.evidence_ref}
            onChange={(event) => onDraft({ evidence_ref: event.target.value })}
            placeholder="Evidence reference"
            className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
          />
          <input
            value={draft.limitations}
            onChange={(event) => onDraft({ limitations: event.target.value })}
            placeholder="Limitations"
            className="rounded border border-border bg-background-secondary px-3 py-2 text-sm text-foreground"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {canReview && (
          <button
            onClick={onSubmitReview}
            disabled={busy || !draft.specialist_id || !draft.finding.trim()}
            className="px-2 py-1 rounded border border-accent/20 text-xs text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            Submit Review
          </button>
        )}
        <button
          onClick={onBacklog}
          disabled={busy || !canBacklog}
          className="px-2 py-1 rounded border border-status-completed/20 text-xs text-status-completed hover:bg-status-completed/10 disabled:opacity-50"
        >
          Project Backlog
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'done'
    ? 'bg-status-completed/10 text-status-completed border-status-completed/20'
    : status === 'blocked'
      ? 'bg-status-error/10 text-status-error border-status-error/20'
      : status === 'discarded'
        ? 'bg-foreground-muted/10 text-foreground-muted border-foreground-muted/20'
        : 'bg-status-paused/10 text-status-paused border-status-paused/20';
  return <span className={`px-2 py-0.5 text-xs rounded border ${tone}`}>{status}</span>;
}
