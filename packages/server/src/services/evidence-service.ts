import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { EvidenceType, EvidenceSeverity, RiskLevel } from '@djimitflo/shared';
import type { ExecutionEvidence, ExecutionSummary, FileChange, CaptureEvidenceInput, FileChangeInput, ObservabilityMetrics, AuditTrailEntry } from '@djimitflo/shared';

export class EvidenceService {
  constructor(private db: Database) {}

  captureEvidence(input: CaptureEvidenceInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO execution_evidence (
        id, task_id, execution_event_id, approval_id, evidence_type, severity,
        title, summary, details, source, captured_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.task_id,
      input.execution_event_id || null,
      input.approval_id || null,
      input.evidence_type,
      input.severity,
      input.title,
      input.summary,
      input.details ? JSON.stringify(input.details) : null,
      input.source,
      input.captured_at || now,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return id;
  }

  getTaskEvidence(taskId: string, filters?: { evidence_type?: EvidenceType; severity?: EvidenceSeverity }): ExecutionEvidence[] {
    let query = 'SELECT * FROM execution_evidence WHERE task_id = ?';
    const params: any[] = [taskId];

    if (filters?.evidence_type) {
      query += ' AND evidence_type = ?';
      params.push(filters.evidence_type);
    }
    if (filters?.severity) {
      query += ' AND severity = ?';
      params.push(filters.severity);
    }

    query += ' ORDER BY captured_at ASC';

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.mapEvidence(row));
  }

  getEvidenceById(id: string): ExecutionEvidence | null {
    const row = this.db.prepare('SELECT * FROM execution_evidence WHERE id = ?').get(id) as any;
    return row ? this.mapEvidence(row) : null;
  }


  /**
   * Capture assessment evidence enriched with RAG citations from DjimitKBWiki.
   * Stores RAG context in details.rag_context and citations in details.citations.
   */
  captureAssessmentEvidence(input: CaptureEvidenceInput & {
    ragQuery?: string;
    ragResults?: Array<{
      title: string;
      path: string;
      type: string;
      score: number;
      excerpt: string;
    }>;
    ragSource?: string;
  }): string {
    const { ragQuery, ragResults, ragSource, ...baseInput } = input;

    const enrichedDetails = {
      ...((baseInput.details || {}) as Record<string, any>),
      rag_context: ragResults || [],
      citations: (ragResults || []).map((r: any) => ({
        title: r.title,
        path: r.path,
        type: r.type,
        score: r.score,
        excerpt: r.excerpt?.slice(0, 200),
      })),
    };

    const enrichedMetadata = {
      ...(baseInput.metadata || {}),
      rag_source: ragSource || 'djimitkb-mcp',
      rag_query: ragQuery,
      rag_result_count: ragResults?.length || 0,
      rag_collection: 'djimitkb',
    };

    return this.captureEvidence({
      ...baseInput,
      details: enrichedDetails,
      metadata: enrichedMetadata,
    });
  }

  generateExecutionSummary(taskId: string): ExecutionSummary | null {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) return null;

