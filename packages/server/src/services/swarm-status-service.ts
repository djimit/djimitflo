import os from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { WorkItemService, type WorkItemRecord } from './work-item-service';
import { LoopService, type LoopName, type WorkerLeaseRecord } from './loop-service';
import { AgentAssuranceService } from './agent-assurance-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { messageBus, type SwarmMessage } from './message_bus';
import { MemoryCandidateService, type MemoryCandidateRecord } from './memory-candidate-service';

type BacklogStatus = 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';
type WorkerRuntime = 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'mock' | 'manual';
type GovernanceRiskClass = 'low' | 'medium' | 'high' | 'critical';
type RunnerLeaseRole = 'maker' | 'checker' | 'security_checker' | 'planner' | 'memory_curator' | 'governance_guard';
const DEFAULT_LOOP_NAME: LoopName = 'doc-drift-and-small-fix-loop';

// Process-wide cache for runtime binary probes. `getStatus()` / `fleetPools()`
// is called repeatedly (e.g. several times per worker-pool drain), and each
// `runtimeCommandAvailable` does a synchronous `execFileSync --version` — some
// CLIs (gemini ~0.6s, cline ~0.4s) are slow enough that probing on every call
// makes the fleet-status path seconds slower. Cache the result per binary for
// a short TTL so each binary is probed at most once per window, process-wide.
const RUNTIME_BIN_CACHE_TTL_MS = 30_000;
const runtimeBinCache = new Map<string, { available: boolean; expiresAt: number }>();
const SUPPORTED_LOOP_NAMES = new Set<LoopName>([
  'doc-drift-and-small-fix-loop',
  'repo-maintenance-loop',
  'skill-quality-loop',
  'mcp-connector-validation-loop',
  'security-regression-loop',
  'okf-synchronization-loop',
  'overwatch-policy-drift-loop',
]);

interface SwarmStatusOptions {
  staleAfterMs?: number;
}

export interface SwarmRealityStatus {
  registry_agent_count: number;
  live_agent_count: number;
  worker_lease_count: number;
  active_execution_count: number;
  task_count: {
    open_work_items: number;
    open_loop_runs: number;
    open_tasks: number;
    total: number;
  };
  backlog_count: Record<BacklogStatus, number>;
  stale_agents: Array<{ id: string; name: string; status: string; last_active_at: string | null }>;
  resource_snapshot: {
    cpu_threads: number;
    total_memory_bytes: number;
    free_memory_bytes: number;
    load_average: number[];
    uptime_seconds: number;
  };
  fleet_pools: Array<{
    runtime: string;
    available: boolean;
    prepared_leases: number;
    queued_leases: number;
    running_leases: number;
    completed_24h: number;
    failed_24h: number;
    average_runtime_ms: number | null;
    failure_rate_24h: number;
    tokens_used_24h: number;
    tokens_per_successful_worker: number | null;
    tokens_per_diff_line: number | null;
    recommended_concurrency: number;
    capacity_used_percent: number;
    oldest_queued_age_ms: number | null;
    next_recommended_action: 'execute_maker' | 'execute_checker' | 'wait';
    bottleneck_reason: string | null;
    blocked_capacity_reasons: string[];
    queue_depth_by_risk: Record<string, number>;
  }>;
  fleet_topology: Array<{
    goal_id: string | null;
    goal_objective: string | null;
    loop_run_id: string;
    loop_name: string;
    run_status: string;
    lease_id: string;
    role: string;
    runtime: string;
    lease_status: string;
    artifact_path: string | null;
    stdout_path: string | null;
    stderr_path: string | null;
    warning_count: number;
    latest_gate: string | null;
    failed_gate: string | null;
    latest_event: string | null;
    next_safe_action: WorkerPoolDecision['next_action'];
    bottleneck_reason: string | null;
  }>;
  open_handoffs: Array<{
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    priority: string;
    source_lease_id: string | null;
    loop_run_id: string | null;
    work_item_id: string | null;
    task_id: string | null;
    target_role: string | null;
    summary: string;
    created_at: string;
  }>;
  reality_check: {
    agent_count_is_registry_only: boolean;
    active_execution_requires_runtime_evidence: boolean;
  };
}

export interface AgentHandoffInput {
  from_agent_id?: string;
  to_agent_id?: string;
  source_lease_id?: string;
  work_item_id?: string;
  task_id?: string;
  target_role?: RunnerLeaseRole;
  summary?: string;
  evidence_ref?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

export interface AgentHandoffAcceptResult {
  message: SwarmMessage;
  action: 'memory_candidate_created' | 'work_item_created';
  memory_candidate?: MemoryCandidateRecord;
  work_item?: WorkItemRecord;
}

export interface SwarmEvolutionRunResult {
  eval_run: Record<string, unknown>;
  previous_score: number | null;
  score_delta: number | null;
  improved: boolean | null;
  reflection: Record<string, unknown>;
  follow_up_work_item: WorkItemRecord | null;
}

export interface AgentHandoffDrainInput extends WorkerPoolPlanInput {
  max_handoffs?: number;
  plan?: boolean;
  prepare?: boolean;
  start_workers?: boolean;
  repository_path?: string;
}

export interface AgentHandoffDrainResult {
  action: 'drained';
  accepted: AgentHandoffAcceptResult[];
  failed: Array<{ handoff_id: string; error: string }>;
  memory_candidate_ids: string[];
  work_item_ids: string[];
  scheduler_tick: SchedulerTickResult | null;
  worker_pool_drain: WorkerPoolDrainResult | null;
}

export interface SchedulerTickResult {
  created_work_items: WorkItemRecord[];
  planned_work_items: WorkItemRecord[];
  prepared_work_items: WorkItemRecord[];
  skipped_existing: number;
  inspected_loop_runs: number;
  leases_created: number;
}

interface SchedulerTickInput {
  max_items?: number;
  plan_triaged?: boolean;
  prepare_planned?: boolean;
  runtime?: WorkerRuntime;
  repository_path?: string;
  max_assignments_per_item?: number;
  work_item_ids?: string[];
}

export interface WorkerPoolPlanInput {
  runtime?: WorkerRuntime;
  checker_runtime?: Exclude<WorkerRuntime, 'manual'>;
  max_workers?: number;
  timeout_ms?: number;
  diff_max_lines?: number;
  skip_permissions?: boolean;
  allow_high_risk?: boolean;
  ignore_capacity?: boolean;
  simulate_low_capacity?: boolean;
}

export interface WorkerPoolDecision {
  lease_id: string;
  loop_run_id: string;
  role: RunnerLeaseRole;
  runtime: string;
  effective_runtime: string;
  status: string;
  risk_class: string;
  eligible: boolean;
  blocked_reasons: string[];
  priority_score: number;
  queue_age_ms: number;
  bottleneck_reason: string | null;
  next_action: 'execute_maker' | 'execute_checker' | 'human_review' | 'wait';
}

export interface WorkerPoolPlanResult {
  decisions: WorkerPoolDecision[];
  eligible_count: number;
  blocked_count: number;
  running_count: number;
  max_workers: number;
  capacity_snapshot: SwarmRealityStatus['resource_snapshot'];
}

export interface WorkerPoolStartResult {
  action: 'started' | 'blocked';
  decision: WorkerPoolDecision | null;
  plan: WorkerPoolPlanResult;
  execution?: unknown;
}

export interface WorkerPoolDrainResult {
  action: 'drained';
  started: WorkerPoolStartResult[];
  final_plan: WorkerPoolPlanResult;
}

export interface BacklogFleetSyncResult {
  inspected_work_items: number;
  updated_work_items: WorkItemRecord[];
}

export class SwarmStatusService {
  private workItems: WorkItemService;
  private loops: LoopService;
  private assurance: AgentAssuranceService;
  private intelligence: SwarmIntelligenceService;
  private memoryCandidates: MemoryCandidateService;

  constructor(private db: Database, private options: SwarmStatusOptions = {}) {
    this.workItems = new WorkItemService(db);
    this.loops = new LoopService(db);
    this.assurance = new AgentAssuranceService(db);
    this.intelligence = new SwarmIntelligenceService(db);
    this.memoryCandidates = new MemoryCandidateService(db);
  }

