/** Shared persistence for the existing native task authority; callers own authentication/admission. */
import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel, WebSocketEventType, type Task } from '@djimitflo/shared';
import type { WebSocketService } from './websocket-service';
import { AuditService } from './audit-service';
export interface NativeTaskCreate {
  id: string; title: string; description: string; status?: string; priority?: string; risk_level?: RiskLevel; execution_mode?: string;
  agent_id?: string | null; parent_task_id?: string | null; repository_id?: string | null; instruction_profile_id?: string | null;
  tags?: string[]; metadata: Record<string, unknown>; auditMetadata?: Record<string, unknown>;
}
export function parseNativeTask(row: Record<string, unknown>): Task {
  return { ...row, tags: JSON.parse(String(row.tags || '[]')), metadata: JSON.parse(String(row.metadata || '{}')), created_by: row.created_by || null, owner_user_id: row.owner_user_id || null, updated_by: row.updated_by || null } as unknown as Task;
}
export function createNativeTask(db: Database, input: NativeTaskCreate, actorId?: string, now = new Date().toISOString()): Task {
  db.transaction(() => {
    db.prepare(`INSERT INTO tasks(id,title,description,status,priority,risk_level,execution_mode,agent_id,parent_task_id,repository_id,instruction_profile_id,tags,metadata,created_at,updated_at,created_by,owner_user_id,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.id, input.title, input.description, input.status || 'pending', input.priority || 'medium', input.risk_level || RiskLevel.LOW, input.execution_mode || 'review_only', input.agent_id ?? null, input.parent_task_id ?? null, input.repository_id ?? null, input.instruction_profile_id ?? null, JSON.stringify(input.tags || []), JSON.stringify(input.metadata), now, now, actorId, actorId, actorId);
    new AuditService(db).record({ event_type: AuditEventType.TASK_CREATED, action: 'task_created', resource_type: 'task', resource_id: input.id, task_id: input.id, user_id: actorId, risk_level: input.risk_level || RiskLevel.LOW, ...(input.auditMetadata ? { metadata: input.auditMetadata } : {}) });
  })();
  return parseNativeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(input.id) as Record<string, unknown>);
}
/** Call only after the enclosing transaction has committed, including trigger delivery/dedupe transactions. */
export function notifyNativeTaskCreated(task: Task, ws?: WebSocketService, now = new Date().toISOString()): void {
  ws?.broadcastTaskEvent(task, { type: WebSocketEventType.TASK_CREATED, payload: { task }, timestamp: now });
}
