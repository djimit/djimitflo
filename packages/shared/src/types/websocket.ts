/**
 * WebSocket event types
 */

import { Task } from './task';
import { ExecutionEvent } from './execution';
import { Approval, ExecutionPolicy, RiskAssessment } from './policy';
import { Agent } from './agent';
import { MCPServer, MCPTool } from './mcp';
import { AuditEvent } from './audit';
import { ExecutionEvidence } from './evidence';
import { UserRole } from './auth';

export const WS_CLOSE_CODES = {
  AUTH_REQUIRED: 4001,
  AUTH_INVALID: 4002,
  AUTH_EXPIRED: 4003,
  FORBIDDEN: 4004,
} as const;

export interface AuthenticatedClient {
  userId: string;
  email: string;
  role: UserRole;
  tokenExp: number;
}

// WebSocket message envelope
export interface WebSocketMessage<T = unknown> {
  type: WebSocketEventType;
  payload: T;
  timestamp: string;
}

export enum WebSocketEventType {
  // Task events
  TASK_CREATED = 'task.created',
  TASK_UPDATED = 'task.updated',
  TASK_DELETED = 'task.deleted',
  TASK_STARTED = 'task.started',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  TASK_CANCELLED = 'task.cancelled',
  
  // Execution events
  EXECUTION_EVENT = 'execution.event',
  EXECUTION_LOG = 'execution.log',
  
  // Approval events
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_GRANTED = 'approval.granted',
  APPROVAL_DENIED = 'approval.denied',
  APPROVAL_EXPIRED = 'approval.expired',
  EXECUTION_PAUSED_FOR_APPROVAL = 'execution.paused_for_approval',
  EXECUTION_RESUMED_AFTER_APPROVAL = 'execution.resumed_after_approval',
  EXECUTION_DENIED_BY_POLICY = 'execution.denied_by_policy',
  RISK_DETECTED = 'risk.detected',
  POLICY_CREATED = 'policy.created',
  POLICY_UPDATED = 'policy.updated',
  POLICY_VIOLATION = 'policy.violation',
  
  // Agent events
  AGENT_CREATED = 'agent.created',
  AGENT_UPDATED = 'agent.updated',
  AGENT_STATUS_CHANGED = 'agent.status_changed',
  
  // MCP events
  MCP_SERVER_DISCOVERED = 'mcp.server.discovered',
  MCP_SERVER_STATUS_CHANGED = 'mcp.server.status_changed',
  MCP_TOOL_CALLED = 'mcp.tool.called',
  MCP_TOOL_PERMISSION_CHANGED = 'mcp.tool.permission_changed',
  
  // Audit events
  AUDIT_EVENT = 'audit.event',
  
  // Evidence events
  EVIDENCE_CAPTURED = 'evidence.captured',
  SUMMARY_GENERATED = 'summary.generated',
  FILE_CHANGE_DETECTED = 'file_change.detected',
  
  // System events
  SYSTEM_HEALTH = 'system.health',
  SYSTEM_ERROR = 'system.error',
}

// Event payloads
export interface TaskEventPayload {
  task: Task;
}

export interface ExecutionEventPayload {
  event: ExecutionEvent;
}

export interface ApprovalEventPayload {
  approval: Approval;
}

export interface PolicyEventPayload {
  policy: ExecutionPolicy;
}

export interface RiskEventPayload {
  assessment: RiskAssessment;
  task_id?: string;
  event_id?: string;
}

export interface AgentEventPayload {
  agent: Agent;
}

export interface MCPServerEventPayload {
  server: MCPServer;
}

export interface MCPToolEventPayload {
  tool: MCPTool;
  server_id: string;
}

export interface AuditEventPayload {
  event: AuditEvent;
}

export interface SystemHealthPayload {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime_ms: number;
  active_tasks: number;
  active_agents: number;
  memory_usage_mb: number;
  cpu_usage_percent: number;
}

export interface SystemErrorPayload {
  error: string;
  stack?: string;
  timestamp: string;
}

export interface EvidenceEventPayload {
  evidence: ExecutionEvidence;
}

export interface SummaryEventPayload {
  summary: import('./evidence').ExecutionSummary;
}
