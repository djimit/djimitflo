import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, Database, Gauge, GitBranch, Network, PlayCircle, RefreshCw, RotateCcw, Route, ShieldCheck, Workflow } from 'lucide-react';
import { api, type CapacityPlanV2Result, type ClaimLedgerRecord, type GoalBatchPreviewResult, type KnowledgeRuntimeHealth, type KnowledgeSyncResult, type ProofRunSummary, type SwarmCapabilityRecord, type SwarmMissionControl, type WorkerPoolPlanResult } from '../lib/api';

const FLYWHEEL_BATCH_PATH = 'openspec/changes/prove-learning-flywheel-operator-loop/goals.batch.json';

export function knowledgeRuntimePanelModel(knowledge: KnowledgeRuntimeHealth | null) {
  return {
    canonical: knowledge?.okf_base || knowledge?.canonical_candidate || 'unknown',
    usesPackagesKnowledge: Boolean(knowledge?.drift.packages_knowledge_is_canonical),
    status: knowledge?.valid ? 'valid' : knowledge?.validate_okf.status || 'unknown',
  };
}

export function SwarmMissionControlPage() {
  const [mission, setMission] = useState<SwarmMissionControl | null>(null);
  const [capabilities, setCapabilities] = useState<SwarmCapabilityRecord[]>([]);
  const [claims, setClaims] = useState<ClaimLedgerRecord[]>([]);
  const [capacity, setCapacity] = useState<CapacityPlanV2Result | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeRuntimeHealth | null>(null);
  const [knowledgeSync, setKnowledgeSync] = useState<KnowledgeSyncResult | null>(null);
  const [goalBatch, setGoalBatch] = useState<GoalBatchPreviewResult | null>(null);
  const [lowCapacityPlan, setLowCapacityPlan] = useState<WorkerPoolPlanResult | null>(null);
  const [learningClosure, setLearningClosure] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proofRuntime, setProofRuntime] = useState<'mock' | 'codex' | 'opencode'>('mock');
  const [expandedCapability, setExpandedCapability] = useState<string | null>(null);
  const [learningCurve, setLearningCurve] = useState<any>(null);

  // D12: Knowledge bus events
  const [knowledgeEvents, setKnowledgeEvents] = useState<any[]>([]);
  useEffect(() => {
    api.request('/knowledge/events?limit=20').then((res: any) => setKnowledgeEvents(res.events || [])).catch(() => {});
  }, []);

  // D11: Learning curve
  useEffect(() => {
    api.request('/swarms/learning-curve').then(setLearningCurve).catch(() => {});
  }, []);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [missionControl, capabilityList, claimList, knowledgeRuntime] = await Promise.all([
        api.getSwarmMissionControl(),
        api.getSwarmCapabilities(50),
        api.getSwarmClaims(50),
        api.getKnowledgeRuntime(),
      ]);
      setMission(missionControl);
      setCapacity(missionControl.capacity);
      setCapabilities(capabilityList.capabilities);
      setClaims(claimList.claims);
      setKnowledge(knowledgeRuntime);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load swarm mission control');
    } finally {
      setLoading(false);
    }
  }

  async function runCapacityPlan() {
    setActionId('capacity-plan');
    setError(null);
    try {
      setCapacity(await api.planCapacityV2({ checker_runtime: 'mock' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Capacity plan failed');
    } finally {
      setActionId(null);
    }
  }

  async function runProofRun() {
    setActionId('proof-run');
    setError(null);
    try {
      await api.createProofRun(proofRuntime);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Proof run failed');
    } finally {
      setActionId(null);
    }
  }

  async function runKnowledgeSync(apply: boolean) {
    setActionId(apply ? 'knowledge-sync-apply' : 'knowledge-sync-preview');
    setError(null);
    try {
      setKnowledgeSync(await api.syncKnowledgeRuntime(apply ? { apply: true } : { dry_run: true }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Knowledge sync failed');
    } finally {
      setActionId(null);
    }
  }

  async function previewGoalBatch() {
    setActionId('goal-batch-preview');
    setError(null);
    try {
      setGoalBatch(await api.previewGoalBatch({ path: FLYWHEEL_BATCH_PATH }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goal batch preview failed');
    } finally {
      setActionId(null);
    }
  }

  async function applyGoalBatch() {
    setActionId('goal-batch-apply');
    setError(null);
    try {
      const applied = await api.applyGoalBatch({ path: FLYWHEEL_BATCH_PATH });
      setGoalBatch(applied.preview);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goal batch apply failed');
    } finally {
      setActionId(null);
    }
  }

  async function runLowCapacityPlan() {
    setActionId('low-capacity-plan');
    setError(null);
    try {
      setLowCapacityPlan(await api.planWorkerPool({ runtime: 'mock', checker_runtime: 'mock', simulate_low_capacity: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Low capacity plan failed');
    } finally {
      setActionId(null);
    }
  }

  async function closeLearningLoop() {
    const loopRunId = window.prompt('Loop run id to close');
    if (!loopRunId) return;
    setActionId('learning-close');
    setError(null);
    try {
      setLearningClosure(await api.closeLoopLearning({ loop_run_id: loopRunId, promote_memory: false }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Learning closure failed');
    } finally {
      setActionId(null);
    }
  }

  async function rollbackProofRun(id: string) {
    setActionId(`rollback-${id}`);
    setError(null);
    try {
      await api.rollbackProofRun(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Proof run rollback failed');
    } finally {
      setActionId(null);
    }
  }

  const blockedCapabilities = useMemo(() => capabilities.filter((capability) => !capability.live_route_allowed), [capabilities]);
  const importantClaims = useMemo(() => claims.filter((claim) => ['contradicted', 'review_required', 'proposed'].includes(claim.status)).slice(0, 8), [claims]);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Swarm Mission Control</h1>
          <p className="mt-2 max-w-3xl text-foreground-secondary">
            Evidence-first control surface for skills, specialist councils, claim ledger, capacity governor and runner governance.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void runProofRun()}
            disabled={actionId !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-status-success/30 px-3 py-2 text-sm text-status-success hover:bg-status-success/10 disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            Run Proof
          </button>
          <button
            onClick={() => void runCapacityPlan()}
            disabled={actionId !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-accent/30 px-3 py-2 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            <Route className="h-4 w-4" />
            Plan Capacity
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading || actionId !== null}
            className="rounded-lg p-2 transition-colors hover:bg-background-elevated disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`h-5 w-5 text-foreground-secondary ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Metric icon={<Network className="h-5 w-5" />} label="Registry" value={mission?.swarm_truth.registry_agent_count ?? 0} />
        <Metric icon={<CheckCircle2 className="h-5 w-5" />} label="Live Agents" value={mission?.swarm_truth.live_agent_count ?? 0} />
        <Metric icon={<Workflow className="h-5 w-5" />} label="Prepared" value={mission?.swarm_truth.prepared_leases ?? 0} />
        <Metric icon={<Gauge className="h-5 w-5" />} label="Running" value={mission?.swarm_truth.running_leases ?? 0} />
        <Metric icon={<BrainCircuit className="h-5 w-5" />} label="Active Exec" value={mission?.swarm_truth.active_execution_count ?? 0} />
      </div>

      <ProofRunPanel
        proofRun={mission?.latest_proof_run || null}
        actionId={actionId}
        runtime={proofRuntime}
        onRuntimeChange={setProofRuntime}
        onRun={() => void runProofRun()}
        onRollback={(id) => void rollbackProofRun(id)}
      />

      <KnowledgeRuntimePanel
        knowledge={knowledge}
        actionId={actionId}
        knowledgeSync={knowledgeSync}
        goalBatch={goalBatch}
        lowCapacityPlan={lowCapacityPlan}
        learningClosure={learningClosure}
        onRefresh={() => void refresh()}
        onPreviewSync={() => void runKnowledgeSync(false)}
        onApplySync={() => void runKnowledgeSync(true)}
        onPreviewGoalBatch={() => void previewGoalBatch()}
        onApplyGoalBatch={() => void applyGoalBatch()}
        onLowCapacityPlan={() => void runLowCapacityPlan()}
        onCloseLearningLoop={() => void closeLearningLoop()}
      />

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Execution Truth</h2>
            <p className="mt-1 text-sm text-foreground-secondary">
              {mission?.execution_node.cockpit || 'MacBook dashboard'} observes; {mission?.execution_node.workers_run_on || 'workstation'} executes. Active execution requires runtime evidence.
            </p>
          </div>
          <StatusBadge status={mission?.swarm_truth.registry_is_not_execution ? 'truth-gated' : 'unknown'} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          <HealthStrip label="Capability Health" values={[
            `total ${mission?.capability_health.total ?? 0}`,
            `validated ${mission?.capability_health.validated ?? 0}`,
            `routable ${mission?.capability_health.routable ?? 0}`,
            `blocked ${mission?.capability_health.blocked ?? 0}`,
          ]} />
          <HealthStrip label="Claim Health" values={[
            `total ${mission?.claim_health.total ?? 0}`,
            `supported ${mission?.claim_health.supported ?? 0}`,
            `proposed ${mission?.claim_health.proposed ?? 0}`,
            `contradicted ${mission?.claim_health.contradicted ?? 0}`,
          ]} />
          <HealthStrip label="Specialist Panels" values={[
            `total ${mission?.specialist_panels.total ?? 0}`,
            `ready ${mission?.specialist_panels.consensus_ready ?? 0}`,
            `blocked/evidence ${mission?.specialist_panels.blocked_or_needs_evidence ?? 0}`,
          ]} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Capacity Governor v2</h2>
          <p className="mt-1 text-sm text-foreground-secondary">Queue classes, fair-share order, policy reasons and audit manifest previews before execution.</p>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="rounded border border-border bg-background p-4">
            <div className="text-sm font-semibold text-foreground">Queue Classes</div>
            <div className="mt-3 space-y-2">
              {Object.entries(capacity?.queue_classes || {}).map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span className="text-foreground-secondary">{name}</span>
                  <span className="font-mono text-foreground">{count}</span>
                </div>
              ))}
              {!Object.keys(capacity?.queue_classes || {}).length && <p className="text-sm text-foreground-tertiary">No queued leases.</p>}
            </div>
          </div>
          <div className="rounded border border-border bg-background p-4">
            <div className="text-sm font-semibold text-foreground">Fair-Share Order</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(capacity?.fair_share_order || []).map((item) => <span key={item} className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary">{item}</span>)}
              {!capacity?.fair_share_order?.length && <p className="text-sm text-foreground-tertiary">No fair-share plan.</p>}
            </div>
          </div>
          <div className="rounded border border-border bg-background p-4">
            <div className="text-sm font-semibold text-foreground">Runner Decisions</div>
            <div className="mt-3 space-y-2">
              <SmallStat label="Eligible" value={capacity?.eligible_count ?? 0} />
              <SmallStat label="Blocked" value={capacity?.blocked_count ?? 0} />
              <SmallStat label="Running" value={capacity?.running_count ?? 0} />
            </div>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-foreground-tertiary">
              <tr>
                <th className="py-2 pr-4">Decision</th>
                <th className="py-2 pr-4">Lease</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Queue</th>
                <th className="py-2 pr-4">Blocked Reasons</th>
              </tr>
            </thead>
            <tbody>
              {(capacity?.audit_manifest_preview || []).slice(0, 8).map((item) => (
                <tr key={item.decision_id} className="border-t border-border">
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{item.decision_id}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{item.lease_id}</td>
                  <td className="py-2 pr-4"><StatusBadge status={item.action} /></td>
                  <td className="py-2 pr-4 text-foreground-secondary">{item.queue_class}</td>
                  <td className="py-2 pr-4 text-foreground-tertiary">{item.blocked_reasons.join(', ') || 'none'}</td>
                </tr>
              ))}
              {!capacity?.audit_manifest_preview?.length && (
                <tr><td className="py-3 text-foreground-tertiary" colSpan={5}>No runner decisions to preview.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="rounded-lg border border-border bg-background-secondary p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Capability Registry</h2>
          </div>
          <div className="mt-4 space-y-3">
            {(blockedCapabilities.length ? blockedCapabilities : capabilities).slice(0, 8).map((capability) => (
              <div key={capability.id} className="rounded border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpandedCapability(expandedCapability === capability.id ? null : capability.id)}
                    className="flex flex-col items-start text-left"
                  >
                    <div className="text-sm font-semibold text-foreground">{capability.id}</div>
                    <div className="text-xs text-foreground-tertiary">{capability.kind} · {capability.owner} · v{capability.version}</div>
                  </button>
                  <StatusBadge status={capability.live_route_allowed ? 'routable' : capability.status} />
                </div>
                <div className="mt-2 text-xs text-foreground-secondary">
                  Eval {capability.eval_score.toFixed(2)} / {capability.eval_threshold.toFixed(2)} · risk {capability.risk_ceiling}
                </div>
                {capability.blocked_reasons.length > 0 && (
                  <div className="mt-2 text-xs text-status-warning">{capability.blocked_reasons.join(', ')}</div>
                )}
                <ExpandToggle
                  open={expandedCapability === capability.id}
                  onToggle={() => setExpandedCapability(expandedCapability === capability.id ? null : capability.id)}
                />
                {expandedCapability === capability.id && (
                  <div className="mt-2 space-y-1.5 border-t border-border pt-2 text-xs text-foreground-secondary">
                    <FieldList label="Allowed actions" values={capability.allowed_actions} />
                    <FieldList label="Forbidden actions" values={capability.forbidden_actions} />
                    <FieldList label="Required evidence" values={capability.required_evidence} />
                    <div><span className="text-foreground-tertiary">Input schema:</span> {capability.input_schema_ref || 'none'}</div>
                    <div><span className="text-foreground-tertiary">Output schema:</span> {capability.output_schema_ref || 'none'}</div>
                    <div><span className="text-foreground-tertiary">Cost model:</span> <code className="text-foreground">{JSON.stringify(capability.cost_model)}</code></div>
                    <div><span className="text-foreground-tertiary">Latest validation:</span> {capability.latest_validation_report || 'none'}</div>
                    <div><span className="text-foreground-tertiary">Removal strategy:</span> {capability.removal_strategy}</div>
                  </div>
                )}
              </div>
            ))}
            {!capabilities.length && <p className="text-sm text-foreground-tertiary">No capabilities registered.</p>}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-background-secondary p-5">
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Claim Ledger</h2>
          </div>
          <div className="mt-4 space-y-3">
            {(importantClaims.length ? importantClaims : claims.slice(0, 8)).map((claim) => (
              <div key={claim.id} className="rounded border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setExpandedClaim(expandedClaim === claim.id ? null : claim.id)}
                    className="text-left"
                  >
                    <div className="text-sm font-semibold text-foreground">{claim.subject_ref}</div>
                    <div className="text-xs text-foreground-tertiary">{claim.claim_type} · {claim.created_from}</div>
                  </button>
                  <StatusBadge status={claim.status} />
                </div>
                <p className="mt-2 text-sm text-foreground-secondary">{claim.claim}</p>
                <div className="mt-2 text-xs text-foreground-tertiary">
                  Evidence {claim.evidence_refs.length} · confidence {claim.confidence.toFixed(2)} · from {claim.created_from}
                </div>
                <ExpandToggle
                  open={expandedClaim === claim.id}
                  onToggle={() => setExpandedClaim(expandedClaim === claim.id ? null : claim.id)}
                />
                {expandedClaim === claim.id && (
                  <div className="mt-2 space-y-1.5 border-t border-border pt-2 text-xs text-foreground-secondary">
                    <FieldList label="Evidence refs" values={claim.evidence_refs} />
                    <div><span className="text-foreground-tertiary">Claim type:</span> {claim.claim_type}</div>
                    <div><span className="text-foreground-tertiary">Verified by gate:</span> {claim.verified_by_gate || 'none'}</div>
                    <div><span className="text-foreground-tertiary">Invalidated by:</span> {claim.invalidated_by || 'none'}</div>
                    {claim.metadata && Object.keys(claim.metadata).length > 0 && (
                      <div><span className="text-foreground-tertiary">Metadata:</span> <code className="text-foreground">{JSON.stringify(claim.metadata)}</code></div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {!claims.length && <p className="text-sm text-foreground-tertiary">No claims recorded.</p>}
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <h2 className="text-lg font-semibold text-foreground">Next Safe Actions</h2>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
          {(mission?.next_safe_actions || []).map((action) => (
            <div key={action} className="rounded border border-border bg-background p-3 text-sm text-foreground-secondary">{action}</div>
          ))}
          {!mission?.next_safe_actions?.length && <p className="text-sm text-foreground-tertiary">No action guidance available.</p>}
        </div>
      </section>
    </div>
  );
}

function KnowledgeRuntimePanel({
  knowledge,
  actionId,
  knowledgeSync,
  goalBatch,
  lowCapacityPlan,
  learningClosure,
  onRefresh,
  onPreviewSync,
  onApplySync,
  onPreviewGoalBatch,
  onApplyGoalBatch,
  onLowCapacityPlan,
  onCloseLearningLoop,
}: {
  knowledge: KnowledgeRuntimeHealth | null;
  actionId: string | null;
  knowledgeSync: KnowledgeSyncResult | null;
  goalBatch: GoalBatchPreviewResult | null;
  lowCapacityPlan: WorkerPoolPlanResult | null;
  learningClosure: Record<string, unknown> | null;
  onRefresh: () => void;
  onPreviewSync: () => void;
  onApplySync: () => void;
  onPreviewGoalBatch: () => void;
  onApplyGoalBatch: () => void;
  onLowCapacityPlan: () => void;
  onCloseLearningLoop: () => void;
}) {
  const { canonical, status, usesPackagesKnowledge } = knowledgeRuntimePanelModel(knowledge);
  return (
    <section className="rounded-lg border border-border bg-background-secondary p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Knowledge Runtime</h2>
            <StatusBadge status={status} />
          </div>
          <p className="mt-1 max-w-4xl text-sm text-foreground-secondary">
            Canonical OKF: <span className="font-mono text-foreground">{canonical}</span>
            {knowledge?.symlink_target ? <span>{' -> '}{knowledge.symlink_target}</span> : null}
          </p>
        </div>
        <StatusBadge status={usesPackagesKnowledge ? 'misconfigured' : 'canonical'} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {['skills', 'agents', 'memory', 'services', 'repos', 'models', 'total'].map((key) => (
          <div key={key} className="rounded border border-border bg-background p-3">
            <div className="font-mono text-lg font-semibold text-foreground">{knowledge?.counts[key] ?? 0}</div>
            <div className="mt-1 text-xs text-foreground-tertiary">{key}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <HealthStrip label="Capability Sync Drift" values={[
          `okf skills ${knowledge?.drift.okf_skill_count ?? 0}`,
          `registered ${knowledge?.drift.registered_skill_capability_count ?? 0}`,
          `missing ${knowledge?.drift.missing_registry_entries.length ?? 0}`,
          `stale ${knowledge?.drift.stale_registry_entries.length ?? 0}`,
        ]} />
        <HealthStrip label="Validation" values={[
          `status ${knowledge?.validate_okf.status || 'unknown'}`,
          `projection ${knowledge?.drift.projection_status || 'unknown'}`,
          `blocked ${knowledge?.blocked_reasons.length ?? 0}`,
        ]} />
        <HealthStrip label="Next Safe Actions" values={(knowledge?.next_safe_actions || ['Load knowledge runtime']).slice(0, 4)} />
      </div>
      {knowledge?.blocked_reasons.length ? (
        <div className="mt-3 rounded border border-status-warning/20 bg-status-warning/10 p-3 text-sm text-status-warning">
          {knowledge.blocked_reasons.join(', ')}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
        <button onClick={onRefresh} disabled={actionId !== null} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-background-elevated disabled:opacity-50">
          <RefreshCw className="h-4 w-4" /> Validate OKF
        </button>
        <button onClick={onPreviewSync} disabled={actionId !== null} className="inline-flex items-center gap-2 rounded-lg border border-accent/30 px-3 py-2 text-sm text-accent hover:bg-accent/10 disabled:opacity-50">
          <Route className="h-4 w-4" /> Sync Preview
        </button>
        <button onClick={onApplySync} disabled={actionId !== null || knowledge?.validate_okf.status === 'fail'} className="inline-flex items-center gap-2 rounded-lg border border-status-success/30 px-3 py-2 text-sm text-status-success hover:bg-status-success/10 disabled:opacity-50">
          <CheckCircle2 className="h-4 w-4" /> Apply Sync
        </button>
        <button onClick={onPreviewGoalBatch} disabled={actionId !== null} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-background-elevated disabled:opacity-50">
          <Workflow className="h-4 w-4" /> Batch Preview
        </button>
        <button onClick={onApplyGoalBatch} disabled={actionId !== null || Boolean(goalBatch?.blocked)} className="inline-flex items-center gap-2 rounded-lg border border-status-success/30 px-3 py-2 text-sm text-status-success hover:bg-status-success/10 disabled:opacity-50">
          <PlayCircle className="h-4 w-4" /> Import Goals
        </button>
        <button onClick={onLowCapacityPlan} disabled={actionId !== null} className="inline-flex items-center gap-2 rounded-lg border border-status-warning/30 px-3 py-2 text-sm text-status-warning hover:bg-status-warning/10 disabled:opacity-50">
          <Gauge className="h-4 w-4" /> Low Capacity
        </button>
        <button onClick={onCloseLearningLoop} disabled={actionId !== null} className="inline-flex items-center gap-2 rounded-lg border border-accent/30 px-3 py-2 text-sm text-accent hover:bg-accent/10 disabled:opacity-50">
          <BrainCircuit className="h-4 w-4" /> Close Learning
        </button>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-4">
        {knowledgeSync && <HealthStrip label="Last Sync" values={[
          knowledgeSync.dry_run ? 'dry-run' : 'applied',
          `created ${knowledgeSync.created}`,
          `updated ${knowledgeSync.updated}`,
          `blocked ${knowledgeSync.blocked}`,
        ]} />}
        {goalBatch && <HealthStrip label="Goal Batch" values={[
          `change ${goalBatch.change || 'unknown'}`,
          `goals ${goalBatch.total}`,
          `valid ${goalBatch.valid}`,
          `writes ${goalBatch.writes}`,
        ]} />}
        {lowCapacityPlan && <HealthStrip label="Low Capacity Proof" values={[
          `eligible ${lowCapacityPlan.eligible_count}`,
          `blocked ${lowCapacityPlan.blocked_count}`,
          `running ${lowCapacityPlan.running_count}`,
          lowCapacityPlan.decisions[0]?.blocked_reasons[0] || 'no lease',
        ]} />}
        {learningClosure && <HealthStrip label="Learning Closure" values={[
          `status ${String(learningClosure.status || 'unknown')}`,
          `delta ${String(learningClosure.score_delta ?? 'baseline')}`,
          `eval ${String((learningClosure.eval_run as any)?.id || 'none')}`,
        ]} />}
      </div>
    </section>
  );
}

function ProofRunPanel({
  proofRun,
  actionId,
  runtime,
  onRuntimeChange,
  onRun,
  onRollback,
}: {
  proofRun: ProofRunSummary | null;
  actionId: string | null;
  runtime: 'mock' | 'codex' | 'opencode';
  onRuntimeChange: (runtime: 'mock' | 'codex' | 'opencode') => void;
  onRun: () => void;
  onRollback: (id: string) => void;
}) {
  const requiredCounts = ['capabilities', 'panels', 'reviews', 'claims', 'goals', 'loop_runs', 'worker_leases', 'trace_spans', 'checkpoints', 'manifests', 'memory_candidates', 'work_items'];
  return (
    <section className="rounded-lg border border-border bg-background-secondary p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-status-success" />
            <h2 className="text-lg font-semibold text-foreground">Production Swarm Proof</h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-foreground-secondary">
            One closed-loop run writes real persisted evidence across capabilities, specialist review, claims, goals, leases, traces, checkpoints, manifests, backlog and memory.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={runtime}
            onChange={(event) => onRuntimeChange(event.target.value as 'mock' | 'codex' | 'opencode')}
            className="rounded-lg border border-border bg-background px-2 py-2 text-sm text-foreground"
          >
            <option value="mock">mock</option>
            <option value="codex">codex</option>
            <option value="opencode">opencode</option>
          </select>
          <button
            onClick={onRun}
            disabled={actionId !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-status-success/30 px-3 py-2 text-sm text-status-success hover:bg-status-success/10 disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            Run Proof
          </button>
          {proofRun && (
            <button
              onClick={() => onRollback(proofRun.id)}
              disabled={actionId !== null || !proofRun.rollback_safe}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-background-elevated disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              Rollback
            </button>
          )}
        </div>
      </div>
      {proofRun ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusBadge status={proofRun.passed ? 'passed' : proofRun.status} />
            <StatusBadge status={proofRun.production_passed ? 'production' : proofRun.proof_class} />
            <Link to={`/swarm-mission-control/proof-runs/${proofRun.id}`} className="font-mono text-xs text-accent hover:underline">{proofRun.id}</Link>
            <span className="text-xs text-foreground-tertiary">{proofRun.completed_at || proofRun.created_at}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {requiredCounts.map((key) => (
              <div key={key} className="rounded border border-border bg-background p-3">
                <div className="font-mono text-lg font-semibold text-foreground">{proofRun.counts[key] ?? 0}</div>
                <div className="mt-1 text-xs text-foreground-tertiary">{key}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <HealthStrip label="Primary Artifacts" values={[
              `goal ${proofRun.artifact_refs.goal || 'none'}`,
              `loop ${proofRun.artifact_refs.loop_run || 'none'}`,
              `workers ${proofRun.artifact_refs.worker_leases.length}`,
            ]} />
            <HealthStrip label="Review And Memory" values={[
              `panel ${proofRun.artifact_refs.panel || 'none'}`,
              `memory ${proofRun.artifact_refs.memory_candidate || 'none'}`,
              `missing ${Object.keys(proofRun.missing).length}`,
            ]} />
            <HealthStrip label="Runtime" values={[
              `runtime ${proofRun.runtime}`,
              proofRun.rollback_safe ? 'rollback safe' : 'rollback blocked',
              proofRun.passed ? 'minimums passed' : 'minimums missing',
            ]} />
          </div>
          <NarrativeTimeline
            narrative={proofRun.narrative}
            status={proofRun.status}
            passed={proofRun.passed}
            rollbackSafe={proofRun.rollback_safe}
            rollingBack={actionId === `rollback-${proofRun.id}`}
            onRollback={() => onRollback(proofRun.id)}
          />
        </>
      ) : (
        <div className="mt-4 rounded border border-border bg-background p-4 text-sm text-foreground-secondary">
          <p>No proof run yet. Run one to create visible evidence across the swarm control plane.</p>
          <button
            onClick={onRun}
            disabled={actionId !== null}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-status-success/30 px-3 py-2 text-sm text-status-success hover:bg-status-success/10 disabled:opacity-50"
          >
            <PlayCircle className="h-4 w-4" />
            {actionId === 'proof-run' ? 'Seeding…' : 'Seed demo proof run'}
          </button>
        </div>
      )}
    </section>
  );
}

function NarrativeTimeline({
  narrative,
  status,
  passed,
  rollbackSafe,
  rollingBack,
  onRollback,
}: {
  narrative: string[];
  status: ProofRunSummary['status'];
  passed: boolean;
  rollbackSafe: boolean;
  rollingBack: boolean;
  onRollback: () => void;
}) {
  const rolledBack = status === 'rolled_back';
  const steps = narrative.length ? narrative : ['No narrative captured for this run.'];
  const verdict = rolledBack ? 'rolled back' : passed ? 'passed' : 'incomplete';
  const verdictTone = rolledBack
    ? 'border-status-warning/30 bg-status-warning/10 text-status-warning'
    : passed
      ? 'border-status-success/30 bg-status-success/10 text-status-success'
      : 'border-border bg-background-elevated text-foreground-secondary';
  return (
    <div className="mt-4 rounded border border-border bg-background p-4">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-foreground-secondary" />
        <h3 className="text-sm font-semibold text-foreground">Run Narrative</h3>
        <span className={`rounded border px-2 py-0.5 text-xs font-medium ${verdictTone}`}>{verdict}</span>
      </div>
      <ol className="mt-3 space-y-3">
        {steps.map((line, index) => (
          <li key={index} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background-elevated font-mono text-[10px] text-foreground-secondary">{index + 1}</span>
              {index < steps.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
            </div>
            <p className="pb-1 text-sm text-foreground-secondary">{line}</p>
          </li>
        ))}
      </ol>
      {!rolledBack && (
        <div className="mt-4 border-t border-border pt-3">
          <button
            onClick={onRollback}
            disabled={rollingBack || !rollbackSafe}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground-secondary hover:bg-background-elevated disabled:opacity-50"
          >
            <RotateCcw className={`h-4 w-4 ${rollingBack ? 'animate-spin' : ''}`} />
            {rollbackSafe ? 'Rollback this proof run' : 'Rollback blocked'}
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-background-secondary p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-foreground-tertiary">{icon}</div>
        <div className="text-2xl font-semibold text-foreground">{value}</div>
      </div>
      <div className="mt-2 text-sm text-foreground-secondary">{label}</div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-foreground-secondary">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function HealthStrip({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="text-sm font-semibold text-foreground">{label}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => <span key={value} className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary">{value}</span>)}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = ['routable', 'available', 'start', 'truth-gated', 'supported', 'validated'].includes(normalized)
    ? 'border-status-success/30 bg-status-success/10 text-status-success'
    : ['blocked', 'contradicted', 'review_required', 'skip', 'draft', 'candidate'].includes(normalized)
      ? 'border-status-warning/30 bg-status-warning/10 text-status-warning'
      : 'border-border bg-background-elevated text-foreground-secondary';
  return <span className={`rounded border px-2 py-1 text-xs font-medium ${tone}`}>{status}</span>;
}

function ExpandToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 inline-flex items-center gap-1 text-xs text-foreground-tertiary hover:text-foreground-secondary"
    >
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      {open ? 'Hide evidence' : 'Show evidence'}
    </button>
  );
}

function FieldList({ label, values }: { label: string; values: string[] }) {
  if (!values || values.length === 0) {
    return (
      <div>
        <span className="text-foreground-tertiary">{label}:</span> <span className="text-foreground-tertiary">none</span>
      </div>
    );
  }
  return (
    <div>
      <span className="text-foreground-tertiary">{label}:</span>
      <div className="mt-0.5 flex flex-wrap gap-1">
        {values.map((value) => <span key={value} className="rounded border border-border px-1.5 py-0.5 text-foreground-secondary">{value}</span>)}
      </div>
    </div>
  );
}
