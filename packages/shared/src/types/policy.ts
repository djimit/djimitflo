/**
 * Policy-related types (sandbox and approval policies)
 */

import { ID, Timestamps, ApprovalStatus, RiskLevel } from './common';

export interface SandboxPolicy extends Timestamps {
  id: ID;
  name: string;
  description: string;
  enabled: boolean;
  priority: number; // Higher = evaluated first
  
  // Restrictions
  allow_filesystem_write: boolean;
  allowed_paths: string[];
  blocked_paths: string[];
  
  allow_network: boolean;
  allowed_domains: string[];
  blocked_domains: string[];
  
  allow_shell_commands: boolean;
  allowed_commands: string[];
  blocked_commands: string[];
  
  allow_env_vars: boolean;
  allowed_env_vars: string[];
  blocked_env_vars: string[];
  
  // Limits
  max_file_size_bytes: number | null;
  max_execution_time_ms: number | null;
  max_token_usage: number | null;
  
  metadata: Record<string, unknown>;
}

export interface ApprovalPolicy extends Timestamps {
  id: ID;
  name: string;
  description: string;
  enabled: boolean;
  priority: number; // Higher = evaluated first
  
  // Conditions
  risk_levels: RiskLevel[];
  tool_patterns: string[]; // Glob patterns
  file_patterns: string[]; // Glob patterns
  
  // Action
  requires_approval: boolean;
  auto_approve: boolean;
  
  // Timeout
  approval_timeout_ms: number | null;
  
  metadata: Record<string, unknown>;
}

export interface Approval extends Timestamps {
  id: ID;
  task_id: ID;
  execution_event_id: ID | null;
  status: ApprovalStatus;
  risk_level: RiskLevel;
  
  // Request details
  request_type: ApprovalRequestType;
  request_message: string;
  request_data: Record<string, unknown>;
  
  // Response
  approved_by: string | null; // User ID or "system"
  approved_at: string | null;
  denied_at: string | null;
  denial_reason: string | null;
  expires_at: string | null;
  
  metadata: Record<string, unknown>;
}

export enum ApprovalRequestType {
  TOOL_CALL = 'tool_call',
  FILE_WRITE = 'file_write',
  SHELL_COMMAND = 'shell_command',
  NETWORK_REQUEST = 'network_request',
  HIGH_RISK_ACTION = 'high_risk_action',
}

export interface SandboxPolicyCreateInput {
  name: string;
  description: string;
  enabled?: boolean;
  priority?: number;
  allow_filesystem_write?: boolean;
  allowed_paths?: string[];
  blocked_paths?: string[];
  allow_network?: boolean;
  allowed_domains?: string[];
  blocked_domains?: string[];
  allow_shell_commands?: boolean;
  allowed_commands?: string[];
  blocked_commands?: string[];
  allow_env_vars?: boolean;
  allowed_env_vars?: string[];
  blocked_env_vars?: string[];
  max_file_size_bytes?: number;
  max_execution_time_ms?: number;
  max_token_usage?: number;
  metadata?: Record<string, unknown>;
}

export interface ApprovalPolicyCreateInput {
  name: string;
  description: string;
  enabled?: boolean;
  priority?: number;
  risk_levels?: RiskLevel[];
  tool_patterns?: string[];
  file_patterns?: string[];
  requires_approval?: boolean;
  auto_approve?: boolean;
  approval_timeout_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface ApprovalDecision {
  approval_id: ID;
  approved: boolean;
  reason?: string;
}
