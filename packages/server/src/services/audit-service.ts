import type { Database } from 'better-sqlite3';
import { AuditEventCreateInput, AuditEventType, RiskLevel, type AuditQuery, type AuditEvent } from '@djimitflo/shared';
import { ComplianceAuditService } from './compliance-audit-service';

export class AuditService {
  private readonly canonical: ComplianceAuditService;

  constructor(private db: Database) {
    this.canonical = new ComplianceAuditService(db);
  }

  record(input: AuditEventCreateInput) {
    const outcome = /denied|violation/.test(input.event_type) ? 'denied'
      : /failed|error/.test(input.event_type) ? 'failure' : 'success';
    return this.canonical.appendEntry({
      actor: input.user_id || input.agent_id || 'system',
      action: input.action,
      resource: input.resource_id || input.resource_type,
      outcome,
      evidence: input.metadata || {},
      event: {
        eventType: input.event_type,
        userId: input.user_id,
        agentId: input.agent_id,
        taskId: input.task_id,
        executionEventId: input.execution_event_id,
        resourceType: input.resource_type,
        riskLevel: input.risk_level || RiskLevel.MEDIUM,
        before: input.before,
        after: input.after,
        ipAddress: input.ip_address,
        userAgent: input.user_agent,
      },
    }).id;
  }

  recordPolicyViolation(taskId: string, metadata: Record<string, unknown>) {
    return this.record({
      event_type: AuditEventType.POLICY_VIOLATION,
      action: 'policy_violation_detected',
      resource_type: 'task',
      task_id: taskId,
      risk_level: RiskLevel.HIGH,
      metadata,
    });
  }

  query(input: AuditQuery): { events: AuditEvent[]; total: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (input.event_types?.length) {
      conditions.push(`event_type IN (${input.event_types.map(() => '?').join(',')})`);
      params.push(...input.event_types);
    }
    if (input.user_id) { conditions.push('user_id = ?'); params.push(input.user_id); }
    if (input.agent_id) { conditions.push('agent_id = ?'); params.push(input.agent_id); }
    if (input.task_id) { conditions.push('task_id = ?'); params.push(input.task_id); }
    if (input.resource_type) { conditions.push('resource_type = ?'); params.push(input.resource_type); }
    if (input.risk_level) { conditions.push('risk_level = ?'); params.push(input.risk_level); }
    if (input.from_date) { conditions.push('timestamp >= ?'); params.push(input.from_date); }
    if (input.to_date) { conditions.push('timestamp <= ?'); params.push(input.to_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM audit_events ${where}`).get(...params) as { count: number };
    const rows = this.db.prepare(`SELECT * FROM audit_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

    return {
      events: rows.map((r: any) => this.sanitizeAuditEvent(r)),
      total: countRow.count,
    };
  }

  sanitizeAuditEvent(row: any): AuditEvent {
    return {
      ...row,
      before: row.before ? JSON.parse(row.before) : null,
      after: row.after ? JSON.parse(row.after) : null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }
}