  getStatus(): SwarmRealityStatus {
    const staleAfterMs = this.options.staleAfterMs || 15 * 60 * 1000;
    const cutoffMs = Date.now() - staleAfterMs;
    const agents = this.db.prepare('SELECT id, name, status, last_active_at FROM agents ORDER BY name ASC').all() as any[];
    const liveAgents = agents.filter((agent) => (
      ['idle', 'active'].includes(agent.status)
      && agent.last_active_at
      && Date.parse(agent.last_active_at) >= cutoffMs
    ));
    const staleAgents = agents
      .filter((agent) => ['idle', 'active'].includes(agent.status))
      .filter((agent) => !agent.last_active_at || Date.parse(agent.last_active_at) < cutoffMs)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        last_active_at: agent.last_active_at || null,
      }));

    const workerLeases = this.db.prepare(`
      SELECT * FROM worker_leases
      WHERE status IN ('prepared', 'running')
    `).all() as any[];
    const activeExecutionCount = workerLeases.filter((lease) => {
      if (lease.status !== 'running') return false;
      const metadata = JSON.parse(lease.metadata || '{}');
      return Boolean(metadata.pid || metadata.session_id || metadata.artifact_path || metadata.stdout_path);
    }).length;

    const openWorkItems = this.countRows("SELECT COUNT(*) as count FROM work_items WHERE status IN ('candidate', 'triaged', 'planned', 'leased', 'blocked')");
    const openLoopRuns = this.countRows("SELECT COUNT(*) as count FROM loop_runs WHERE status IN ('created', 'planning', 'running', 'verifying', 'ready_for_human_merge', 'blocked', 'escalated')");
    const openTasks = this.countRows("SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'queued', 'running', 'paused', 'awaiting_approval', 'failed')");
    const backlogCount = this.backlogCounts();

    const resourceSnapshot = {
      cpu_threads: os.cpus().length,
      total_memory_bytes: os.totalmem(),
      free_memory_bytes: os.freemem(),
      load_average: os.loadavg(),
      uptime_seconds: os.uptime(),
    };

    const fleetPools = this.fleetPools(resourceSnapshot);
    return {
      registry_agent_count: agents.length,
      live_agent_count: liveAgents.length,
      worker_lease_count: workerLeases.length,
      active_execution_count: activeExecutionCount,
      task_count: {
        open_work_items: openWorkItems,
        open_loop_runs: openLoopRuns,
        open_tasks: openTasks,
        total: openWorkItems + openLoopRuns + openTasks,
      },
      backlog_count: backlogCount,
      stale_agents: staleAgents,
      resource_snapshot: resourceSnapshot,
      fleet_pools: fleetPools,
      fleet_topology: this.fleetTopology(fleetPools),
      open_handoffs: this.openHandoffs(),
      reality_check: {
        agent_count_is_registry_only: agents.length !== liveAgents.length,
        active_execution_requires_runtime_evidence: true,
      },
    };
  }

  async createHandoff(input: AgentHandoffInput): Promise<SwarmMessage> {
    const fromAgentId = String(input.from_agent_id || '').trim();
    const toAgentId = String(input.to_agent_id || '').trim();
    const summary = String(input.summary || '').trim();
    if (!fromAgentId || !toAgentId || !summary) throw new Error('SWARM_HANDOFF_REQUIRED');
    const priority = input.priority || 'medium';
    if (!['low', 'medium', 'high', 'urgent'].includes(priority)) throw new Error('SWARM_HANDOFF_PRIORITY_INVALID');

    this.assertAgentExists(fromAgentId);
    this.assertAgentExists(toAgentId);

    const sourceLeaseId = String(input.source_lease_id || '').trim();
    const lease = sourceLeaseId ? this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(sourceLeaseId) as any | undefined : null;
    if (sourceLeaseId && !lease) throw new Error('SWARM_HANDOFF_LEASE_NOT_FOUND');

    const workItemId = String(input.work_item_id || '').trim();
    if (workItemId && !this.db.prepare('SELECT id FROM work_items WHERE id = ?').get(workItemId)) {
      throw new Error('SWARM_HANDOFF_WORK_ITEM_NOT_FOUND');
    }
    const taskId = String(input.task_id || '').trim();
    if (taskId && !this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)) {
      throw new Error('SWARM_HANDOFF_TASK_NOT_FOUND');
    }
    if (!sourceLeaseId && !workItemId && !taskId) throw new Error('SWARM_HANDOFF_SOURCE_REQUIRED');

    const now = new Date().toISOString();
    const message: SwarmMessage = {
      id: randomUUID(),
      from_agent_id: fromAgentId,
      to_agent_id: toAgentId,
      type: 'task_delegation',
      priority,
      read_at: null,
      created_at: now,
      payload: {
        kind: 'swarm_handoff',
        summary,
        source_lease_id: sourceLeaseId || null,
        loop_run_id: lease?.loop_run_id || null,
        work_item_id: workItemId || null,
        task_id: taskId || null,
        target_role: input.target_role || null,
        evidence_ref: input.evidence_ref || null,
      },
    };

    this.db.prepare(`
      INSERT INTO messages (id, from_agent_id, to_agent_id, type, payload, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, message.from_agent_id, message.to_agent_id, message.type, JSON.stringify(message.payload), message.priority, message.created_at);

    if (lease) {
      const metadata = this.parseJsonSafe(lease.metadata || '{}');
      this.db.prepare('UPDATE worker_leases SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...metadata, handoff_message_id: message.id, handed_off_to_agent_id: toAgentId, handed_off_at: now }), now, lease.id);
      this.recordRunnerDecision('worker_handoff_created', lease.loop_run_id, 'info', {
        lease_id: lease.id,
        from_agent_id: fromAgentId,
        to_agent_id: toAgentId,
        target_role: input.target_role || null,
        message_id: message.id,
      });
    }

    await messageBus.publish(toAgentId, message);
    return message;
  }

  acceptHandoff(id: string): AgentHandoffAcceptResult {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any | undefined;
    if (!row) throw new Error('SWARM_HANDOFF_NOT_FOUND');
    if (row.read_at) throw new Error('SWARM_HANDOFF_ALREADY_ACCEPTED');
    const message = this.parseMessage(row);
    const payload = message.payload;
    if (payload.kind !== 'swarm_handoff') throw new Error('SWARM_HANDOFF_INVALID');

    const summary = String(payload.summary || '').trim();
    const targetRole = String(payload.target_role || 'planner');
    const loopRunId = typeof payload.loop_run_id === 'string' ? payload.loop_run_id : null;
    const sourceLeaseId = typeof payload.source_lease_id === 'string' ? payload.source_lease_id : null;
    const evidenceRef = typeof payload.evidence_ref === 'string' ? payload.evidence_ref : null;
    const sourceRef = `handoff:${message.id}`;
    const traceId = `handoff-${message.id}`;
    const now = new Date().toISOString();

    let result: AgentHandoffAcceptResult;
    if (targetRole === 'memory_curator') {
      const candidate = this.memoryCandidates.create({
        title: `Handoff memory: ${summary.slice(0, 80)}`,
        content: [
          summary,
          evidenceRef ? `Evidence: ${evidenceRef}` : '',
          sourceLeaseId ? `Source lease: ${sourceLeaseId}` : '',
          loopRunId ? `Loop run: ${loopRunId}` : '',
        ].filter(Boolean).join('\n'),
        memory_type: 'operational_memory',
        source_ref: sourceRef,
        metadata: {
          handoff_message_id: message.id,
          from_agent_id: message.from_agent_id,
          to_agent_id: message.to_agent_id,
          source_lease_id: sourceLeaseId,
          loop_run_id: loopRunId,
        },
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: loopRunId,
        span_type: 'memory',
        name: 'handoff:accept:memory_curator',
        status: 'ok',
        evidence_ref: `memory_candidate:${candidate.id}`,
        ended_at: now,
        metadata: { message_id: message.id, source_lease_id: sourceLeaseId },
      });
      result = { message, action: 'memory_candidate_created', memory_candidate: candidate };
    } else {
      const created = this.workItems.createIfMissingBySourceRef({
        title: summary,
        description: [
          `Handoff target role: ${targetRole}`,
          evidenceRef ? `Evidence: ${evidenceRef}` : '',
          sourceLeaseId ? `Source lease: ${sourceLeaseId}` : '',
          loopRunId ? `Loop run: ${loopRunId}` : '',
        ].filter(Boolean).join('\n'),
        source: 'swarm_handoff',
        source_ref: sourceRef,
        risk_class: 'low',
        value_score: 70,
        confidence: 0.75,
        status: 'candidate',
        recommended_loop: targetRole === 'governance_guard' ? 'overwatch-policy-drift-loop' : targetRole === 'planner' ? 'repo-maintenance-loop' : DEFAULT_LOOP_NAME,
        assigned_agent_id: message.to_agent_id,
        metadata: {
          handoff_message_id: message.id,
          from_agent_id: message.from_agent_id,
          target_role: targetRole,
          source_lease_id: sourceLeaseId,
          source_loop_run_id: loopRunId,
        },
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: loopRunId,
        work_item_id: created.work_item.id,
        span_type: 'worker',
        name: `handoff:accept:${targetRole}`,
        status: 'ok',
        evidence_ref: `work_item:${created.work_item.id}`,
        ended_at: now,
        metadata: { message_id: message.id, created: created.created },
      });
      result = { message, action: 'work_item_created', work_item: created.work_item };
    }

    this.intelligence.createRunnerManifest({
      decision_id: `handoff:accept:${message.id}:${now}`,
      lease_id: sourceLeaseId,
      loop_run_id: loopRunId,
      action: 'plan',
      policy_version: 'swarm-handoff-v1',
      gate_refs: ['handoff_accept'],
      blocked_reasons: [],
      metadata: {
        message_id: message.id,
        target_role: targetRole,
        accepted_action: result.action,
        artifact_ref: result.memory_candidate ? `memory_candidate:${result.memory_candidate.id}` : `work_item:${result.work_item?.id}`,
      },
    });

    const acceptedPayload = {
      ...payload,
      accepted_at: now,
      accepted_action: result.action,
      accepted_ref: result.memory_candidate ? `memory_candidate:${result.memory_candidate.id}` : `work_item:${result.work_item?.id}`,
    };
    this.db.prepare('UPDATE messages SET payload = ?, read_at = ? WHERE id = ?')
      .run(JSON.stringify(acceptedPayload), now, message.id);
    return {
      ...result,
      message: this.parseMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id)),
    };
  }

  async drainHandoffs(input: AgentHandoffDrainInput = {}): Promise<AgentHandoffDrainResult> {
    const maxHandoffs = Math.max(1, Math.min(Number(input.max_handoffs || 10), 50));
    const handoffs = this.openHandoffs().slice(0, maxHandoffs).reverse();
    const accepted: AgentHandoffAcceptResult[] = [];
    const failed: AgentHandoffDrainResult['failed'] = [];

    for (const handoff of handoffs) {
      try {
        accepted.push(this.acceptHandoff(handoff.id));
      } catch (error) {
        failed.push({ handoff_id: handoff.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const workItemIds = accepted
      .map((item) => item.work_item?.id)
      .filter((id): id is string => Boolean(id));
    const shouldSchedule = Boolean(input.plan || input.prepare || input.start_workers);
    if (shouldSchedule) {
      for (const id of workItemIds) {
        const item = this.workItems.get(id);
        if (item.status === 'candidate') {
          this.workItems.update(id, { status: 'triaged', metadata: { ...item.metadata, triaged_from_handoff_drain: true } });
        }
      }
    }

    let schedulerTick: SchedulerTickResult | null = null;
    if (shouldSchedule && workItemIds.length > 0) {
      const plannedTick = this.tickScheduler({
        work_item_ids: workItemIds,
        plan_triaged: true,
        runtime: input.runtime,
        repository_path: input.repository_path,
      });
      let preparedTick: SchedulerTickResult | null = null;
      if (input.prepare || input.start_workers) {
        const plannedIds = plannedTick.planned_work_items.map((item) => item.id);
        preparedTick = this.tickScheduler({
          work_item_ids: plannedIds.length > 0 ? plannedIds : workItemIds,
          prepare_planned: true,
          runtime: input.runtime,
          repository_path: input.repository_path,
        });
      }
      schedulerTick = {
        created_work_items: [...plannedTick.created_work_items, ...(preparedTick?.created_work_items || [])],
        planned_work_items: plannedTick.planned_work_items,
        prepared_work_items: preparedTick?.prepared_work_items || [],
        skipped_existing: plannedTick.skipped_existing + (preparedTick?.skipped_existing || 0),
        inspected_loop_runs: plannedTick.inspected_loop_runs + (preparedTick?.inspected_loop_runs || 0),
        leases_created: plannedTick.leases_created + (preparedTick?.leases_created || 0),
      };
    }

    const workerPoolDrain = input.start_workers
      ? await this.drainWorkerPool({
        runtime: input.runtime,
        checker_runtime: input.checker_runtime,
        max_workers: input.max_workers || Math.max(1, workItemIds.length * 2),
        timeout_ms: input.timeout_ms,
        diff_max_lines: input.diff_max_lines,
        skip_permissions: input.skip_permissions,
        allow_high_risk: input.allow_high_risk,
        ignore_capacity: input.ignore_capacity,
      })
      : null;

    return {
      action: 'drained',
      accepted,
      failed,
      memory_candidate_ids: accepted
        .map((item) => item.memory_candidate?.id)
        .filter((id): id is string => Boolean(id)),
      work_item_ids: accepted
        .map((item) => item.work_item?.id)
        .filter((id): id is string => Boolean(id)),
      scheduler_tick: schedulerTick,
      worker_pool_drain: workerPoolDrain,
    };
  }

  runEvolutionCycle(input: { suite_name?: string; target_type?: 'memory' | 'skill' | 'swarm' | 'loop' | 'capability'; target_ref?: string | null; min_score?: number } = {}): SwarmEvolutionRunResult {
    const suiteName = String(input.suite_name || 'swarm-coordination').trim();
    const targetType = input.target_type || 'swarm';
    const previous = this.latestEval(suiteName, targetType);
    const evalRun = this.assurance.runEval({
      suite_name: suiteName,
      target_type: targetType,
      target_ref: input.target_ref || null,
      metadata: { evolution_cycle: true },
    });
    const previousScore = previous ? Number(previous.score) : null;
    const scoreDelta = previousScore === null ? null : Number((evalRun.score - previousScore).toFixed(4));
    const minScore = Math.max(0, Math.min(Number(input.min_score ?? 0.75), 1));
    const improved = scoreDelta === null ? null : scoreDelta > 0;
    const statusText = scoreDelta === null
      ? `baseline score ${evalRun.score.toFixed(2)}`
      : `${improved ? 'improved' : scoreDelta < 0 ? 'regressed' : 'unchanged'} by ${scoreDelta.toFixed(2)} to ${evalRun.score.toFixed(2)}`;

    const reflection = this.assurance.createReflection({
      source_type: 'eval',
      source_ref: evalRun.id,
      lesson: `${suiteName} ${targetType} evaluation ${statusText}; next runs should preserve evidence that moved the score and create follow-up work when below ${minScore.toFixed(2)}.`,
      evidence_refs: [`eval:${evalRun.id}`, previous ? `eval:${previous.id}` : 'eval:baseline'],
      metadata: {
        evolution_cycle: true,
        suite_name: suiteName,
        target_type: targetType,
        previous_score: previousScore,
        current_score: evalRun.score,
        score_delta: scoreDelta,
      },
    });

    let followUp: WorkItemRecord | null = null;
    if (evalRun.score < minScore) {
      followUp = this.workItems.createIfMissingBySourceRef({
        title: `Improve ${suiteName} ${targetType} score`,
        description: `Latest score ${evalRun.score.toFixed(2)} is below ${minScore.toFixed(2)}. Findings: ${evalRun.findings.join('; ')}`,
        source: 'evolution_cycle',
        source_ref: `eval:${evalRun.id}`,
        risk_class: 'low',
        value_score: 75,
        confidence: 0.8,
        status: 'candidate',
        recommended_loop: this.evolutionLoopFor(targetType),
        metadata: {
          eval_run_id: evalRun.id,
          reflection_id: reflection.id,
          suite_name: suiteName,
          target_type: targetType,
          score: evalRun.score,
          min_score: minScore,
        },
      }).work_item;
    }

    return {
      eval_run: evalRun as unknown as Record<string, unknown>,
      previous_score: previousScore,
      score_delta: scoreDelta,
      improved,
      reflection: reflection as unknown as Record<string, unknown>,
      follow_up_work_item: followUp,
    };
  }

  private openHandoffs(): SwarmRealityStatus['open_handoffs'] {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE type = 'task_delegation' AND read_at IS NULL
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as any[];
    return rows
      .map((row) => {
        const payload = this.parseJsonSafe(row.payload || '{}');
        if (payload.kind !== 'swarm_handoff') return null;
        return {
          id: row.id,
          from_agent_id: row.from_agent_id,
          to_agent_id: row.to_agent_id,
          priority: row.priority,
          source_lease_id: typeof payload.source_lease_id === 'string' ? payload.source_lease_id : null,
          loop_run_id: typeof payload.loop_run_id === 'string' ? payload.loop_run_id : null,
          work_item_id: typeof payload.work_item_id === 'string' ? payload.work_item_id : null,
          task_id: typeof payload.task_id === 'string' ? payload.task_id : null,
          target_role: typeof payload.target_role === 'string' ? payload.target_role : null,
          summary: String(payload.summary || ''),
          created_at: row.created_at,
        };
      })
      .filter((handoff): handoff is SwarmRealityStatus['open_handoffs'][number] => handoff !== null);
  }

  private parseMessage(row: any): SwarmMessage {
    return {
      id: row.id,
      from_agent_id: row.from_agent_id,
      to_agent_id: row.to_agent_id,
      type: row.type,
      payload: this.parseJsonSafe(row.payload || '{}'),
      priority: row.priority,
      read_at: row.read_at || null,
      created_at: row.created_at,
    };
  }

  private latestEval(suiteName: string, targetType: string): { id: string; score: number } | null {
    const row = this.db.prepare(`
      SELECT id, score FROM agent_eval_runs
      WHERE suite_name = ? AND target_type = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(suiteName, targetType) as { id: string; score: number } | undefined;
    return row || null;
  }

  private evolutionLoopFor(targetType: string): LoopName {
    if (targetType === 'memory') return 'okf-synchronization-loop';
    if (targetType === 'skill') return 'skill-quality-loop';
    if (targetType === 'capability') return 'mcp-connector-validation-loop';
    return DEFAULT_LOOP_NAME;
  }

  private fleetTopology(pools: SwarmRealityStatus['fleet_pools']): SwarmRealityStatus['fleet_topology'] {
    const poolMap = new Map(pools.map((pool) => [pool.runtime, pool]));
    const rows = this.db.prepare(`
      SELECT
        wl.*,
        lr.loop_name AS loop_name,
        lr.status AS run_status,
        lr.gates_json AS run_gates_json,
        lr.metadata AS run_metadata,
        lr.goal_id AS goal_id,
        g.objective AS goal_objective,
        g.risk_class AS goal_risk_class
      FROM worker_leases wl
      JOIN loop_runs lr ON lr.id = wl.loop_run_id
      LEFT JOIN goals g ON g.id = lr.goal_id
      WHERE wl.status IN ('prepared', 'running', 'completed', 'failed')
      ORDER BY wl.updated_at DESC, wl.created_at DESC
      LIMIT 80
    `).all() as any[];

    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata || '{}');
      const gates = JSON.parse(row.run_gates_json || '[]') as Array<{ name?: string; status?: string }>;
      const decision = this.workerPoolDecision(row, poolMap, {});
      const failedGate = gates.find((gate) => gate.status === 'fail')?.name || null;
      const latestGate = gates.at(-1)?.name || null;
      const latestEvent = this.db.prepare(`
        SELECT event_type FROM loop_events
        WHERE loop_run_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(row.loop_run_id) as { event_type?: string } | undefined;
      const warnings = metadata.runtime_warnings;

      return {
        goal_id: row.goal_id || null,
        goal_objective: row.goal_objective || null,
        loop_run_id: row.loop_run_id,
        loop_name: row.loop_name,
        run_status: row.run_status,
        lease_id: row.id,
        role: row.role,
        runtime: row.runtime,
        lease_status: row.status,
        artifact_path: metadata.artifact_path || null,
        stdout_path: metadata.stdout_path || null,
        stderr_path: metadata.stderr_path || null,
        warning_count: Array.isArray(warnings) ? warnings.length : 0,
        latest_gate: latestGate,
        failed_gate: failedGate,
        latest_event: latestEvent?.event_type || null,
        next_safe_action: decision.next_action,
        bottleneck_reason: decision.bottleneck_reason,
      };
    });
  }

  private fleetPools(resourceSnapshot: SwarmRealityStatus['resource_snapshot']): SwarmRealityStatus['fleet_pools'] {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT wl.*, lr.metadata AS run_metadata
      FROM worker_leases wl
      LEFT JOIN loop_runs lr ON lr.id = wl.loop_run_id
      WHERE wl.status IN ('prepared', 'running', 'completed', 'failed')
    `).all() as any[];
    const runtimes = ['codex', 'opencode', 'claude', 'gemini', 'editor', 'mock', 'manual'];
    const load = resourceSnapshot.load_average[0] || 0;
    const freeMemoryRatio = resourceSnapshot.total_memory_bytes > 0
      ? resourceSnapshot.free_memory_bytes / resourceSnapshot.total_memory_bytes
      : 0;
    return runtimes.map((runtime) => {
      const leases = rows.filter((row) => row.runtime === runtime);
      const prepared = leases.filter((row) => row.status === 'prepared');
      const running = leases.filter((row) => row.status === 'running');
      const completed24h = leases.filter((row) => row.status === 'completed' && String(row.updated_at) >= since);
      const failed24h = leases.filter((row) => row.status === 'failed' && String(row.updated_at) >= since);
      const runtimeDurations = completed24h
        .map((row) => this.workerRuntimeMs(row))
        .filter((value): value is number => value !== null);
      const tokensUsed24h = completed24h.reduce((sum, row) => {
        const metadata = JSON.parse(row.metadata || '{}');
        const total = Number(metadata.runtime_usage?.total_tokens);
        return Number.isFinite(total) ? sum + total : sum;
      }, 0);
      const tokensPerDiffSamples = completed24h
        .map((row) => {
          const metadata = JSON.parse(row.metadata || '{}');
          const value = Number(metadata.token_efficiency?.tokens_per_diff_line);
          return Number.isFinite(value) && value > 0 ? value : null;
        })
        .filter((value): value is number => value !== null);
      const successfulWorkers = Math.max(1, completed24h.length);
      const totalFinished24h = completed24h.length + failed24h.length;
      const blocked: string[] = [];
      if (runtime !== 'manual' && runtime !== 'mock' && !this.runtimeCommandAvailable(runtime)) {
        blocked.push('runtime_unavailable');
      }
      if (freeMemoryRatio < 0.05) blocked.push('low_free_memory');
      if (load > resourceSnapshot.cpu_threads * 1.5) blocked.push('high_cpu_load');
      const baseConcurrency = runtime === 'manual' ? 0 : Math.max(1, Math.floor(resourceSnapshot.cpu_threads / 4));
      const recommended = blocked.length > 0 ? 0 : Math.max(0, baseConcurrency - running.length);
      const oldestQueuedAgeMs = prepared.length > 0
        ? Math.max(...prepared.map((row) => Date.now() - Date.parse(row.created_at || new Date().toISOString())))
        : null;
      const queueDepthByRisk = prepared.reduce((acc, row) => {
        const metadata = JSON.parse(row.run_metadata || '{}');
        const risk = String(metadata.risk_class || 'unknown');
        acc[risk] = (acc[risk] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      const bottleneck = blocked[0]
        || (prepared.length > 0 && recommended <= 0 ? 'concurrency_exhausted' : null)
        || (prepared.length === 0 ? 'queue_empty' : null);
      return {
        runtime,
        available: blocked.length === 0,
        prepared_leases: prepared.length,
        queued_leases: prepared.length,
        running_leases: running.length,
        completed_24h: completed24h.length,
        failed_24h: failed24h.length,
        average_runtime_ms: runtimeDurations.length > 0
          ? Math.round(runtimeDurations.reduce((sum, value) => sum + value, 0) / runtimeDurations.length)
          : null,
        failure_rate_24h: totalFinished24h > 0 ? failed24h.length / totalFinished24h : 0,
        tokens_used_24h: tokensUsed24h,
        tokens_per_successful_worker: completed24h.length > 0 ? tokensUsed24h / successfulWorkers : null,
        tokens_per_diff_line: tokensPerDiffSamples.length > 0
          ? tokensPerDiffSamples.reduce((sum, value) => sum + value, 0) / tokensPerDiffSamples.length
          : null,
        recommended_concurrency: recommended,
        capacity_used_percent: baseConcurrency > 0 ? Math.min(100, Math.round((running.length / baseConcurrency) * 100)) : 0,
        oldest_queued_age_ms: oldestQueuedAgeMs,
        next_recommended_action: recommended > 0 && prepared.some((row) => row.role === 'checker')
          ? 'execute_checker'
          : recommended > 0 && prepared.length > 0 ? 'execute_maker' : 'wait',
        bottleneck_reason: bottleneck,
        blocked_capacity_reasons: blocked,
        queue_depth_by_risk: queueDepthByRisk,
      };
    });
  }

  private runtimeCommandAvailable(runtime: string): boolean {
    const BIN_ENV: Record<string, { env: string; defaultBin: string }> = {
      codex: { env: 'CODEX_BIN_PATH', defaultBin: 'codex' },
      opencode: { env: 'OPENCODE_BIN_PATH', defaultBin: 'opencode' },
      claude: { env: 'CLAUDE_BIN_PATH', defaultBin: 'claude' },
      gemini: { env: 'GEMINI_BIN_PATH', defaultBin: 'gemini' },
      editor: { env: 'CLINE_BIN_PATH', defaultBin: 'cline' },
    };
    const cfg = BIN_ENV[runtime];
    if (!cfg) return true; // mock/manual do not need an external binary
    const command = process.env[cfg.env] || cfg.defaultBin;
    const cached = runtimeBinCache.get(command);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.available;
    }
    let available = true;
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 1_000 });
    } catch {
      available = false;
    }
    runtimeBinCache.set(command, { available, expiresAt: Date.now() + RUNTIME_BIN_CACHE_TTL_MS });
    return available;
  }

  planWorkerPool(input: WorkerPoolPlanInput = {}): WorkerPoolPlanResult {
    const status = input.simulate_low_capacity ? this.statusForResourceSnapshot(this.lowCapacitySnapshot()) : this.getStatus();
    const pools = new Map(status.fleet_pools.map((pool) => [pool.runtime, pool]));
    const rows = this.workerPoolRows(input.runtime);
    const decisions = rows
      .map((row) => this.workerPoolDecision(row, pools, input))
      .sort((a, b) => b.priority_score - a.priority_score || b.queue_age_ms - a.queue_age_ms);
    const maxWorkers = Math.max(1, Math.min(Number(input.max_workers || 1), 20));
    return {
      decisions,
      eligible_count: decisions.filter((decision) => decision.eligible).length,
      blocked_count: decisions.filter((decision) => !decision.eligible && decision.status === 'prepared').length,
      running_count: decisions.filter((decision) => decision.status === 'running').length,
      max_workers: maxWorkers,
      capacity_snapshot: status.resource_snapshot,
    };
  }

  private statusForResourceSnapshot(resourceSnapshot: SwarmRealityStatus['resource_snapshot']): SwarmRealityStatus {
    const status = this.getStatus();
    const fleetPools = this.fleetPools(resourceSnapshot);
    return {
      ...status,
      resource_snapshot: resourceSnapshot,
      fleet_pools: fleetPools,
      fleet_topology: this.fleetTopology(fleetPools),
    };
  }

  private lowCapacitySnapshot(): SwarmRealityStatus['resource_snapshot'] {
    return {
      cpu_threads: 8,
      total_memory_bytes: 100,
      free_memory_bytes: 1,
      load_average: [99, 99, 99],
      uptime_seconds: os.uptime(),
    };
  }

  async startNextWorker(input: WorkerPoolPlanInput = {}): Promise<WorkerPoolStartResult> {
    const plan = this.planWorkerPool({ ...input, max_workers: 1 });
    const decision = plan.decisions.find((candidate) => candidate.eligible)
      || plan.decisions.find((candidate) => candidate.status === 'prepared') || null;
    if (!decision) {
      this.recordRunnerDecision('worker_pool_start_blocked', null, 'warning', { reason: 'no_eligible_leases', plan });
      return { action: 'blocked', decision, plan };
    }

    if (!decision.eligible) {
      this.recordWorkerManifest({
        loopRunId: decision.loop_run_id,
        leaseId: decision.lease_id,
        action: 'skip',
        decisionId: this.makeDecisionManifestId(decision, 'skip'),
        runtimeContract: this.runtimeContractForLease(decision.effective_runtime),
        capacitySnapshot: this.currentCapacitySnapshot(),
        budgetSnapshot: {
          max_workers: plan.max_workers,
          timeout_ms: input.timeout_ms,
          diff_max_lines: input.diff_max_lines,
        },
        gateRefs: ['worker_pool_plan'],
        blockedReasons: decision.blocked_reasons,
        metadata: {
          worker_role: decision.role,
          worker_runtime: decision.effective_runtime,
          blocked_reason_count: decision.blocked_reasons.length,
          next_action: decision.next_action,
          reason: 'worker_pool_decision_blocked',
        },
      });
      this.recordRunnerDecision('worker_pool_worker_blocked', decision.loop_run_id, 'warning', { decision, plan });
      return { action: 'blocked', decision, plan };
    }

    return this.startWorkerDecision(decision, plan, input);
  }

  private async startWorkerDecision(
    decision: WorkerPoolDecision,
    plan: WorkerPoolPlanResult,
    input: WorkerPoolPlanInput = {}
  ): Promise<WorkerPoolStartResult> {
    const traceId = `worker-pool-${decision.loop_run_id}-${decision.lease_id}-${Date.now()}`;
    this.assurance.createTraceSpan({
      trace_id: traceId,
      loop_run_id: decision.loop_run_id,
      span_type: 'worker',
      name: `worker-pool:${decision.next_action}:start`,
      status: 'running',
      evidence_ref: `worker_lease:${decision.lease_id}`,
      metadata: { decision },
    });
    this.recordWorkerManifest({
      loopRunId: decision.loop_run_id,
      leaseId: decision.lease_id,
      action: 'start',
      decisionId: this.makeDecisionManifestId(decision, 'start'),
      runtimeContract: this.runtimeContractForLease(decision.effective_runtime),
      capacitySnapshot: this.currentCapacitySnapshot(),
      budgetSnapshot: {
        max_workers: plan.max_workers,
        timeout_ms: input.timeout_ms,
        diff_max_lines: input.diff_max_lines,
      },
      gateRefs: ['worker_pool_start'],
      blockedReasons: [],
      metadata: {
        worker_role: decision.role,
        worker_runtime: decision.effective_runtime,
        next_action: decision.next_action,
      },
    });

    try {
      let execution = decision.next_action === 'execute_checker'
        ? await this.loops.executeChecker(decision.loop_run_id, {
          lease_id: decision.lease_id,
          runtime: decision.effective_runtime as Exclude<WorkerRuntime, 'manual'>,
          timeout_ms: input.timeout_ms,
          skip_permissions: input.skip_permissions,
        })
        : await this.loops.executeWorker(decision.loop_run_id, {
          lease_id: decision.lease_id,
          timeout_ms: input.timeout_ms,
          diff_max_lines: input.diff_max_lines,
          skip_permissions: input.skip_permissions,
        });
      if (decision.next_action === 'execute_maker') {
        const checked = this.loops.runDeterministicChecks(decision.loop_run_id, {
          lease_id: decision.lease_id,
          timeout_ms: input.timeout_ms,
        });
        if (checked) execution = { ...execution, run: checked.run, lease: checked.lease };
      }

      this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: decision.loop_run_id,
        span_type: 'worker',
        name: `worker-pool:${decision.next_action}:complete`,
        status: 'ok',
        evidence_ref: `worker_lease:${decision.lease_id}`,
        metadata: { decision },
      });
      this.recordWorkerManifest({
        loopRunId: decision.loop_run_id,
        leaseId: decision.lease_id,
        action: 'complete',
        decisionId: this.makeDecisionManifestId(decision, 'complete'),
        runtimeContract: this.runtimeContractForLease(decision.effective_runtime),
        capacitySnapshot: this.currentCapacitySnapshot(),
        budgetSnapshot: {
          max_workers: plan.max_workers,
          timeout_ms: input.timeout_ms,
          diff_max_lines: input.diff_max_lines,
        },
        gateRefs: ['worker_pool_start'],
        blockedReasons: [],
        metadata: {
          worker_role: decision.role,
          worker_runtime: decision.effective_runtime,
          next_action: decision.next_action,
          execution_status: execution.lease.status,
        },
      });
      this.recordRunnerDecision('worker_pool_worker_started', decision.loop_run_id, 'info', { decision, trace_id: traceId });
      this.syncBacklogFromFleet({ loop_run_ids: [decision.loop_run_id] });
      return { action: 'started', decision, plan, execution };
    } catch (error) {
      this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: decision.loop_run_id,
        span_type: 'worker',
        name: `worker-pool:${decision.next_action}:failed`,
        status: 'error',
        evidence_ref: `worker_lease:${decision.lease_id}`,
        metadata: { decision, error: error instanceof Error ? error.message : String(error) },
      });
      this.recordWorkerManifest({
        loopRunId: decision.loop_run_id,
        leaseId: decision.lease_id,
        action: 'fail',
        decisionId: this.makeDecisionManifestId(decision, 'fail'),
        runtimeContract: this.runtimeContractForLease(decision.effective_runtime),
        capacitySnapshot: this.currentCapacitySnapshot(),
        budgetSnapshot: {
          max_workers: plan.max_workers,
          timeout_ms: input.timeout_ms,
          diff_max_lines: input.diff_max_lines,
        },
        gateRefs: ['worker_pool_start'],
        blockedReasons: [error instanceof Error ? error.message : String(error)],
        metadata: {
          worker_role: decision.role,
          worker_runtime: decision.effective_runtime,
          next_action: decision.next_action,
          execution_status: 'failed',
        },
      });
      this.recordRunnerDecision('worker_pool_worker_failed', decision.loop_run_id, 'warning', {
        decision,
        trace_id: traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.syncBacklogFromFleet({ loop_run_ids: [decision.loop_run_id] });
      throw error;
    }
  }

  async drainWorkerPool(input: WorkerPoolPlanInput = {}): Promise<WorkerPoolDrainResult> {
    const maxWorkers = Math.max(1, Math.min(Number(input.max_workers || 1), 20));
    const started: WorkerPoolStartResult[] = [];

    while (started.length < maxWorkers) {
      const plan = this.planWorkerPool(input);
      const runtimeSlots = new Map<string, number>();
      for (const pool of this.getStatus().fleet_pools) {
        runtimeSlots.set(pool.runtime, input.ignore_capacity ? maxWorkers : Math.max(0, pool.recommended_concurrency));
      }

      const selected: WorkerPoolDecision[] = [];
      for (const decision of plan.decisions) {
        if (!decision.eligible) continue;
        if (started.length + selected.length >= maxWorkers) break;
        const slots = runtimeSlots.get(decision.effective_runtime) ?? 0;
        if (slots <= 0) continue;
        runtimeSlots.set(decision.effective_runtime, slots - 1);
        selected.push(decision);
      }
      if (selected.length === 0) break;

      const settled = await Promise.allSettled(
        selected.map((decision) => this.startWorkerDecision(decision, plan, input))
      );
      const fulfilled = settled
        .filter((result): result is PromiseFulfilledResult<WorkerPoolStartResult> => result.status === 'fulfilled')
        .map((result) => result.value);
      started.push(...fulfilled);
      for (const result of settled) {
        if (result.status === 'rejected') {
          this.recordRunnerDecision('worker_pool_parallel_worker_failed', null, 'warning', {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
      if (fulfilled.length === 0) break;
      // A checker can become eligible only after a maker wave completes, so drain
      // in bounded waves instead of assuming one static plan can express the whole pipeline.
      if (started.length >= maxWorkers) break;
      if (fulfilled.length < selected.length) break;
    }
    return {
      action: 'drained',
      started,
      final_plan: this.planWorkerPool(input),
    };
  }

  stopWorkerLease(leaseId: string): { lease: WorkerLeaseRecord; event: { event_type: string; level: string; message: string } } {
    const row = this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(leaseId) as any;
    if (!row) {
      throw new Error('WORKER_LEASE_NOT_FOUND');
    }
    if (!['prepared', 'running'].includes(row.status)) {
      throw new Error('WORKER_LEASE_NOT_STOPPABLE');
    }
    const now = new Date().toISOString();
    const metadata = {
      ...JSON.parse(row.metadata || '{}'),
      stopped_by_runner: true,
      stopped_at: now,
      stop_mode: row.status === 'running' ? 'best_effort_no_process_handle' : 'cancel_prepared',
    };
    let stopResult: { stopMode: 'kill' | 'stop' | 'best_effort_no_process_handle'; killAttempted: boolean } | null = null;
    if (row.status === 'running') {
      stopResult = this.loops.runtimeCommand.stopWorkerLeaseRuntime(leaseId);
      metadata.stop_mode = stopResult.stopMode;
      metadata.runtime_stop_attempted = stopResult.killAttempted;
      metadata.runtime_stop_requested_at = now;
    }
    this.db.prepare('UPDATE worker_leases SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run('cancelled', JSON.stringify(metadata), now, leaseId);
    this.recordWorkerManifest({
      loopRunId: row.loop_run_id,
      leaseId,
      action: 'stop',
      metadata: {
        worker_runtime: row.runtime,
        previous_status: row.status,
        stop_mode: metadata.stop_mode,
        stopped_by_runner: true,
        stopped_at: now,
      },
      capacitySnapshot: this.currentCapacitySnapshot(),
      budgetSnapshot: {
        stop_requested_at: now,
        requested_by: 'swarm_status_service',
      },
      runtimeContract: this.runtimeContractForLease(String(row.runtime)),
      decisionId: `stop:${row.loop_run_id}:${leaseId}:${now}`,
      gateRefs: ['worker_stop_requested'],
      blockedReasons: [],
    });
    this.recordRunnerDecision('worker_pool_worker_stopped', row.loop_run_id, 'warning', {
      lease_id: leaseId,
      previous_status: row.status,
      stop_mode: metadata.stop_mode,
    });
    return {
      lease: this.parseWorkerLease(this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(leaseId)),
      event: {
        event_type: 'worker_pool_worker_stopped',
        level: 'warning',
        message: `Worker lease ${leaseId} stopped by worker pool runner.`,
      },
    };
  }

  tickScheduler(input: SchedulerTickInput = {}): SchedulerTickResult {
    const maxItems = Math.max(1, Math.min(Number(input.max_items || 10), 100));
    const workItemIds = this.requestedWorkItemIds(input.work_item_ids);
    const planned = input.plan_triaged ? this.planTriagedWorkItems(maxItems, workItemIds) : [];
    const prepared = input.prepare_planned ? this.preparePlannedWorkItems(input, maxItems, workItemIds) : [];
    const rows = this.db.prepare(`
      SELECT * FROM loop_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 100
    `).all() as any[];

    const created: WorkItemRecord[] = [];
    let skippedExisting = 0;
    let inspected = 0;

    for (const row of rows) {
      if (created.length >= maxItems) break;
      inspected += 1;
      const metadata = JSON.parse(row.metadata || '{}');
      const findings = JSON.parse(row.findings_json || '[]') as Array<Record<string, any>>;
      for (const finding of findings) {
        if (created.length >= maxItems) break;
        if (!finding?.id || !finding?.message) continue;
        const sourceRef = `${row.id}:${finding.id}`;
        const result = this.workItems.createIfMissingBySourceRef({
          title: this.titleForFinding(row.loop_name, finding),
          description: String(finding.suggested_fix || finding.message),
          source: 'loop_finding',
          source_ref: sourceRef,
          risk_class: this.riskFor(row.loop_name, metadata, finding),
          value_score: finding.severity === 'warning' ? 70 : 50,
          confidence: 0.7,
          recommended_loop: row.loop_name,
          metadata: {
            loop_run_id: row.id,
            finding_id: finding.id,
            finding_type: finding.type,
            file: finding.file,
            line: finding.line || null,
            evidence: finding.evidence || null,
            state_file: row.state_file || null,
          },
        });
        if (result.created) {
          created.push(result.work_item);
        } else {
          skippedExisting += 1;
        }
      }
    }

    return {
      created_work_items: created,
      planned_work_items: planned,
      prepared_work_items: prepared,
      skipped_existing: skippedExisting,
      inspected_loop_runs: inspected,
      leases_created: prepared.reduce((sum, item) => sum + Number(item.metadata.prepared_leases_created || 0), 0),
    };
  }

  syncBacklogFromFleet(input: { loop_run_ids?: string[] } = {}): BacklogFleetSyncResult {
    const loopRunIds = this.requestedWorkItemIds(input.loop_run_ids);
    const candidates = this.workItems.list({ status: 'leased', limit: 500 })
      .filter((item) => loopRunIds.length === 0 || loopRunIds.includes(String(item.metadata.loop_run_id || '')));
    const updated: WorkItemRecord[] = [];

    for (const item of candidates) {
      const loopRunId = String(item.metadata.loop_run_id || '');
      if (!loopRunId) continue;
      const outcome = this.workItemFleetOutcome(loopRunId);
      if (!outcome) continue;

      updated.push(this.workItems.update(item.id, {
        status: outcome.status,
        metadata: {
          ...item.metadata,
          fleet_synced_at: new Date().toISOString(),
          fleet_outcome: outcome,
        },
      }));
    }

    return {
      inspected_work_items: candidates.length,
      updated_work_items: updated,
    };
  }

  private workItemFleetOutcome(loopRunId: string): { status: 'done' | 'blocked'; loop_run_id: string; loop_status: string; reason: string; evidence: Record<string, unknown> } | null {
    const run = this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(loopRunId) as any | undefined;
    if (!run) return null;
    const leases = this.db.prepare('SELECT * FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at ASC').all(loopRunId) as any[];
    const parsedLeases = leases.map((lease) => ({ ...lease, metadata: JSON.parse(lease.metadata || '{}') }));
    const failedLease = parsedLeases.find((lease) => lease.status === 'failed');
    if (failedLease) {
      return this.fleetOutcome('blocked', run, parsedLeases, `lease_failed:${failedLease.role}`);
    }

    const rejectedChecker = parsedLeases.find((lease) => (
      lease.role === 'checker'
      && ['needs_revision', 'rejected', 'insufficient_evidence'].includes(String(lease.metadata.verdict || ''))
    ));
    if (rejectedChecker) {
      return this.fleetOutcome('blocked', run, parsedLeases, `checker_${rejectedChecker.metadata.verdict}`);
    }

    if (['failed', 'cancelled', 'interrupted', 'escalated'].includes(String(run.status))) {
      return this.fleetOutcome('blocked', run, parsedLeases, `loop_${run.status}`);
    }

    const makers = parsedLeases.filter((lease) => lease.role === 'maker' && !lease.metadata.superseded_by_maker_lease_id);
    const completedMakers = makers.filter((lease) => lease.status === 'completed');
    if (makers.length === 0 || completedMakers.length !== makers.length) return null;

    const acceptedCheckerForEveryMaker = completedMakers.every((maker) => parsedLeases.some((lease) => (
      lease.role === 'checker'
      && lease.metadata.maker_lease_id === maker.id
      && lease.metadata.verdict === 'accepted'
      && lease.status === 'completed'
    )));
    if (!acceptedCheckerForEveryMaker) return null;

    const verified = this.loops.verifyLoopRun(loopRunId);
    if (verified.run.status === 'blocked') {
      return this.fleetOutcome('blocked', verified.run, parsedLeases, 'verification_blocked');
    }
    if (['ready_for_human_merge', 'completed'].includes(verified.run.status)) {
      return this.fleetOutcome('done', verified.run, parsedLeases, verified.run.status);
    }
    return null;
  }

  private fleetOutcome(status: 'done' | 'blocked', run: any, leases: any[], reason: string) {
    return {
      status,
      loop_run_id: run.id,
      loop_status: run.status,
      reason,
      evidence: {
        gates: JSON.parse(run.gates_json || '[]'),
        leases: leases.map((lease) => ({
          id: lease.id,
          role: lease.role,
          status: lease.status,
          runtime: lease.runtime,
          verdict: lease.metadata?.verdict || null,
          stdout_path: lease.metadata?.stdout_path || null,
          stderr_path: lease.metadata?.stderr_path || null,
        })),
      },
    };
  }

  private planTriagedWorkItems(maxItems: number, workItemIds: string[]): WorkItemRecord[] {
    const candidates = this.workItemsForStatus('triaged', maxItems, workItemIds);
    const planned: WorkItemRecord[] = [];
    for (const item of candidates) {
      if (planned.length >= maxItems) break;
      if (item.parent_goal_id) {
        continue;
      }
      planned.push(this.workItems.convertToGoal(item.id).work_item);
    }
    return planned;
  }

  private preparePlannedWorkItems(
    input: SchedulerTickInput,
    maxItems: number,
    workItemIds: string[]
  ): WorkItemRecord[] {
    const candidates = this.workItemsForStatus('planned', maxItems, workItemIds);
    const prepared: WorkItemRecord[] = [];
    const runtime = input.runtime || 'manual';
    const maxAssignments = Math.max(1, Math.min(Number(input.max_assignments_per_item || 1), 5));

    for (const item of candidates) {
      if (prepared.length >= maxItems) break;
      if (!item.parent_goal_id) continue;
      if (item.metadata.loop_run_id) continue;

      const repositoryPath = String(input.repository_path || item.metadata.repository_path || '').trim();
      if (!repositoryPath) {
        prepared.push(this.workItems.update(item.id, {
          status: 'blocked',
          metadata: {
            ...item.metadata,
            prepare_blocked_reason: 'repository_path_required',
            prepare_blocked_at: new Date().toISOString(),
          },
        }));
        continue;
      }

      try {
        const run = this.loops.startLoop({
          goal_id: item.parent_goal_id,
          loop_name: this.loopNameForWorkItem(item),
          repository_path: repositoryPath,
        });
        this.ensureWorkItemFinding(run.id, item);
        const continued = this.loops.continueLoopRun(run.id, {
          max_assignments: maxAssignments,
          runtime,
        });
        prepared.push(this.workItems.update(item.id, {
          status: 'leased',
          assigned_runtime: runtime,
          metadata: {
            ...item.metadata,
            repository_path: repositoryPath,
            loop_run_id: run.id,
            prepared_at: new Date().toISOString(),
            prepared_leases_created: continued.leases.length,
          },
        }));
      } catch (error) {
        prepared.push(this.workItems.update(item.id, {
          status: 'blocked',
          metadata: {
            ...item.metadata,
            repository_path: repositoryPath || null,
            prepare_blocked_reason: error instanceof Error ? error.message : String(error),
            prepare_blocked_at: new Date().toISOString(),
          },
        }));
      }
    }

    return prepared;
  }

  private ensureWorkItemFinding(loopRunId: string, item: WorkItemRecord): void {
    const row = this.db.prepare('SELECT findings_json, plan_json FROM loop_runs WHERE id = ?').get(loopRunId) as any | undefined;
    if (!row) return;

    const findings = JSON.parse(row.findings_json || '[]') as Array<Record<string, any>>;
    const syntheticFindingId = `work-item-${item.id}`;
    if (findings.some((finding) => finding.id === syntheticFindingId || finding.metadata?.work_item_id === item.id)) {
      return;
    }

    const finding = {
      id: syntheticFindingId,
      type: 'work_item_assignment',
      severity: item.risk_class === 'low' ? 'info' : 'warning',
      file: String(item.metadata.file || 'WORK_ITEM'),
      line: item.metadata.line || null,
      message: item.title,
      evidence: item.source_ref ? `${item.source}:${item.source_ref}` : item.source,
      suggested_fix: item.description,
      metadata: {
        work_item_id: item.id,
        source: item.source,
        source_ref: item.source_ref,
        direct_assignment: true,
      },
    };
    const nextFindings = [finding, ...findings];
    const plan = JSON.parse(row.plan_json || '{}') as Record<string, unknown>;
    const nextPlan = {
      ...plan,
      direct_work_item_assignment: true,
      work_item_id: item.id,
    };

    this.db.prepare(`
      UPDATE loop_runs
      SET findings_json = ?, plan_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(nextFindings), JSON.stringify(nextPlan), new Date().toISOString(), loopRunId);
  }

  private requestedWorkItemIds(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return [...new Set(input.map((id) => String(id).trim()).filter(Boolean))].slice(0, 100);
  }

  private workItemsForStatus(status: BacklogStatus, maxItems: number, workItemIds: string[]): WorkItemRecord[] {
    if (workItemIds.length === 0) {
      return this.workItems.list({ status, limit: maxItems });
    }
    const items: WorkItemRecord[] = [];
    for (const id of workItemIds) {
      try {
        const item = this.workItems.get(id);
        if (item.status === status) items.push(item);
      } catch {
        continue;
      }
      if (items.length >= maxItems) break;
    }
    return items;
  }

  private loopNameForWorkItem(item: WorkItemRecord): LoopName {
    const candidate = String(item.recommended_loop || item.metadata.recommended_loop || '').trim();
    return SUPPORTED_LOOP_NAMES.has(candidate as LoopName) ? candidate as LoopName : DEFAULT_LOOP_NAME;
  }

  private workerPoolRows(runtime?: WorkerRuntime): any[] {
    const rows = this.db.prepare(`
      SELECT
        wl.*,
        lr.status AS run_status,
        lr.gates_json AS run_gates_json,
        lr.metadata AS run_metadata,
        lr.goal_id AS goal_id,
        g.risk_class AS goal_risk_class
      FROM worker_leases wl
      JOIN loop_runs lr ON lr.id = wl.loop_run_id
      LEFT JOIN goals g ON g.id = lr.goal_id
      WHERE wl.status IN ('prepared', 'running')
      ORDER BY wl.created_at ASC
    `).all() as any[];
    if (!runtime) {
      return rows;
    }
    return rows.filter((row) => this.effectiveRuntime(row, { runtime, checker_runtime: runtime === 'manual' ? undefined : runtime }) === runtime);
  }

  private workerPoolDecision(row: any, pools: Map<string, SwarmRealityStatus['fleet_pools'][number]>, input: WorkerPoolPlanInput): WorkerPoolDecision {
    const role = row.role as RunnerLeaseRole;
    const effectiveRuntime = this.effectiveRuntime(row, input);
    const runMetadata = JSON.parse(row.run_metadata || '{}');
    const riskClass = this.resolveRiskClass(row, runMetadata);
    const gates = JSON.parse(row.run_gates_json || '[]') as Array<{ name?: string; status?: string }>;
    const pool = pools.get(effectiveRuntime);
    const blocked: string[] = [];
    const queueAgeMs = row.created_at ? Math.max(0, Date.now() - Date.parse(row.created_at)) : 0;

    if (row.status === 'running') blocked.push('already_running');
    if (row.status !== 'prepared') blocked.push('lease_not_prepared');
    if (!['maker', 'checker'].includes(role)) blocked.push(`${role}_requires_human_or_specialized_runner`);
    if (effectiveRuntime === 'manual') blocked.push(role === 'checker' ? 'manual_checker_runtime_required' : 'manual_runtime_requires_human');
    if (['high', 'critical'].includes(riskClass) && !input.allow_high_risk) blocked.push('high_risk_requires_security_or_human_gate');
    if (['blocked', 'escalated', 'cancelled', 'completed', 'failed'].includes(String(row.run_status))) blocked.push(`loop_status_${row.run_status}`);
    if (gates.some((gate) => gate.status === 'fail')) blocked.push('failed_gate_present');
    blocked.push(...this.evaluatePolicyGates(row, runMetadata, gates, riskClass));
    blocked.push(...this.evaluateCapabilityRouting(row, runMetadata, riskClass, role, effectiveRuntime));
    if (!pool) {
      blocked.push('runtime_pool_missing');
    } else if (!input.ignore_capacity) {
      blocked.push(...pool.blocked_capacity_reasons);
      if (pool.recommended_concurrency <= 0) blocked.push('concurrency_exhausted');
    }
    if (role === 'checker') {
      const metadata = JSON.parse(row.metadata || '{}');
      const makerLeaseId = metadata.maker_lease_id;
      const maker = makerLeaseId ? this.db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(makerLeaseId) as { status?: string } | undefined : null;
      if (!makerLeaseId) blocked.push('checker_maker_link_missing');
      if (makerLeaseId && maker?.status !== 'completed') blocked.push('checker_maker_not_completed');
    }

    const blockedReasons = [...new Set(blocked)];
    const nextAction = blockedReasons.length > 0
      ? (['high_risk_requires_security_or_human_gate', 'manual_runtime_requires_human', 'manual_checker_runtime_required'].some((reason) => blockedReasons.includes(reason)) ? 'human_review' : 'wait')
      : role === 'checker' ? 'execute_checker' : 'execute_maker';
    return {
      lease_id: row.id,
      loop_run_id: row.loop_run_id,
      role,
      runtime: row.runtime,
      effective_runtime: effectiveRuntime,
      status: row.status,
      risk_class: riskClass,
      eligible: blockedReasons.length === 0,
      blocked_reasons: blockedReasons,
      priority_score: this.workerPriorityScore(role, riskClass, queueAgeMs, blockedReasons.length),
      queue_age_ms: queueAgeMs,
      bottleneck_reason: blockedReasons[0] || null,
      next_action: nextAction,
    };
  }

  private effectiveRuntime(row: any, input: WorkerPoolPlanInput): WorkerRuntime {
    if (row.role === 'checker' && row.runtime === 'manual' && input.checker_runtime) {
      return input.checker_runtime;
    }
    return row.runtime as WorkerRuntime;
  }

  private parseWorkerLease(row: any): WorkerLeaseRecord {
    return {
      id: row.id,
      loop_run_id: row.loop_run_id,
      role: row.role,
      runtime: row.runtime,
      status: row.status,
      finding_id: row.finding_id || null,
      worktree_path: row.worktree_path || null,
      branch_name: row.branch_name || null,
      budget: JSON.parse(row.budget_json || '{}'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      parent_lease_id: row.parent_lease_id ?? null,
      spawn_tree_id: row.spawn_tree_id ?? null,
      depth: typeof row.depth === 'number' ? row.depth : Number(row.depth ?? 0),
      spawned_by_agent_id: row.spawned_by_agent_id ?? null,
    };
  }

  private evaluatePolicyGates(
    row: any,
    runMetadata: Record<string, unknown>,
    gates: Array<{ name?: string; status?: string }>,
    riskClass: GovernanceRiskClass
  ): string[] {
    const blocked: string[] = [];
    const runtimeWarnings = this.toStringArray(runMetadata.runtime_warnings || row.runtime_warnings);
    if (gates.some((gate) => gate.status === 'fail')) {
      blocked.push('failed_gate_present');
    }
    if (['high', 'critical'].includes(riskClass) && runtimeWarnings.length > 0) {
      blocked.push('runtime_warning_gate_failed');
    }
    return blocked;
  }

  private evaluateCapabilityRouting(
    row: any,
    runMetadata: Record<string, unknown>,
    riskClass: GovernanceRiskClass,
    role: RunnerLeaseRole,
    runtime: string
  ): string[] {
    const blocked: string[] = [];
    const leaseMetadata = this.parseJsonSafe(row.metadata || '{}');
    const requiredCapabilityIds = this.resolveCapabilityRequirements(runMetadata, leaseMetadata);
    if (!requiredCapabilityIds.length) {
      return blocked;
    }

    const capabilities = requiredCapabilityIds
      .map((capabilityId) => {
        try {
          return this.intelligence.getCapability(capabilityId);
        } catch {
          blocked.push(`capability_not_found:${capabilityId}`);
          return null;
        }
      })
      .filter((capability) => capability !== null);

    for (const capability of capabilities) {
      if (!capability.live_route_allowed) {
        blocked.push(`capability_not_live:${capability.id}`);
      }
      if (!this.isRiskWithinCapability(riskClass, capability.risk_ceiling)) {
        blocked.push(`capability_risk_ceiling_exceeded:${capability.id}`);
      }
      const action = `${role === 'security_checker' ? 'security_checker' : role}:${runtime}`;
      if (capability.forbidden_actions.includes(action)) {
        blocked.push(`capability_forbids_action:${capability.id}:${action}`);
      }
    }

    return blocked;
  }

  private resolveCapabilityRequirements(runMetadata: Record<string, unknown>, leaseMetadata: Record<string, unknown>): string[] {
    return this.uniqueSortedStrings([
      ...this.toStringArray(runMetadata.capability_ids),
      ...this.toStringArray(runMetadata.required_capability_ids),
      ...this.toStringArray(leaseMetadata.capability_ids),
      ...this.toStringArray(leaseMetadata.required_capability_ids),
    ]);
  }

  private isRiskWithinCapability(riskClass: GovernanceRiskClass, riskCeiling: string): boolean {
    const ordered: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    return ordered[riskClass] <= ordered[riskCeiling];
  }

  private toStringArray(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((candidate) => candidate.trim())
        .filter(Boolean);
    }
    return [];
  }

  private uniqueSortedStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  }

  private parseJsonSafe(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private assertAgentExists(agentId: string): void {
    if (!this.db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId)) {
      throw new Error('SWARM_HANDOFF_AGENT_NOT_FOUND');
    }
  }

  private workerPriorityScore(role: RunnerLeaseRole, riskClass: string, queueAgeMs: number, blockedReasonCount: number): number {
    if (blockedReasonCount > 0) return 0;
    const roleScore = role === 'checker' ? 500 : role === 'maker' ? 300 : 100;
    const riskScore = riskClass === 'low' ? 60 : riskClass === 'medium' ? 40 : 10;
    const ageScore = Math.min(120, Math.floor(queueAgeMs / 60_000));
    return roleScore + riskScore + ageScore;
  }

  private workerRuntimeMs(row: any): number | null {
    const metadata = JSON.parse(row.metadata || '{}');
    const started = Date.parse(String(metadata.started_at || row.created_at || ''));
    const completed = Date.parse(String(metadata.completed_at || row.updated_at || ''));
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
      return null;
    }
    return completed - started;
  }

  private makeDecisionManifestId(decision: WorkerPoolDecision, action: 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete'): string {
    return `${action}:${decision.loop_run_id}:${decision.lease_id}:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
  }

  private resolveRiskClass(row: any, runMetadata: Record<string, unknown>): GovernanceRiskClass {
    const candidate = String(runMetadata.risk_class || row.goal_risk_class || 'low');
    return candidate === 'medium' || candidate === 'high' || candidate === 'critical' ? candidate : 'low';
  }

  private recordRunnerDecision(eventType: string, loopRunId: string | null, level: 'debug' | 'info' | 'warning' | 'error' | 'critical', metadata: Record<string, unknown>) {
    if (!loopRunId) {
      return;
    }
    this.db.prepare(`
      INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      loopRunId,
      eventType,
      level,
      `Worker pool runner recorded ${eventType}.`,
      JSON.stringify(metadata),
      new Date().toISOString()
    );
  }

  private titleForFinding(loopName: string, finding: Record<string, any>): string {
    const file = finding.file ? ` in ${finding.file}` : '';
    return `${loopName}: ${String(finding.message).replace(/\.$/, '')}${file}`;
  }

  private riskFor(loopName: string, metadata: Record<string, any>, finding: Record<string, any>): 'low' | 'medium' | 'high' | 'critical' {
    const metadataRisk = metadata.risk_class;
    if (['low', 'medium', 'high', 'critical'].includes(metadataRisk)) {
      return metadataRisk;
    }
    if (/(security|policy|auth|secret|token|credential)/i.test(`${loopName} ${finding.type} ${finding.message} ${finding.suggested_fix}`)) {
      return 'high';
    }
    if (/(skill|mcp|okf)/i.test(loopName)) {
      return 'medium';
    }
    return 'low';
  }

  private backlogCounts(): Record<BacklogStatus, number> {
    const result: Record<BacklogStatus, number> = {
      candidate: 0,
      triaged: 0,
      planned: 0,
      leased: 0,
      blocked: 0,
      done: 0,
      discarded: 0,
    };
    const rows = this.db.prepare('SELECT status, COUNT(*) as count FROM work_items GROUP BY status').all() as any[];
    for (const row of rows) {
      if (row.status in result) {
        result[row.status as BacklogStatus] = row.count;
      }
    }
    return result;
  }

  private countRows(query: string): number {
    return ((this.db.prepare(query).get() as any)?.count || 0) as number;
  }

  private currentCapacitySnapshot() {
    return {
      cpu_threads: os.cpus().length,
      total_memory_bytes: os.totalmem(),
      free_memory_bytes: os.freemem(),
      load_average: os.loadavg(),
      uptime_seconds: os.uptime(),
    };
  }

  private runtimeContractForLease(runtime: string) {
    const command = runtime === 'codex'
      ? process.env.CODEX_BIN_PATH || 'codex'
      : runtime === 'opencode'
        ? process.env.OPENCODE_BIN_PATH || 'opencode'
        : process.env.OPENCODE_BIN_PATH || process.env.CODEX_BIN_PATH || runtime;
    return {
      runtime,
      command,
      status: 'manual_probe',
      available: true,
      supports_json_events: true,
      supports_usage_parsing: true,
      supports_timeout_kill: true,
    };
  }

  private recordWorkerManifest(input: {
    loopRunId: string | null;
    leaseId: string;
    action: 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';
    decisionId: string;
    runtimeContract: Record<string, unknown>;
    capacitySnapshot: Record<string, unknown>;
    budgetSnapshot: Record<string, unknown>;
    gateRefs: string[];
    blockedReasons: string[];
    metadata: Record<string, unknown>;
  }) {
    if (!input.loopRunId) {
      return;
    }
    try {
      this.db.prepare(`
        INSERT INTO swarm_runner_manifests (
          id, decision_id, lease_id, loop_run_id, action, policy_version,
          runtime_contract_json, capacity_snapshot_json, budget_snapshot_json,
          gate_refs_json, blocked_reasons_json, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.decisionId,
        input.leaseId,
        input.loopRunId,
        input.action,
        'worker-pool-runtime-v1',
        JSON.stringify(input.runtimeContract),
        JSON.stringify(input.capacitySnapshot),
        JSON.stringify(input.budgetSnapshot),
        JSON.stringify(input.gateRefs),
        JSON.stringify(input.blockedReasons),
        JSON.stringify(input.metadata),
        new Date().toISOString()
      );
    } catch {
      // best-effort evidence write for stop transitions
    }
  }
}
