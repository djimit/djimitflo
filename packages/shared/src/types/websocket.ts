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
  MESSAGE_SENT = 'message.sent',
  
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

  // Proof run events
  PROOF_RUN_UPDATED = 'proof_run.updated',

  // Nested swarm spawn events (P1): a child spawning is observable end-to-end.
  SWARM_SPAWN_REQUESTED = 'swarm.spawn.requested',
  SWARM_SPAWN_PREPARED = 'swarm.spawn.prepared',
  SWARM_SPAWN_COMPLETED = 'swarm.spawn.completed',
  SWARM_SPAWN_GATED_OUT = 'swarm.spawn.gated_out',

  // System events
  SYSTEM_HEALTH = 'system.health',
  SYSTEM_ERROR = 'system.error',

  // Discussion events
  DISCUSSION_CREATED = 'discussion.created',
  PROPOSAL_ADDED = 'discussion.proposal_added',
  VOTE_CAST = 'discussion.vote_cast',
  CONSENSUS_REACHED = 'discussion.consensus_reached',
  CONSENSUS_FAILED = 'discussion.consensus_failed',
  DISCUSSION_TURN_ADDED = 'discussion.turn_added',
  DISCUSSION_TURN_COMMITTED = 'discussion.turn_committed',
  LEARNING_CAPTURED = 'learning.captured',
  TOKEN_USAGE_LOGGED = 'token_usage.logged',
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

export interface ProofRunEventPayload {
  id: string;
  status: 'completed' | 'rolled_back';
  passed: boolean;
  rollback_safe: boolean;
  runtime: 'mock' | 'codex' | 'opencode';
}

// Nested swarm spawn event payload (SWARM_SPAWN_*). `status` mirrors the
// sub_agent_spawns row: a gated-out spawn carries its reject_reason.
export interface SwarmSpawnEventPayload {
  spawn_id: string;
  spawn_tree_id: string;
  parent_lease_id: string | null;
  child_lease_id: string | null;
  depth: number;
  runtime: string;
  role: string;
  status: 'requested' | 'prepared' | 'completed' | 'gated_out';
  reject_reason?: string;
}
