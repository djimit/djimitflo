/** Quiescent retirement of existing core agents; no process drain or knowledge promotion. */
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { ComplianceAuditService } from './compliance-audit-service';
import { RuntimeLeaseRegistry } from './loop-recovery-service';
import { createError } from '../middleware/error-handler';

interface RetirementPlan {
  agentId: string;
  status: string;
  steps: Array<{ name: string; status: 'completed'; details: string; completedAt: string }>;
  startedAt: string;
  completedAt?: string;
}

export class AgentRetirementService {
  private audit: ComplianceAuditService;
  constructor(private db: Database) { this.audit = new ComplianceAuditService(db); }

  private agent(agentId: string): any {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
    if (!agent) throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
    return agent;
  }

  private ownedLeases(agentId: string): Array<{ id: string; status: string; metadata: string }> {
    // A spawner is not necessarily the worker. Only the actual execution task's
    // assigned agent establishes ownership; anonymous/unrelated leases stay put.
    return this.db.prepare(`SELECT w.id, w.status, w.metadata FROM worker_leases w
      JOIN tasks t ON t.id = json_extract(CASE WHEN json_valid(w.metadata) THEN w.metadata ELSE '{}' END, '$.execution_task_id')
      WHERE t.agent_id = ?`).all(agentId) as Array<{ id: string; status: string; metadata: string }>;
  }

  planRetirement(agentId: string): {
    agentId: string; canRetire: boolean; blockers: string[]; warnings: string[];
    stats: { activeLeases: number; pendingTasks: number; evidenceItems: number; governanceScore: number };
  } {
    this.agent(agentId);
    const leases = this.ownedLeases(agentId);
    const activeLeases = leases.filter(lease => lease.status === 'running' || RuntimeLeaseRegistry.isLive(lease.id)).length;
    const pendingTasks = (this.db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE agent_id = ?
      AND (status NOT IN ('completed','failed','cancelled')
        OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.execution_recovery_hold') = 1)`)
      .get(agentId) as { count: number }).count;
    const blockers = [];
    if (activeLeases) blockers.push(`${activeLeases} owned live/running leases require explicit completion or cancellation`);
    if (pendingTasks) blockers.push(`${pendingTasks} owned nonterminal or recovery-held tasks require reconciliation`);
    const evidenceItems = (this.db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE agent_id = ? OR resource_id = ?')
      .get(agentId, agentId) as { count: number }).count;
    const governanceScore = (this.db.prepare(`SELECT overall_score FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`).get(agentId) as { overall_score: number } | undefined)?.overall_score ?? 0;
    return { agentId, canRetire: blockers.length === 0, blockers,
      warnings: ['Quiescent retirement only; no process drain, reassignment, worktree deletion or knowledge promotion.'],
      stats: { activeLeases, pendingTasks, evidenceItems, governanceScore } };
  }

  async retireAgent(agentId: string, reason: string, actor = 'system'): Promise<RetirementPlan> {
    if (typeof reason !== 'string' || !reason.trim()) throw createError(400, 'Retirement reason is required', 'VALIDATION_ERROR');
    return this.db.transaction(() => {
      const agent = this.agent(agentId);
      const now = new Date().toISOString();
      if (agent.retired_at) return { agentId, status: 'completed', steps: [], startedAt: agent.retired_at, completedAt: agent.retired_at };
      const readiness = this.planRetirement(agentId);
      if (!readiness.canRetire) throw createError(409, readiness.blockers.join('; '), 'AGENT_BUSY');
      const leases = this.ownedLeases(agentId);
      const tasks = this.db.prepare('SELECT * FROM tasks WHERE agent_id = ?').all(agentId);
      const archiveId = randomUUID();
      this.db.prepare(`INSERT INTO agent_archives(id,agent_id,archived_at,evidence_json,metadata_json)
        VALUES(?,?,?,?,?)`).run(archiveId, agentId, now,
          JSON.stringify({ agent, tasks, leases }), JSON.stringify({ reason: reason.trim(), archived_by: actor, knowledge_promoted: false }));
      const cancel = this.db.prepare("UPDATE worker_leases SET status='cancelled',updated_at=? WHERE id=? AND status='prepared'");
      let cancelled = 0;
      for (const lease of leases) cancelled += cancel.run(now, lease.id).changes;
      // Existing schema deliberately has no retired status. The durable tombstone
      // owns retirement; offline preserves the existing non-dispatchable state.
      this.db.prepare("UPDATE agents SET status='offline',retired_at=?,retirement_reason=?,updated_at=? WHERE id=?")
        .run(now, reason.trim(), now, agentId);
      this.audit.appendEntry({ actor, action: 'agent_retired', resource: agentId, outcome: 'success',
        evidence: { reason: reason.trim(), archive_id: archiveId, cancelled_lease_ids: leases.filter(lease => lease.status === 'prepared').map(lease => lease.id),
          operational_status: 'offline', retired_at: now, knowledge_promoted: false, processes_drained: false },
        event: { eventType: 'agent.retired', userId: actor, agentId, resourceType: 'agent', riskLevel: 'medium',
          before: { status: agent.status, retired_at: agent.retired_at }, after: { status: 'offline', retired_at: now } } });
      return { agentId, status: 'completed', startedAt: now, completedAt: now, steps: [
        { name: 'pre_retirement_audit', status: 'completed' as const, details: 'No owned live or unresolved work', completedAt: now },
        { name: 'final_archival', status: 'completed' as const, details: `Stored actual agent/task/lease snapshot ${archiveId}; no knowledge promotion`, completedAt: now },
        { name: 'lease_cleanup', status: 'completed' as const, details: `Cancelled ${cancelled} exact owned prepared leases; no worktrees removed`, completedAt: now },
        { name: 'deactivation', status: 'completed' as const, details: 'Offline operational status and durable retirement tombstone recorded', completedAt: now },
      ] };
    }).immediate();
  }

  getRetirementStatus(agentId: string): { agentId: string; status: string; retiredAt?: string; reason?: string } {
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
    return agent ? { agentId, status: agent.retired_at ? 'retired' : agent.status, retiredAt: agent.retired_at, reason: agent.retirement_reason }
      : { agentId, status: 'not_found' };
  }

  listRetiredAgents(): Array<{ agentId: string; name: string; retiredAt: string; reason: string; finalGovernanceScore: number }> {
    return (this.db.prepare(`SELECT a.id,a.name,a.retired_at,a.retirement_reason,
      (SELECT overall_score FROM openmythos_eval_runs e WHERE e.agent_id=a.id AND e.status='completed' ORDER BY finished_at DESC LIMIT 1) AS score
      FROM agents a WHERE a.retired_at IS NOT NULL ORDER BY a.retired_at DESC`).all() as any[])
      .map(row => ({ agentId: row.id, name: row.name, retiredAt: row.retired_at, reason: row.retirement_reason || '', finalGovernanceScore: row.score ?? 0 }));
  }
}
