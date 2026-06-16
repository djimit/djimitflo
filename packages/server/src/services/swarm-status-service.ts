import os from 'os';
import type { Database } from 'better-sqlite3';
import { WorkItemService, type WorkItemRecord } from './work-item-service';

type BacklogStatus = 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';

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
  reality_check: {
    agent_count_is_registry_only: boolean;
    active_execution_requires_runtime_evidence: boolean;
  };
}

export interface SchedulerTickResult {
  created_work_items: WorkItemRecord[];
  planned_work_items: WorkItemRecord[];
  skipped_existing: number;
  inspected_loop_runs: number;
  leases_created: number;
}

export class SwarmStatusService {
  private workItems: WorkItemService;

  constructor(private db: Database, private options: SwarmStatusOptions = {}) {
    this.workItems = new WorkItemService(db);
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
    const openLoopRuns = this.countRows("SELECT COUNT(*) as count FROM loop_runs WHERE status IN ('created', 'planning', 'running', 'verifying', 'blocked', 'escalated')");
    const openTasks = this.countRows("SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'queued', 'running', 'paused', 'awaiting_approval', 'failed')");
    const backlogCount = this.backlogCounts();

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
      resource_snapshot: {
        cpu_threads: os.cpus().length,
        total_memory_bytes: os.totalmem(),
        free_memory_bytes: os.freemem(),
        load_average: os.loadavg(),
        uptime_seconds: os.uptime(),
      },
      reality_check: {
        agent_count_is_registry_only: agents.length !== liveAgents.length,
        active_execution_requires_runtime_evidence: true,
      },
    };
  }

  tickScheduler(input: { max_items?: number; plan_triaged?: boolean } = {}): SchedulerTickResult {
    const maxItems = Math.max(1, Math.min(Number(input.max_items || 10), 100));
    const planned = input.plan_triaged ? this.planTriagedWorkItems(maxItems) : [];
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
      skipped_existing: skippedExisting,
      inspected_loop_runs: inspected,
      leases_created: 0,
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
