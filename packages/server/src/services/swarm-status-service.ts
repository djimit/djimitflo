import os from 'os';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { WorkItemService, type WorkItemRecord } from './work-item-service';
import { LoopService, type LoopName } from './loop-service';

type BacklogStatus = 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';
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

export class SwarmStatusService {
  private workItems: WorkItemService;
  private loops: LoopService;

  constructor(private db: Database, private options: SwarmStatusOptions = {}) {
    this.workItems = new WorkItemService(db);
    this.loops = new LoopService(db);
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
      if (freeMemoryRatio < 0.1) blocked.push('low_free_memory');
      if (load > resourceSnapshot.cpu_threads) blocked.push('high_cpu_load');
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
}
