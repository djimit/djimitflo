/**
 * Execution-related types
 */

import { ID, Timestamps, ExecutionEventType, RiskLevel } from './common';

export interface ExecutionEvent extends Timestamps {
  id: ID;
  task_id: ID;
  event_type: ExecutionEventType;
  timestamp: string; // ISO 8601
  
  // Event details
  message: string;
  level: LogLevel;
  
  // Tool call tracking
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  tool_output: unknown | null;
  tool_error: string | null;
  
  // Approval tracking
  approval_id: ID | null;
  
  // Artifact tracking
  artifact_id: ID | null;
  
  // Metadata
  metadata: Record<string, unknown>;
}

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export interface ToolCall {
  id: ID;
  execution_event_id: ID;
  task_id: ID;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: unknown | null;
  error: string | null;
  risk_level: RiskLevel;
  requires_approval: boolean;
  approval_id: ID | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface ExecutionEventCreateInput {
  task_id: ID;
  event_type: ExecutionEventType;
  message: string;
  level?: LogLevel;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_error?: string;
  approval_id?: ID;
  artifact_id?: ID;
  metadata?: Record<string, unknown>;
}
