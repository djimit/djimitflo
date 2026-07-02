import type { Database } from 'better-sqlite3';
import { AgentAssuranceService } from './agent-assurance-service';
import { SkillService } from './skill-service';

export interface WorkerLeaseRecord {
  id: string;
  loop_run_id: string;
  role: string;
  runtime: string;
  status: string;
  capability_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoopRunRecord {
  id: string;
  loop_name: string;
  goal_id: string | null;
  status: string;
  mode: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface ExecuteResult {
  success: boolean;
  output: string;
  errors: string[];
  durationMs: number;
}

export class LoopExecutionService {
  constructor(
    private db: Database,
    _assurance: AgentAssuranceService,
    private skills: SkillService,
  ) {}

  getWorkerLease(leaseId: string): WorkerLeaseRecord | null {
    try {
      const row = this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(leaseId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        loop_run_id: row.loop_run_id as string,
        role: row.role as string,
        runtime: row.runtime as string,
        status: row.status as string,
        capability_id: row.capability_id as string | null,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      };
    } catch { return null; }
  }

  getLoopRun(runId: string): LoopRunRecord | null {
    try {
      const row = this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        loop_name: row.loop_name as string,
        goal_id: row.goal_id as string | null,
        status: row.status as string,
        mode: row.mode as string,
        metadata: row.metadata as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      };
    } catch { return null; }
  }

  listLoopRuns(limit: number = 50): LoopRunRecord[] {
    try {
      const rows = this.db.prepare('SELECT * FROM loop_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
      return rows.map(row => ({
        id: row.id as string,
        loop_name: row.loop_name as string,
        goal_id: row.goal_id as string | null,
        status: row.status as string,
        mode: row.mode as string,
        metadata: row.metadata as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      }));
    } catch { return []; }
  }

  getRunStatus(runId: string): string {
    const run = this.getLoopRun(runId);
    return run?.status || 'unknown';
  }

  getLeaseStatus(leaseId: string): string {
    const lease = this.getWorkerLease(leaseId);
    return lease?.status || 'unknown';
  }

  getSkillForRun(runId: string): string | null {
    try {
      const run = this.getLoopRun(runId);
      if (!run) return null;
      return this.skills.getSkillForFinding(run.loop_name, '');
    } catch { return null; }
  }

  getRunMetrics(runId: string): { totalLeases: number; completedLeases: number; failedLeases: number } {
    try {
      const all = this.db.prepare('SELECT status FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ status: string }>;
      return {
        totalLeases: all.length,
        completedLeases: all.filter(l => l.status === 'completed').length,
        failedLeases: all.filter(l => l.status === 'failed').length,
      };
    } catch { return { totalLeases: 0, completedLeases: 0, failedLeases: 0 }; }
  }
}
