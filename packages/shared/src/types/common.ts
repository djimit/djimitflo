/**
 * Common types and enums used across Djimitflo
 */

// Task-related enums
export enum TaskStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  PAUSED = 'paused',
  AWAITING_APPROVAL = 'awaiting_approval',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// Execution-related enums
export enum ExecutionMode {
  LOCAL = 'local',
  DRY_RUN = 'dry_run',
  REVIEW_ONLY = 'review_only',
  CLOUD_PLANNED = 'cloud_planned', // Future
}

export enum ExecutionEventType {
  TASK_CREATED = 'task.created',
  TASK_STARTED = 'task.started',
  TASK_PAUSED = 'task.paused',
  TASK_RESUMED = 'task.resumed',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  TASK_CANCELLED = 'task.cancelled',
  TOOL_CALL = 'tool.call',
  TOOL_RESULT = 'tool.result',
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_GRANTED = 'approval.granted',
  APPROVAL_DENIED = 'approval.denied',
  ARTIFACT_CREATED = 'artifact.created',
  ERROR = 'error',
  LOG = 'log',
}

// Agent-related enums
export enum AgentStatus {
  IDLE = 'idle',
  ACTIVE = 'active',
  PAUSED = 'paused',
  ERROR = 'error',
  OFFLINE = 'offline',
}

export enum AgentCapability {
  CODE_GENERATION = 'code_generation',
  CODE_REVIEW = 'code_review',
  TESTING = 'testing',
  DEPLOYMENT = 'deployment',
  RESEARCH = 'research',
  FILE_OPERATIONS = 'file_operations',
  SHELL_COMMANDS = 'shell_commands',
  WEB_BROWSING = 'web_browsing',
}

// Security-related enums
export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DENIED = 'denied',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export type ActionType =
  | 'command'
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'network_access'
  | 'mcp_tool_call'
  | 'process_spawn'
  | 'git_operation'
  | 'task_execution'
  | 'unknown';

// MCP-related enums
export enum MCPServerStatus {
  RUNNING = 'running',
  STOPPED = 'stopped',
  ERROR = 'error',
  UNKNOWN = 'unknown',
}

export enum MCPToolPermission {
  ALLOWED = 'allowed',
  DENIED = 'denied',
  REQUIRES_APPROVAL = 'requires_approval',
}

// Audit-related enums
export enum AuditEventType {
  TASK_CREATED = 'task.created',
  TASK_EXECUTED = 'task.executed',
  TASK_APPROVED = 'task.approved',
  TASK_DENIED = 'task.denied',
  MCP_TOOL_CALLED = 'mcp.tool.called',
  POLICY_UPDATED = 'policy.updated',
  CONFIG_CHANGED = 'config.changed',
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_GRANTED = 'approval.granted',
  APPROVAL_DENIED = 'approval.denied',
  FILE_MODIFIED = 'file.modified',
  SHELL_EXECUTED = 'shell.executed',
  EXECUTION_PAUSED = 'execution.paused',
  EXECUTION_RESUMED = 'execution.resumed',
  EXECUTION_DENIED = 'execution.denied',
  POLICY_CREATED = 'policy.created',
  POLICY_VIOLATION = 'policy.violation',
  MCP_PERMISSION_CHANGED = 'mcp.permission.changed',
}

// Base timestamp fields
export interface Timestamps {
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

// Base ID type
export type ID = string;
