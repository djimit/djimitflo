import type { Database } from 'better-sqlite3';
import { AuditEventCreateInput, AuditEventType, RiskLevel } from '@djimitflo/shared';
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
}
