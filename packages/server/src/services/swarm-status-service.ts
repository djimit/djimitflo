import os from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { WorkItemService, type WorkItemRecord } from './work-item-service';
import { LoopService, type LoopName, type WorkerLeaseRecord } from './loop-service';
import { AgentAssuranceService } from './agent-assurance-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';

type BacklogStatus = 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';
type WorkerRuntime = 'codex' | 'opencode' | 'mock' | 'manual';
type GovernanceRiskClass = 'low' | 'medium' | 'high' | 'critical';
type RunnerLeaseRole = 'maker' | 'checker' | 'security_checker' | 'planner' | 'memory_curator' | 'governance_guard';
const DEFAULT_LOOP_NAME: LoopName = 'doc-drift-and-small-fix-loop';
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
    tokens_used_24h: number;
    tokens_per_successful_worker: number | null;
    recommended_concurrency: number;
    blocked_capacity_reasons: string[];
    queue_depth_by_risk: Record<string, number>;
  }>;
  reality_check: {
    agent_count_is_registry_only: boolean;
    active_execution_requires_runtime_evidence: boolean;
  };
}

export interface SchedulerTickResult {
  created_work_items: WorkItemRecord[];
  planned_work_items: WorkItemRecord[];
  prepared_work_items: WorkItemRecord[];
  skipped_existing: number;
  inspected_loop_runs: number;
  leases_created: number;
}

export interface WorkerPoolPlanInput {
  runtime?: WorkerRuntime;
  checker_runtime?: Exclude<WorkerRuntime, 'manual'>;
  max_workers?: number;
  timeout_ms?: number;
  diff_max_lines?: number;
  allow_high_risk?: boolean;
  ignore_capacity?: boolean;
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

export class SwarmStatusService {
  private workItems: WorkItemService;
  private loops: LoopService;
  private assurance: AgentAssuranceService;
  private intelligence: SwarmIntelligenceService;

  constructor(private db: Database, private options: SwarmStatusOptions = {}) {
    this.workItems = new WorkItemService(db);
    this.loops = new LoopService(db);
    this.assurance = new AgentAssuranceService(db);
    this.intelligence = new SwarmIntelligenceService(db);
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
      fleet_pools: this.fleetPools(resourceSnapshot),
      reality_check: {
        agent_count_is_registry_only: agents.length !== liveAgents.length,
        active_execution_requires_runtime_evidence: true,
      },
    };
  }

