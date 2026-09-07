import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, Database, Gauge, GitBranch, Network, PlayCircle, RefreshCw, RotateCcw, Route, ShieldCheck, Workflow } from 'lucide-react';
import { api, type AgentInteractionRecord, type CapacityPlanV2Result, type ClaimLedgerRecord, type EcosystemMapSummary, type GoalBatchPreviewResult, type IntegrationSpineChain, type KnowledgeRuntimeHealth, type KnowledgeSyncResult, type OutcomeLearningAssessment, type ProofRunSummary, type ReviewerIndependenceAssessment, type SwarmCapabilityRecord, type SwarmMissionControl, type WorkerPoolPlanResult } from '../lib/api';

const FLYWHEEL_BATCH_PATH = 'openspec/changes/prove-learning-flywheel-operator-loop/goals.batch.json';

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function knowledgeRuntimePanelModel(knowledge: KnowledgeRuntimeHealth | null) {
  return {
    canonical: knowledge?.okf_base || knowledge?.canonical_candidate || 'unknown',
    usesPackagesKnowledge: Boolean(knowledge?.drift.packages_knowledge_is_canonical),
    status: knowledge?.valid ? 'valid' : knowledge?.validate_okf.status || 'unknown',
  };
}

export function integrationSpinePanelModel(spine: SwarmMissionControl['integration_spine'] | null | undefined) {
  const chains = asArray<IntegrationSpineChain>(spine?.chains);
  return {
    latest: spine?.latest || chains[0] || null,
    chains,
    nextSafeAction: spine?.next_safe_action || chains[0]?.next_safe_action || 'Import integration event',
  };
}

export function ecosystemMapPanelModel(map: EcosystemMapSummary | null | undefined) {
  return {
    nodes: asArray<EcosystemMapSummary['nodes'][number]>(map?.nodes),
    contracts: asArray<EcosystemMapSummary['declared_contracts'][number]>(map?.declared_contracts),
    routes: asArray<EcosystemMapSummary['observed_routes'][number]>(map?.observed_routes),
    evolution: asArray<EcosystemMapSummary['evolution'][number]>(map?.evolution),
    integrality: asArray<EcosystemMapSummary['integrality'][number]>(map?.integrality),
    decisions: asArray<EcosystemMapSummary['decisions'][number]>(map?.decisions),
    repositories: asArray<EcosystemMapSummary['inventory']['repositories'][number]>(map?.inventory?.repositories),
    agents: asArray<EcosystemMapSummary['inventory']['agents'][number]>(map?.inventory?.agents),
    actors: asArray<EcosystemMapSummary['inventory']['observed_actors'][number]>(map?.inventory?.observed_actors),
    evidenceWindow: map?.evidence_window || { interactions: 0, integration_chains: 0 },
  };
}

export function productionCertificationPanelModel(mission: SwarmMissionControl | null) {
  const certification = mission?.production_certification;
  const readiness = mission?.runtime_readiness;
  return {
    status: certification?.status || 'missing',
    runtime: certification?.runtime || 'none',
    productionPassed: Boolean(certification?.production_passed),
    missing: asArray<string>(certification?.production_missing),
    readyRuntimes: asArray<any>(readiness?.runtimes).filter((runtime) => runtime.ready).map((runtime) => String(runtime.runtime)),
    nextSafeAction: certification?.next_safe_action || readiness?.next_safe_action || 'Run real runtime proof certification',
  };
}

