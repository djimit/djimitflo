import type { Database } from 'better-sqlite3';
import { ApprovalRequest, ApprovalRequestType, ApprovalStatus, AuditEventType, RiskAssessment, Task, WebSocketEventType } from '@djimitflo/shared';
import { randomUUID } from 'crypto';
import { WebSocketService } from './websocket-service';
import { AuditService } from './audit-service';

export interface CreateApprovalInput {
  task: Task;
  assessment: RiskAssessment;
  requestType: ApprovalRequestType;
  title: string;
  description: string;
  command?: string;
  toolName?: string;
  targetPath?: string;
  policyId?: string;
  metadata?: Record<string, unknown>;
}

export class ApprovalService {
  constructor(
    private db: Database,
    private wsService: WebSocketService,
    private auditService: AuditService
  ) {}

  listApprovals(taskId?: string): ApprovalRequest[] {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC').all(taskId)
      : this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all();
    return (rows as any[]).map((row) => this.mapApproval(row));
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    return row ? this.mapApproval(row) : null;
  }

  getLatestPendingForTask(taskId: string): ApprovalRequest | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(taskId) as any;
    return row ? this.mapApproval(row) : null;
  }

  createApproval(input: CreateApprovalInput): ApprovalRequest {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    this.db.prepare(`
      INSERT INTO approvals (
        id, task_id, execution_event_id, status, risk_level, action_type, title, description,
        command, tool_name, target_path, policy_id, request_type, request_message, request_data,
        expires_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.task.id,
      null,
      ApprovalStatus.PENDING,
      input.assessment.risk_level,
      input.assessment.action_type,
      input.title,
      input.description,
      input.command || null,
      input.toolName || null,
      input.targetPath || null,
      input.policyId || null,
      input.requestType,
      input.description,
      JSON.stringify({
        assessment: input.assessment,
        taskTitle: input.task.title,
      }),
      expiresAt,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    const approval = this.getApproval(id)!;
    this.auditService.record({
      event_type: AuditEventType.APPROVAL_REQUESTED,
      action: 'approval_requested',
      resource_type: 'approval',
      resource_id: id,
      task_id: input.task.id,
      risk_level: input.assessment.risk_level,
      metadata: {
        policyId: input.policyId || null,
        actionType: input.assessment.action_type,
      },
    });
    this.wsService.broadcast({
      type: WebSocketEventType.APPROVAL_REQUESTED,
      payload: { approval },
      timestamp: now,
    });

    return approval;
  }

  decideApproval(id: string, approved: boolean, reason?: string): ApprovalRequest {
    const approval = this.getApproval(id);
    if (!approval) {
      throw new Error('Approval not found');
    }
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new Error('Approval already processed');
    }

    const now = new Date().toISOString();
    const status = approved ? ApprovalStatus.APPROVED : ApprovalStatus.DENIED;

    this.db.prepare(`
      UPDATE approvals SET
        status = ?,
        approved_by = ?,
        approved_at = ?,
        denied_at = ?,
        denial_reason = ?,
        decided_at = ?,
        decided_by = ?,
        decision_reason = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      'user',
      approved ? now : null,
      approved ? null : now,
      approved ? null : (reason || 'No reason provided'),
      now,
      'user',
      reason || null,
      now,
      id
    );

    const updated = this.getApproval(id)!;
    this.auditService.record({
      event_type: approved ? AuditEventType.APPROVAL_GRANTED : AuditEventType.APPROVAL_DENIED,
      action: approved ? 'approval_granted' : 'approval_denied',
      resource_type: 'approval',
      resource_id: id,
      task_id: updated.task_id,
      risk_level: updated.risk_level,
      metadata: { reason: reason || null },
    });
    this.wsService.broadcast({
      type: approved ? WebSocketEventType.APPROVAL_GRANTED : WebSocketEventType.APPROVAL_DENIED,
      payload: { approval: updated },
      timestamp: now,
    });

    return updated;
  }

  private mapApproval(row: any): ApprovalRequest {
    return {
      ...row,
      request_data: JSON.parse(row.request_data || '{}'),
      metadata: JSON.parse(row.metadata || '{}'),
      action_type: row.action_type || null,
      title: row.title || null,
      description: row.description || null,
      command: row.command || null,
      tool_name: row.tool_name || null,
      target_path: row.target_path || null,
      policy_id: row.policy_id || null,
      requested_at: row.created_at,
      decided_at: row.decided_at || row.approved_at || row.denied_at || null,
      decided_by: row.decided_by || row.approved_by || null,
      decision_reason: row.decision_reason || row.denial_reason || null,
    };
  }
}