  private fleetPools(resourceSnapshot: SwarmRealityStatus['resource_snapshot']): SwarmRealityStatus['fleet_pools'] {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT wl.*, lr.metadata AS run_metadata
      FROM worker_leases wl
      LEFT JOIN loop_runs lr ON lr.id = wl.loop_run_id
      WHERE wl.status IN ('prepared', 'running', 'completed', 'failed')
    `).all() as any[];
    const runtimes = ['codex', 'opencode', 'mock', 'manual'];
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
      const tokensUsed24h = completed24h.reduce((sum, row) => {
        const metadata = JSON.parse(row.metadata || '{}');
        const total = Number(metadata.runtime_usage?.total_tokens);
        return Number.isFinite(total) ? sum + total : sum;
      }, 0);
      const successfulWorkers = Math.max(1, completed24h.length);
      const blocked: string[] = [];
      if (runtime !== 'manual' && runtime !== 'mock' && !this.runtimeCommandAvailable(runtime)) {
        blocked.push('runtime_unavailable');
      }
      if (freeMemoryRatio < 0.05) blocked.push('low_free_memory');
      if (load > resourceSnapshot.cpu_threads * 1.5) blocked.push('high_cpu_load');
      const baseConcurrency = runtime === 'manual' ? 0 : Math.max(1, Math.floor(resourceSnapshot.cpu_threads / 4));
      const recommended = blocked.length > 0 ? 0 : Math.max(0, baseConcurrency - running.length);
      const queueDepthByRisk = prepared.reduce((acc, row) => {
        const metadata = JSON.parse(row.run_metadata || '{}');
        const risk = String(metadata.risk_class || 'unknown');
        acc[risk] = (acc[risk] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      return {
        runtime,
        available: blocked.length === 0,
        prepared_leases: prepared.length,
        queued_leases: prepared.length,
        running_leases: running.length,
        completed_24h: completed24h.length,
        failed_24h: failed24h.length,
        tokens_used_24h: tokensUsed24h,
        tokens_per_successful_worker: completed24h.length > 0 ? tokensUsed24h / successfulWorkers : null,
        recommended_concurrency: recommended,
        blocked_capacity_reasons: blocked,
        queue_depth_by_risk: queueDepthByRisk,
      };
    });
  }

  private runtimeCommandAvailable(runtime: string): boolean {
    const command = runtime === 'codex'
      ? process.env.CODEX_BIN_PATH || 'codex'
      : runtime === 'opencode'
        ? process.env.OPENCODE_BIN_PATH || 'opencode'
        : '';
    if (!command) return true;
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 1_000 });
      return true;
    } catch {
      return false;
    }
  }

  planWorkerPool(input: WorkerPoolPlanInput = {}): WorkerPoolPlanResult {
    const status = this.getStatus();
    const pools = new Map(status.fleet_pools.map((pool) => [pool.runtime, pool]));
    const rows = this.workerPoolRows(input.runtime);
    const decisions = rows.map((row) => this.workerPoolDecision(row, pools, input));
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
      const execution = decision.next_action === 'execute_checker'
        ? await this.loops.executeChecker(decision.loop_run_id, {
          lease_id: decision.lease_id,
          runtime: decision.effective_runtime as Exclude<WorkerRuntime, 'manual'>,
          timeout_ms: input.timeout_ms,
        })
        : await this.loops.executeWorker(decision.loop_run_id, {
          lease_id: decision.lease_id,
          timeout_ms: input.timeout_ms,
          diff_max_lines: input.diff_max_lines,
        });

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
          execution_status: 'completed',
        },
      });
      this.recordRunnerDecision('worker_pool_worker_started', decision.loop_run_id, 'info', { decision, trace_id: traceId });
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
      throw error;
    }
  }

  async drainWorkerPool(input: WorkerPoolPlanInput = {}): Promise<WorkerPoolDrainResult> {
    const maxWorkers = Math.max(1, Math.min(Number(input.max_workers || 1), 20));
    const started: WorkerPoolStartResult[] = [];
    for (let index = 0; index < maxWorkers; index += 1) {
      const result = await this.startNextWorker({ ...input, max_workers: 1 });
      if (result.action !== 'started') {
        break;
      }
      started.push(result);
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
      stopResult = this.loops.stopWorkerLeaseRuntime(leaseId);
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

  tickScheduler(input: { max_items?: number; plan_triaged?: boolean; prepare_planned?: boolean; runtime?: 'codex' | 'opencode' | 'mock' | 'manual'; repository_path?: string; max_assignments_per_item?: number } = {}): SchedulerTickResult {
    const maxItems = Math.max(1, Math.min(Number(input.max_items || 10), 100));
    const planned = input.plan_triaged ? this.planTriagedWorkItems(maxItems) : [];
    const prepared = input.prepare_planned ? this.preparePlannedWorkItems(input, maxItems) : [];
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

  private planTriagedWorkItems(maxItems: number): WorkItemRecord[] {
    const candidates = this.workItems.list({ status: 'triaged', limit: maxItems });
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
    input: { runtime?: 'codex' | 'opencode' | 'mock' | 'manual'; repository_path?: string; max_assignments_per_item?: number },
    maxItems: number
  ): WorkItemRecord[] {
    const candidates = this.workItems.list({ status: 'planned', limit: maxItems });
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
      next_action: blockedReasons.length > 0
        ? (['high_risk_requires_security_or_human_gate', 'manual_runtime_requires_human', 'manual_checker_runtime_required'].some((reason) => blockedReasons.includes(reason)) ? 'human_review' : 'wait')
        : role === 'checker' ? 'execute_checker' : 'execute_maker',
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