export function productionPilotPanelModel(pilot: SwarmMissionControl['production_pilot'] | null | undefined) {
  const runs = asArray<IntegrationSpineChain>(pilot?.runs);
  return {
    latest: pilot?.latest || runs[0] || null,
    runs,
    metrics: pilot?.metrics || {
      total_runs: 0,
      completed_runs: 0,
      success_rate: 0,
      checker_rejection_rate: 0,
      reflection_candidates: 0,
      memory_candidates: 0,
      manual_intervention_count: 0,
      avg_time_to_closure_ms: null,
    },
    nextSafeAction: pilot?.next_safe_action || 'Run production pilot from a low-risk integration item',
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
    api.request('/knowledge/events?limit=20').then((res: any) => setKnowledgeEvents(Array.isArray(res.events) ? res.events : [])).catch(() => {});
  }, []);

  // D11: Learning curve
  useEffect(() => {
    api.request('/swarms/learning-curve').then((res: any) => setLearningCurve(res && typeof res === 'object' ? res : null)).catch(() => {});
  }, []);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [missionResult, capabilitiesResult, claimsResult, knowledgeResult] = await Promise.allSettled([
        api.getSwarmMissionControl(),
        api.getSwarmCapabilities(50),
        api.getSwarmClaims(50),
        api.getKnowledgeRuntime(),
      ]);
      if (missionResult.status === 'fulfilled') {
        setMission(missionResult.value);
        setCapacity(missionResult.value.capacity);
      }
      if (capabilitiesResult.status === 'fulfilled') setCapabilities(asArray<SwarmCapabilityRecord>(capabilitiesResult.value.capabilities));
      if (claimsResult.status === 'fulfilled') setClaims(asArray<ClaimLedgerRecord>(claimsResult.value.claims));
      if (knowledgeResult.status === 'fulfilled') setKnowledge(knowledgeResult.value);
      const failures = [missionResult, capabilitiesResult, claimsResult, knowledgeResult]
        .filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
      if (failures.length === 4) throw failures[0].reason;
      if (failures.length > 0) setError(`${failures.length} data source${failures.length === 1 ? '' : 's'} unavailable`);
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
  const learningRuns = asArray<any>(learningCurve?.runs);
  const knowledgeEventList = asArray<any>(knowledgeEvents);
  const fairShareOrder = asArray<string>(capacity?.fair_share_order);
  const auditManifestPreview = asArray<any>(capacity?.audit_manifest_preview);
  const nextSafeActions = asArray<string>(mission?.next_safe_actions);
  const skillEvolution = Array.isArray(mission?.skill_evolution) ? mission.skill_evolution : [];
  const interactions = asArray<AgentInteractionRecord>(mission?.agent_interactions);
  const outcomeAssessments = asArray<OutcomeLearningAssessment>(mission?.outcome_learning);
  const reviewerIndependence = asArray<ReviewerIndependenceAssessment>(mission?.reviewer_independence);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Swarm Mission Control</h1>
          <p className="mt-2 max-w-3xl text-foreground-secondary">
            Evidence-first control surface for ecosystem interactions, evolution, skills, specialist councils, claims, capacity and runner governance.
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
        production={productionCertificationPanelModel(mission)}
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

      <EcosystemMapPanel map={mission?.ecosystem_map} />
      <IntegrationSpinePanel spine={mission?.integration_spine} />
      <ProductionPilotPanel pilot={mission?.production_pilot} />

      <section className="rounded-lg border border-border bg-background-secondary p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Agent Interaction Ledger</h2>
            <p className="mt-1 text-sm text-foreground-secondary">
              Redacted actor → action → target evidence projected from the existing operational ledgers.
            </p>
          </div>
          <div className="text-xs text-foreground-tertiary">
            {interactions.length} recent interactions · {outcomeAssessments.length} outcome assessments
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-foreground-tertiary">
              <tr>
                <th className="py-2 pr-4">Time</th>
                <th className="py-2 pr-4">Actor</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Target</th>
                <th className="py-2 pr-4">Scope</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {interactions.map((interaction) => (
                <tr key={interaction.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap py-2 pr-4 text-xs text-foreground-tertiary">
                    <time dateTime={interaction.timestamp}>{new Date(interaction.timestamp).toLocaleString()}</time>
                  </td>
                  <td className="py-2 pr-4">
                    <div className="font-mono text-xs text-foreground">{interaction.actor.id}</div>
                    <div className="text-xs text-foreground-tertiary">{interaction.actor.role || interaction.actor.type}{interaction.actor.runtime ? ` · ${interaction.actor.runtime}` : ''}</div>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{interaction.action}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{interaction.target ? `${interaction.target.type}:${interaction.target.id}` : 'none'}</td>
                  <td className="py-2 pr-4"><StatusBadge status={interaction.effect_scope} /></td>
                  <td className="py-2 pr-4"><StatusBadge status={interaction.status} /></td>
                  <td className="py-2 text-xs text-foreground-tertiary">{asArray<string>(interaction.evidence_refs).slice(0, 2).join(', ') || 'none'}</td>
                </tr>
              ))}
              {interactions.length === 0 && (
                <tr><td colSpan={7} className="border-t border-border py-4 text-center text-sm text-foreground-tertiary">No attributable agent interactions recorded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {outcomeAssessments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Outcome learning assessments">
            {outcomeAssessments.slice(0, 8).map((assessment) => (
              <div key={assessment.id} className="rounded border border-border px-3 py-2 text-xs text-foreground-secondary">
                <span className="font-medium text-foreground">{assessment.capability_id}</span>
                {' · '}{assessment.metric}{' · '}n={assessment.replications}{' '}
                <StatusBadge status={assessment.status.toLowerCase()} />
              </div>
            ))}
          </div>
        )}
        {reviewerIndependence.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Reviewer independence diagnostics">
            {reviewerIndependence.slice(0, 8).map((assessment) => (
              <div key={assessment.loop_run_id} className="rounded border border-border px-3 py-2 text-xs text-foreground-secondary">
                <span className="font-mono text-foreground">{assessment.loop_run_id}</span>
                {' · reviewer independence '}<StatusBadge status={assessment.state.toLowerCase()} />
                {assessment.correlated_fields.length > 0 ? ` · correlated: ${assessment.correlated_fields.join(', ')}` : ''}
              </div>
            ))}
          </div>
        )}
      </section>

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
          <h2 className="text-lg font-semibold text-foreground">Skill Evolution Readiness</h2>
          <p className="mt-1 text-sm text-foreground-secondary">Exact outcomes, baseline and OpenMythos evidence required by the existing promotion gate. The final training gate still runs during promotion.</p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-foreground-tertiary">
              <tr>
                <th className="py-2 pr-4">Skill</th>
                <th className="py-2 pr-4">Assigned</th>
                <th className="py-2 pr-4">Candidate runs</th>
                <th className="py-2 pr-4">Baselines</th>
                <th className="py-2 pr-4">OpenMythos</th>
                <th className="py-2 pr-4">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {skillEvolution.map((skill) => (
                <tr key={skill.capability_id} className="border-t border-border">
                  <td className="py-2 pr-4">
                    <div className="font-medium text-foreground">{skill.skill_id || skill.capability_id}</div>
                    <div className="font-mono text-xs text-foreground-tertiary">v{skill.skill_version || '?'} · {skill.candidate_hash.slice(0, 12) || 'unattributed'}</div>
                  </td>
                  <td className="py-2 pr-4 text-foreground-secondary">{skill.assigned_agents}</td>
                  <td className="py-2 pr-4 text-foreground-secondary">{skill.candidate_runs}</td>
                  <td className="py-2 pr-4 text-foreground-secondary">{skill.baseline_hashes.length}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{skill.openmythos_run_id || 'missing'}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={skill.evidence_ready ? 'ready' : 'blocked'} />
                    {!skill.evidence_ready && <div className="mt-1 max-w-xl text-xs text-status-warning">{skill.blocked_reasons.join(', ')}</div>}
                  </td>
                </tr>
              ))}
              {!skillEvolution.length && <tr><td className="py-3 text-foreground-tertiary" colSpan={6}>No governed skill capabilities registered.</td></tr>}
            </tbody>
          </table>
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
              {fairShareOrder.map((item) => <span key={item} className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary">{item}</span>)}
              {!fairShareOrder.length && <p className="text-sm text-foreground-tertiary">No fair-share plan.</p>}
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
              {auditManifestPreview.slice(0, 8).map((item) => (
                <tr key={item.decision_id} className="border-t border-border">
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{item.decision_id}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{item.lease_id}</td>
                  <td className="py-2 pr-4"><StatusBadge status={item.action} /></td>
                  <td className="py-2 pr-4 text-foreground-secondary">{item.queue_class}</td>
                  <td className="py-2 pr-4 text-foreground-tertiary">{item.blocked_reasons.join(', ') || 'none'}</td>
                </tr>
              ))}
              {!auditManifestPreview.length && (
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
          {nextSafeActions.map((action) => (
            <div key={action} className="rounded border border-border bg-background p-3 text-sm text-foreground-secondary">{action}</div>
          ))}
          {!nextSafeActions.length && <p className="text-sm text-foreground-tertiary">No action guidance available.</p>}
        </div>
      </section>

      {learningRuns.length > 0 && (
        <section className="rounded-lg border border-border bg-background-secondary p-5">
          <h2 className="text-lg font-semibold text-foreground">Learning Curve ({learningRuns.length} runs)</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <SmallStat label="Success Rate" value={`${((learningCurve?.first_vs_last?.first_success_rate || 0) * 100).toFixed(0)}% -> ${((learningCurve?.first_vs_last?.last_success_rate || 0) * 100).toFixed(0)}%`} />
            <SmallStat label="Cost" value={`$${(learningCurve?.first_vs_last?.first_cost || 0).toFixed(4)} -> $${(learningCurve?.first_vs_last?.last_cost || 0).toFixed(4)}`} />
            <SmallStat label="Retries" value={learningCurve?.trend?.retries_decreasing ? 'decreasing' : 'not decreasing'} />
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-foreground-tertiary">
                <tr>
                  <th className="py-2 pr-4">Run</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Success</th>
                  <th className="py-2 pr-4">Retries</th>
                  <th className="py-2 pr-4">$ Spent</th>
                </tr>
              </thead>
              <tbody>
                {learningRuns.slice(-10).map((run: any) => (
                  <tr key={run.run_id} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono text-xs">{String(run.run_id || '').slice(0, 8)}</td>
                    <td className="py-2 pr-4 text-xs text-foreground-tertiary">{run.created_at ? new Date(run.created_at).toLocaleDateString() : '-'}</td>
                    <td className="py-2 pr-4">{run.success ? 'yes' : 'no'}</td>
                    <td className="py-2 pr-4">{run.retries ?? 0}</td>
                    <td className="py-2 pr-4">${Number(run.dollars || 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {knowledgeEventList.length > 0 && (
        <section className="rounded-lg border border-border bg-background-secondary p-5">
          <h2 className="text-lg font-semibold text-foreground">Knowledge Bus Events ({knowledgeEventList.length})</h2>
          <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
            {knowledgeEventList.map((event: any) => (
              <div key={event.id} className="flex items-start gap-3 rounded border border-border bg-background p-3 text-sm">
                <span className="font-mono text-xs text-accent">{event.predicate}</span>
                <span className="flex-1 truncate text-foreground-secondary">{event.subject_ref}</span>
                <span className="text-xs text-foreground-tertiary">{event.created_at ? new Date(event.created_at).toLocaleTimeString() : '-'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
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
        <HealthStrip label="Next Safe Actions" values={(asArray<string>(knowledge?.next_safe_actions).length ? asArray<string>(knowledge?.next_safe_actions) : ['Load knowledge runtime']).slice(0, 4)} />
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

function ProductionPilotPanel({ pilot }: { pilot: SwarmMissionControl['production_pilot'] | null | undefined }) {
  const model = productionPilotPanelModel(pilot);
  const metrics = model.metrics;
  return (
    <section className="rounded-lg border border-border bg-background-secondary p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Production Pilot</h2>
            <StatusBadge status={model.latest ? 'tracking' : 'empty'} />
          </div>
          <p className="mt-1 text-sm text-foreground-secondary">
            {model.latest ? `${metrics.completed_runs}/${metrics.total_runs} closed pilot runs` : 'No production pilot runs marked yet.'}
          </p>
        </div>
        <div className="rounded border border-border bg-background px-3 py-2 text-sm text-foreground-secondary">
          {model.nextSafeAction}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
        <SmallStat label="Runs" value={metrics.total_runs} />
        <SmallStat label="Success" value={`${Math.round(metrics.success_rate * 100)}%`} />
        <SmallStat label="Checker Reject" value={`${Math.round(metrics.checker_rejection_rate * 100)}%`} />
        <SmallStat label="Candidates" value={metrics.reflection_candidates + metrics.memory_candidates} />
        <SmallStat label="Interventions" value={metrics.manual_intervention_count} />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-foreground-tertiary">
            <tr>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Work</th>
              <th className="py-2 pr-4">Runtime</th>
              <th className="py-2 pr-4">Closure</th>
              <th className="py-2 pr-4">Next</th>
            </tr>
          </thead>
          <tbody>
            {model.runs.map((run) => (
              <tr key={run.work_item.id} className="border-t border-border align-top">
                <td className="py-2 pr-4">
                  <div className="font-mono text-xs text-foreground-secondary">{run.source}</div>
                  <div className="font-mono text-xs text-foreground-tertiary">{run.source_ref || 'no-ref'}</div>
                </td>
                <td className="py-2 pr-4">
                  <div className="font-mono text-xs text-foreground">{run.work_item.id}</div>
                  <StatusBadge status={run.work_item.status} />
                </td>
                <td className="py-2 pr-4 text-xs text-foreground-secondary">{run.requested_runtime || run.work_item.assigned_runtime || 'none'}</td>
                <td className="py-2 pr-4 text-xs text-foreground-secondary">
                  <div>eval {run.eval_run?.id || 'none'}</div>
                  <div>memory {run.memory_candidate?.id || 'none'}</div>
                </td>
                <td className="py-2 pr-4 text-foreground-secondary">{run.next_safe_action}</td>
              </tr>
            ))}
            {!model.runs.length && (
              <tr><td className="py-3 text-foreground-tertiary" colSpan={5}>No pilot run evidence yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EcosystemMapPanel({ map }: { map: EcosystemMapSummary | null | undefined }) {
  const model = ecosystemMapPanelModel(map);
  const label = (reference: string) => model.nodes.find((node) => node.id === reference)?.label
    || reference.replace(/^agent:/, 'agent ').replace(/^actor:/, 'actor ').replace(/^tool:/, 'tool ');
  const observedNodes = model.nodes.filter((node) => node.evidence_state === 'OBSERVED').length;
  const observedContracts = model.contracts.filter((contract) => contract.evidence_state === 'OBSERVED').length;
  const failedDimensions = model.integrality.filter((dimension) => dimension.state === 'FAIL').length;
  const undeterminedDimensions = model.integrality.filter((dimension) => dimension.state === 'UNDETERMINED').length;
  const actorRows = [
    ...model.actors,
    ...model.agents.filter((agent) => !model.actors.some((actor) => actor.id === agent.id)).map((agent) => ({
      id: agent.id,
      type: 'agent',
      component_id: agent.component_id,
      registered: true,
      observed_interactions: 0,
      last_seen: agent.last_seen || '',
    })),
  ];

  return (
    <section className="rounded-lg border border-border bg-background-secondary p-5" aria-labelledby="ecosystem-map-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-accent" />
            <h2 id="ecosystem-map-heading" className="text-lg font-semibold text-foreground">DJIMIT Ecosystem Map</h2>
          </div>
          <p className="mt-1 max-w-4xl text-sm text-foreground-secondary">
            One read-only view of authority boundaries, observed component and bot interactions, evolution closure, decisions and provenance gaps. No aggregate safety score is calculated.
          </p>
        </div>
        <div className="text-right text-xs text-foreground-tertiary">
          <div>{model.evidenceWindow.interactions} interactions · {model.evidenceWindow.integration_chains} integration chains</div>
          <div>{observedNodes}/{model.nodes.length} components observed · {observedContracts}/{model.contracts.length} declared routes observed</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <SmallStat label="Repositories" value={model.repositories.length} />
        <SmallStat label="Agents / bots" value={actorRows.length} />
        <SmallStat label="Observed actors" value={model.actors.length} />
        <SmallStat label="Fail / unknown" value={`${failedDimensions}/${undeterminedDimensions}`} />
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-semibold text-foreground">Authority and responsibility</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {model.nodes.map((node) => (
            <article key={node.id} className="rounded border border-border bg-background p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-foreground">{node.label}</div>
                  <div className="text-xs text-foreground-tertiary">{node.kind.replace(/_/g, ' ')}</div>
                </div>
                <StatusBadge status={node.evidence_state} />
              </div>
              <p className="mt-2 text-xs text-foreground-secondary">{node.responsibility}</p>
              <p className="mt-2 border-l-2 border-status-warning/40 pl-2 text-xs text-foreground-tertiary">{node.boundary}</p>
              <details className="mt-2 text-xs text-foreground-tertiary">
                <summary className="cursor-pointer select-none">Trade-off and evidence</summary>
                <p className="mt-1">{node.tradeoff}</p>
                <p className="mt-1">{node.observed_interactions} interactions · {node.registered_repositories.length} repos · {node.registered_agents.length} agents</p>
              </details>
            </article>
          ))}
          {model.nodes.length === 0 && <p className="text-sm text-foreground-tertiary">Ecosystem projection unavailable.</p>}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded border border-border bg-background p-4">
          <h3 className="text-sm font-semibold text-foreground">Evolution and learning chain</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            {model.evolution.map((stage, index) => (
              <div key={stage.stage} className="relative rounded border border-border p-3">
                <div className="text-xs uppercase text-foreground-tertiary">{index + 1}. {stage.stage.replace(/_/g, ' ')}</div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-xl font-semibold text-foreground">{stage.count}</span>
                  <StatusBadge status={stage.evidence_state} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded border border-border bg-background p-4">
          <h3 className="text-sm font-semibold text-foreground">Integrality vector</h3>
          <p className="mt-1 text-xs text-foreground-tertiary">Independent states remain PASS, FAIL or UNDETERMINED; unknown evidence is never treated as pass.</p>
          <div className="mt-3 space-y-2">
            {model.integrality.map((dimension) => (
              <div key={dimension.dimension} className="flex items-start justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
                <div>
                  <div className="text-sm font-medium text-foreground">{dimension.dimension.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-foreground-tertiary">{dimension.evidence}</div>
                  {dimension.blocked_reasons.length > 0 && <div className="mt-1 text-xs text-status-warning">{dimension.blocked_reasons.slice(0, 3).join(', ')}</div>}
                </div>
                <StatusBadge status={dimension.state} />
              </div>
            ))}
            {model.integrality.length === 0 && <p className="text-sm text-foreground-tertiary">No integrality evidence available.</p>}
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Observed interactions</h3>
          <span className="text-xs text-foreground-tertiary">aggregated from immutable and operational ledgers</span>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-foreground-tertiary">
            <tr>
              <th className="py-2 pr-4">From</th>
              <th className="py-2 pr-4">To</th>
              <th className="py-2 pr-4">Actions</th>
              <th className="py-2 pr-4">Scope</th>
              <th className="py-2 pr-4">Count</th>
              <th className="py-2">Last evidence</th>
            </tr>
          </thead>
          <tbody>
            {model.routes.map((route) => (
              <tr key={`${route.from}:${route.to}`} className="border-t border-border align-top">
                <td className="py-2 pr-4 font-medium text-foreground">{label(route.from)}</td>
                <td className="py-2 pr-4 font-medium text-foreground">{label(route.to)}</td>
                <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{route.actions.join(', ')}</td>
                <td className="py-2 pr-4"><div className="flex flex-wrap gap-1">{route.effect_scopes.map((scope) => <StatusBadge key={scope} status={scope} />)}</div></td>
                <td className="py-2 pr-4 text-foreground-secondary">{route.observed_count}</td>
                <td className="whitespace-nowrap py-2 text-xs text-foreground-tertiary"><time dateTime={route.last_seen}>{new Date(route.last_seen).toLocaleString()}</time></td>
              </tr>
            ))}
            {model.routes.length === 0 && <tr><td colSpan={6} className="border-t border-border py-4 text-center text-foreground-tertiary">No attributable routes observed.</td></tr>}
          </tbody>
        </table>
      </div>

      <details className="mt-5 rounded border border-border bg-background p-4">
        <summary className="cursor-pointer select-none text-sm font-semibold text-foreground">Declared integration contracts and boundaries</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-foreground-tertiary"><tr><th className="py-2 pr-4">Route</th><th className="py-2 pr-4">Exchange</th><th className="py-2 pr-4">Boundary</th><th className="py-2">Evidence</th></tr></thead>
            <tbody>{model.contracts.map((contract) => (
              <tr key={`${contract.from}:${contract.to}`} className="border-t border-border align-top">
                <td className="whitespace-nowrap py-2 pr-4 font-medium text-foreground">{label(contract.from)} → {label(contract.to)}</td>
                <td className="py-2 pr-4 text-foreground-secondary">{contract.exchange}</td>
                <td className="py-2 pr-4 text-foreground-tertiary">{contract.boundary}</td>
                <td className="py-2"><StatusBadge status={contract.evidence_state} /> <span className="ml-1 text-xs text-foreground-tertiary">n={contract.observed_count}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>

      <details className="mt-3 rounded border border-border bg-background p-4">
        <summary className="cursor-pointer select-none text-sm font-semibold text-foreground">Repositories, agents and bots</summary>
        <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="overflow-x-auto">
            <h4 className="mb-2 text-xs font-semibold uppercase text-foreground-tertiary">Registered repositories</h4>
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-foreground-tertiary"><tr><th className="py-2 pr-4">Repository</th><th className="py-2 pr-4">Component</th><th className="py-2 pr-4">State</th><th className="py-2">Commit</th></tr></thead>
              <tbody>{model.repositories.map((repo) => (
                <tr key={repo.id} className="border-t border-border"><td className="py-2 pr-4"><Link className="text-accent hover:underline" to={`/repositories/${repo.id}`}>{repo.name}</Link></td><td className="py-2 pr-4 text-foreground-secondary"><div>{repo.component_id ? label(repo.component_id) : 'unmapped'}</div><div className="text-xs text-foreground-tertiary">{repo.mapping_basis || 'no mapping evidence'}</div></td><td className="py-2 pr-4"><StatusBadge status={repo.status} />{repo.deployment_provenance && <div className="mt-1"><StatusBadge status={repo.deployment_provenance.status} /></div>}</td><td className="py-2 font-mono text-xs text-foreground-tertiary"><div>source {repo.commit?.slice(0, 12) || 'unproven'}</div><div>deployed {repo.deployment_provenance?.commit.slice(0, 12) || 'unproven'}</div><div>{repo.deployment_provenance?.canonical_source_state || ''}</div></td></tr>
              ))}{model.repositories.length === 0 && <tr><td colSpan={4} className="border-t border-border py-3 text-foreground-tertiary">No registered repositories.</td></tr>}</tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <h4 className="mb-2 text-xs font-semibold uppercase text-foreground-tertiary">Registered and observed actors</h4>
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-foreground-tertiary"><tr><th className="py-2 pr-4">Agent / bot</th><th className="py-2 pr-4">Component</th><th className="py-2 pr-4">State</th><th className="py-2">Interactions</th></tr></thead>
              <tbody>{actorRows.map((actor) => {
                const registered = model.agents.find((agent) => agent.id === actor.id);
                return <tr key={actor.id} className="border-t border-border"><td className="py-2 pr-4"><div className="font-medium text-foreground">{registered?.name || actor.id}</div><div className="font-mono text-xs text-foreground-tertiary">{actor.id}</div></td><td className="py-2 pr-4 text-foreground-secondary"><div>{actor.component_id ? label(actor.component_id) : 'unmapped'}</div><div className="text-xs text-foreground-tertiary">{registered?.mapping_basis || (actor.component_id ? 'runtime name match' : 'no mapping evidence')}</div></td><td className="py-2 pr-4"><StatusBadge status={registered?.status || 'observed'} /></td><td className="py-2 text-foreground-secondary">{actor.observed_interactions}</td></tr>;
              })}{actorRows.length === 0 && <tr><td colSpan={4} className="border-t border-border py-3 text-foreground-tertiary">No registered or observed actors.</td></tr>}</tbody>
            </table>
          </div>
        </div>
      </details>

      <details className="mt-3 rounded border border-border bg-background p-4">
        <summary className="cursor-pointer select-none text-sm font-semibold text-foreground">Recorded decisions and trade-offs</summary>
        <div className="mt-3 space-y-2">
          {model.decisions.map((decision) => (
            <div key={decision.id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-medium text-foreground">{decision.actor}: {decision.decision}</div><StatusBadge status={decision.status} /></div>
              <p className="mt-1 text-xs text-foreground-secondary">{decision.rationale || 'No rationale recorded.'}</p>
              <div className="mt-1 text-xs text-foreground-tertiary">{decision.type} · {decision.evidence_refs.length} evidence/gate refs · <time dateTime={decision.timestamp}>{new Date(decision.timestamp).toLocaleString()}</time></div>
              {decision.blocked_reasons.length > 0 && <div className="mt-1 text-xs text-status-warning">{decision.blocked_reasons.join(', ')}</div>}
            </div>
          ))}
          {model.decisions.length === 0 && <p className="text-sm text-foreground-tertiary">No recorded decisions.</p>}
        </div>
      </details>
    </section>
  );
}

function IntegrationSpinePanel({ spine }: { spine: SwarmMissionControl['integration_spine'] | null | undefined }) {
  const model = integrationSpinePanelModel(spine);
  const latest = model.latest;
  return (
    <section className="rounded-lg border border-border bg-background-secondary p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Route className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">Integration Spine</h2>
            <StatusBadge status={latest ? latest.work_item.status : 'empty'} />
          </div>
          <p className="mt-1 text-sm text-foreground-secondary">
            {latest ? `${latest.source}:${latest.source_ref || 'no-ref'} -> ${latest.work_item.id}` : 'No integration-origin work item yet.'}
          </p>
        </div>
        <div className="rounded border border-border bg-background px-3 py-2 text-sm text-foreground-secondary">
          {model.nextSafeAction}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <SmallStat label="Work Item" value={latest?.work_item.status || 'none'} />
        <SmallStat label="Loop" value={latest?.loop?.status || 'none'} />
        <SmallStat label="Runtime" value={latest?.requested_runtime || latest?.work_item.assigned_runtime || 'none'} />
        <SmallStat label="Learning" value={latest?.eval_run ? 'closed' : latest?.loop ? 'pending' : 'none'} />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-foreground-tertiary">
            <tr>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Work</th>
              <th className="py-2 pr-4">Loop</th>
              <th className="py-2 pr-4">Leases</th>
              <th className="py-2 pr-4">Learning</th>
              <th className="py-2 pr-4">Next</th>
            </tr>
          </thead>
          <tbody>
            {model.chains.map((chain) => (
              <tr key={chain.work_item.id} className="border-t border-border align-top">
                <td className="py-2 pr-4">
                  <div className="font-mono text-xs text-foreground-secondary">{chain.source}</div>
                  <div className="font-mono text-xs text-foreground-tertiary">{chain.source_ref || 'no-ref'}</div>
                </td>
                <td className="py-2 pr-4">
                  <div className="font-mono text-xs text-foreground">{chain.work_item.id}</div>
                  <StatusBadge status={chain.work_item.status} />
                </td>
                <td className="py-2 pr-4">
                  <div className="font-mono text-xs text-foreground-secondary">{chain.loop?.id || 'none'}</div>
                  {chain.loop ? <StatusBadge status={chain.loop.status} /> : null}
                </td>
                <td className="py-2 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {asArray<IntegrationSpineChain['leases'][number]>(chain.leases).map((lease) => (
                      <span key={lease.id} className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary">
                        {lease.role}:{lease.effective_runtime}:{lease.status}
                      </span>
                    ))}
                    {!chain.leases.length && <span className="text-xs text-foreground-tertiary">none</span>}
                  </div>
                </td>
                <td className="py-2 pr-4 text-xs text-foreground-secondary">
                  <div>eval {chain.eval_run?.id || 'none'}</div>
                  <div>reflection {chain.reflection_candidate?.id || 'none'}</div>
                  <div>memory {chain.memory_candidate?.id || 'none'}</div>
                </td>
                <td className="py-2 pr-4 text-foreground-secondary">{chain.next_safe_action}</td>
              </tr>
            ))}
            {!model.chains.length && (
              <tr><td className="py-3 text-foreground-tertiary" colSpan={6}>No integration chain evidence yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProofRunPanel({
  proofRun,
  production,
  actionId,
  runtime,
  onRuntimeChange,
  onRun,
  onRollback,
}: {
  proofRun: ProofRunSummary | null;
  production: ReturnType<typeof productionCertificationPanelModel>;
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
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusBadge status={production.status} />
            <span className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary">runtime {production.runtime}</span>
            <span className="rounded border border-border px-2 py-1 text-xs text-foreground-secondary">ready {production.readyRuntimes.join(', ') || 'none'}</span>
          </div>
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
            <HealthStrip label="Production Certification" values={[
              `status ${production.status}`,
              production.productionPassed ? 'production passed' : 'production incomplete',
              production.missing.length ? `missing ${production.missing.join(', ')}` : 'missing none',
            ]} />
          </div>
          <div className="mt-3 rounded border border-border bg-background p-3 text-sm text-foreground-secondary">
            {production.nextSafeAction}
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
  const steps = Array.isArray(narrative) && narrative.length ? narrative : ['No narrative captured for this run.'];
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
  const tone = ['routable', 'available', 'start', 'truth-gated', 'supported', 'validated', 'pass'].includes(normalized)
    ? 'border-status-success/30 bg-status-success/10 text-status-success'
    : ['fail', 'error', 'denied'].includes(normalized)
      ? 'border-status-error/30 bg-status-error/10 text-status-error'
      : ['blocked', 'contradicted', 'review_required', 'skip', 'draft', 'candidate', 'undetermined'].includes(normalized)
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
  const list = asArray<string>(values);
  if (list.length === 0) {
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
        {list.map((value) => <span key={value} className="rounded border border-border px-1.5 py-0.5 text-foreground-secondary">{value}</span>)}
      </div>
    </div>
  );
}