    const events = this.db.prepare('SELECT * FROM execution_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
    const evidence = this.db.prepare('SELECT * FROM execution_evidence WHERE task_id = ?').all(taskId) as any[];
    const risk = this.db.prepare('SELECT * FROM risk_assessments WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as any;
    const approvals = this.db.prepare('SELECT * FROM approvals WHERE task_id = ?').all(taskId) as any[];

    const toolCalls = events.filter((e: any) => e.event_type === 'tool.call');
    const errors = events.filter((e: any) => e.level === 'error' || e.level === 'critical');
    const warnings = events.filter((e: any) => e.level === 'warning');

    const riskLevel = risk?.risk_level || task.risk_level || RiskLevel.LOW;
    const policyDecision = risk?.recommended_decision || 'allow';
    const approvalRequired = approvals.length > 0;
    const approvalGranted = approvals.some((a: any) => a.status === 'approved');

    const summary: ExecutionSummary = {
      id: randomUUID(),
      task_id: taskId,
      executor_kind: task.metadata?.executorKind || 'unknown',
      started_at: task.started_at || task.created_at,
      completed_at: task.completed_at || null,
      duration_ms: task.execution_time_ms || null,
      final_status: task.status === 'awaiting_approval' ? 'denied' : task.status,
      risk_level: riskLevel,
      policy_decision: policyDecision,
      approval_required: approvalRequired,
      approval_granted: approvalRequired ? approvalGranted : null,
      event_count: events.length,
      error_count: errors.length,
      warning_count: warnings.length,
      evidence_count: evidence.length,
      tool_call_count: toolCalls.length,
      files_changed: [],
      commands_executed: toolCalls.map((t: any) => t.tool_name).filter(Boolean),
      artifacts_created: [],
      token_usage: task.token_usage || null,
      metadata: {
        task_title: task.title,
        task_description: task.description,
        executor_kind: task.metadata?.executorKind,
        execution_mode: task.execution_mode,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.upsertSummary(summary);
    return summary;
  }

  getExecutionSummary(taskId: string): ExecutionSummary | null {
    const row = this.db.prepare('SELECT * FROM execution_summaries WHERE task_id = ?').get(taskId) as any;
    if (!row) return this.generateExecutionSummary(taskId);
    return this.mapSummary(row);
  }

  recordFileChange(input: FileChangeInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO file_changes (
        id, task_id, execution_event_id, file_path, change_type,
        before_hash, after_hash, before_size, after_size, diff,
        risk_level, detected_at, repository_id, additions, deletions, diff_truncated,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.task_id,
      input.execution_event_id || null,
      input.file_path,
      input.change_type,
      input.before_hash || null,
      input.after_hash || null,
      input.before_size || null,
      input.after_size || null,
      input.diff || null,
      input.risk_level || RiskLevel.LOW,
      input.detected_at || now,
      input.repository_id || null,
      input.additions ?? null,
      input.deletions ?? null,
      input.diff_truncated ? 1 : 0,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return id;
  }

  getFileChanges(taskId: string): FileChange[] {
    const rows = this.db.prepare('SELECT * FROM file_changes WHERE task_id = ? ORDER BY detected_at ASC').all(taskId) as any[];
    return rows.map((row) => this.mapFileChange(row));
  }

  getObservabilityMetrics(): ObservabilityMetrics {
    const totalTasks = (this.db.prepare('SELECT COUNT(*) as count FROM tasks').get() as any).count;
    const activeTasks = (this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status IN ('running', 'queued', 'awaiting_approval')").get() as any).count;
    const completedTasks = (this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get() as any).count;
    const failedTasks = (this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'failed'").get() as any).count;
    const deniedTasks = (this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'cancelled'").get() as any).count;
    const pendingApprovals = (this.db.prepare("SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'").get() as any).count;

    const durationResult = this.db.prepare("SELECT AVG(execution_time_ms) as avg_ms FROM tasks WHERE execution_time_ms IS NOT NULL AND status = 'completed'").get() as any;
    const avgDurationMs = durationResult?.avg_ms || null;

    const riskDist = this.db.prepare('SELECT risk_level, COUNT(*) as count FROM risk_assessments GROUP BY risk_level').all() as any[];
    const riskDistribution: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const row of riskDist) {
      riskDistribution[row.risk_level] = row.count;
    }

    const policyDecisions = this.db.prepare('SELECT recommended_decision, COUNT(*) as count FROM risk_assessments GROUP BY recommended_decision').all() as any[];
    const policyDecisionCounts: Record<string, number> = { allow: 0, deny: 0, require_approval: 0 };
    for (const row of policyDecisions) {
      policyDecisionCounts[row.recommended_decision] = row.count;
    }

    const recentErrors = this.db.prepare("SELECT task_id, message, created_at as timestamp FROM execution_events WHERE level IN ('error', 'critical') ORDER BY created_at DESC LIMIT 10").all() as any[];

    return {
      total_tasks: totalTasks,
      active_tasks: activeTasks,
      completed_tasks: completedTasks,
      failed_tasks: failedTasks,
      denied_tasks: deniedTasks,
      pending_approvals: pendingApprovals,
      avg_duration_ms: avgDurationMs ? Math.round(avgDurationMs) : null,
      risk_distribution: riskDistribution as any,
      policy_decisions: policyDecisionCounts as any,
      recent_errors: recentErrors.map((e: any) => ({
        task_id: e.task_id,
        message: e.message,
        timestamp: e.timestamp,
      })),
    };
  }

  getAuditTrail(taskId: string): AuditTrailEntry[] {
    const auditEvents = this.db.prepare('SELECT * FROM audit_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
    const riskEvents = this.db.prepare('SELECT * FROM risk_assessments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
    const approvalEvents = this.db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];

    const trail: AuditTrailEntry[] = [];

    for (const ae of auditEvents) {
      trail.push({
        timestamp: ae.created_at,
        event_type: ae.event_type,
        action: ae.action,
        resource_type: ae.resource_type,
        resource_id: ae.resource_id,
        risk_level: ae.risk_level,
        actor: ae.user_id || ae.agent_id,
        summary: `${ae.action} on ${ae.resource_type}${ae.resource_id ? ` ${ae.resource_id}` : ''}`,
        metadata: JSON.parse(ae.metadata || '{}'),
      });
    }

    for (const ra of riskEvents) {
      trail.push({
        timestamp: ra.created_at,
        event_type: 'risk.assessed',
        action: 'risk_assessment',
        resource_type: 'task',
        resource_id: ra.task_id,
        risk_level: ra.risk_level,
        actor: 'system',
        summary: `Risk assessed as ${ra.risk_level}: ${ra.explanation}`,
        metadata: { matched_rules: JSON.parse(ra.matched_rules || '[]'), recommended_decision: ra.recommended_decision },
      });
    }

    for (const ap of approvalEvents) {
      const action = ap.status === 'approved' ? 'approval.granted' : ap.status === 'denied' ? 'approval.denied' : 'approval.requested';
      trail.push({
        timestamp: ap.created_at,
        event_type: action,
        action,
        resource_type: 'approval',
        resource_id: ap.id,
        risk_level: ap.risk_level,
        actor: ap.approved_by || ap.decided_by || 'system',
        summary: `Approval ${ap.status}: ${ap.request_message || ap.title || 'No message'}`,
        metadata: JSON.parse(ap.metadata || '{}'),
      });
    }

    trail.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return trail;
  }

  private upsertSummary(summary: ExecutionSummary): void {
    const existing = this.db.prepare('SELECT id FROM execution_summaries WHERE task_id = ?').get(summary.task_id) as any;

    if (existing) {
      this.db.prepare(`
        UPDATE execution_summaries SET
          executor_kind = ?, started_at = ?, completed_at = ?, duration_ms = ?,
          final_status = ?, risk_level = ?, policy_decision = ?,
          approval_required = ?, approval_granted = ?,
          event_count = ?, error_count = ?, warning_count = ?, evidence_count = ?,
          tool_call_count = ?, files_changed = ?, commands_executed = ?,
          artifacts_created = ?, token_usage = ?, metadata = ?, updated_at = ?
        WHERE task_id = ?
      `).run(
        summary.executor_kind,
        summary.started_at,
        summary.completed_at,
        summary.duration_ms,
        summary.final_status,
        summary.risk_level,
        summary.policy_decision,
        summary.approval_required ? 1 : 0,
        summary.approval_granted === null ? null : summary.approval_granted ? 1 : 0,
        summary.event_count,
        summary.error_count,
        summary.warning_count,
        summary.evidence_count,
        summary.tool_call_count,
        JSON.stringify(summary.files_changed),
        JSON.stringify(summary.commands_executed),
        JSON.stringify(summary.artifacts_created),
        summary.token_usage,
        JSON.stringify(summary.metadata),
        summary.updated_at,
        summary.task_id
      );
    } else {
      this.db.prepare(`
        INSERT INTO execution_summaries (
          id, task_id, executor_kind, started_at, completed_at, duration_ms,
          final_status, risk_level, policy_decision, approval_required, approval_granted,
          event_count, error_count, warning_count, evidence_count, tool_call_count,
          files_changed, commands_executed, artifacts_created, token_usage,
          metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summary.id,
        summary.task_id,
        summary.executor_kind,
        summary.started_at,
        summary.completed_at,
        summary.duration_ms,
        summary.final_status,
        summary.risk_level,
        summary.policy_decision,
        summary.approval_required ? 1 : 0,
        summary.approval_granted === null ? null : summary.approval_granted ? 1 : 0,
        summary.event_count,
        summary.error_count,
        summary.warning_count,
        summary.evidence_count,
        summary.tool_call_count,
        JSON.stringify(summary.files_changed),
        JSON.stringify(summary.commands_executed),
        JSON.stringify(summary.artifacts_created),
        summary.token_usage,
        JSON.stringify(summary.metadata),
        summary.created_at,
        summary.updated_at
      );
    }
  }

  private mapEvidence(row: any): ExecutionEvidence {
    return {
      ...row,
      details: row.details ? JSON.parse(row.details) : null,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private mapSummary(row: any): ExecutionSummary {
    return {
      ...row,
      approval_required: Boolean(row.approval_required),
      approval_granted: row.approval_granted === null ? null : Boolean(row.approval_granted),
      files_changed: JSON.parse(row.files_changed || '[]'),
      commands_executed: JSON.parse(row.commands_executed || '[]'),
      artifacts_created: JSON.parse(row.artifacts_created || '[]'),
      token_usage: row.token_usage,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private mapFileChange(row: any): FileChange {
    return {
      ...row,
      repository_id: row.repository_id ?? null,
      additions: row.additions ?? null,
      deletions: row.deletions ?? null,
      diff_truncated: Boolean(row.diff_truncated),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }
}