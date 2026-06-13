import type { Database } from 'better-sqlite3';
import { AuditEventCreateInput, AuditEventType, RiskLevel, type AuditQuery, type AuditEvent } from '@djimitflo/shared';
import { randomUUID } from 'crypto';

export class AuditService {
  constructor(private db: Database) {}

  record(input: AuditEventCreateInput) {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO audit_events (
        id, event_type, timestamp, user_id, agent_id, task_id, execution_event_id,
        action, resource_type, resource_id, risk_level, before, after,
        ip_address, user_agent, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.event_type,
      now,
      input.user_id || 'system',
      input.agent_id || null,
      input.task_id || null,
      input.execution_event_id || null,
      input.action,
      input.resource_type,
      input.resource_id || null,
      input.risk_level || RiskLevel.MEDIUM,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.ip_address || null,
      input.user_agent || null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return id;
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
