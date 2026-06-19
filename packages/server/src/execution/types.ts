/**
 * Execution engine types and interfaces
 */

import { Task, ExecutionEventCreateInput } from '@djimitflo/shared';

/**
 * Executor kinds supported by the system
 */
export type ExecutorKind = 'mock' | 'opencode' | 'codex' | 'claude' | 'gemini' | 'editor' | 'custom';

/**
 * Execution session status
 */
export type ExecutionStatus = 
  | 'starting' 
  | 'running' 
  | 'paused' 
  | 'awaiting_approval'
  | 'completed' 
  | 'failed' 
  | 'cancelled';

/**
 * Execution result returned when execution completes
 */
export interface ExecutionResult {
  status: 'completed' | 'failed' | 'cancelled';
  message: string;
  error?: string;
  artifacts?: ExecutionArtifact[];
  metrics?: ExecutionMetrics;
}

/**
 * Execution artifact (files, diffs, logs, etc.)
 */
export interface ExecutionArtifact {
  type: 'file' | 'diff' | 'log' | 'screenshot' | 'output' | 'error';
  path: string;
  content?: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Execution metrics
 */
export interface ExecutionMetrics {
  executionTimeMs: number;
  tokenUsage?: number;
  toolCalls?: number;
  approvalsRequested?: number;
}

/**
 * Execution session - represents an active task execution
 */
export interface ExecutionSession {
  id: string;
  taskId: string;
  executorKind: ExecutorKind;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  
  /**
   * Stream of execution events (AsyncIterable for streaming)
   */
  events: AsyncIterable<ExecutionEventCreateInput>;
  
  /**
   * Promise that resolves when execution completes
   */
  result: Promise<ExecutionResult>;
  
  /**
   * Cancel the execution
   */
  cancel(): Promise<void>;
  
  /**
   * Pause the execution (if supported by executor)
   */
  pause?(): Promise<void>;
  
  /**
   * Resume the execution (if supported by executor)
   */
  resume?(): Promise<void>;
}

/**
 * Task executor interface - implemented by all execution backends
 */
export interface TaskExecutor {
  /**
   * Executor kind identifier
   */
  readonly kind: ExecutorKind;
  
  /**
   * Start executing a task
   */
  start(task: Task, options?: ExecutorOptions): Promise<ExecutionSession>;
  
  /**
   * Check if this executor can handle the given task
   */
  canExecute(task: Task): boolean;
}

/**
 * Executor configuration options
 */
export interface ExecutorOptions {
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeout?: number; // milliseconds
  model?: string;
  agentKind?: string; // OpenCode agent: build, plan, explore, scout, or custom
  skipPermissions?: boolean; // bypass OpenCode permission prompts (requires explicit opt-in)
  format?: 'json' | 'default'; // output format (default: json for structured parsing)
  approvalCallback?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
}

/**
 * Approval request from executor
 */
export interface ApprovalRequest {
  type: 'tool_call' | 'file_write' | 'shell_command' | 'network_request' | 'high_risk_action';
  message: string;
  data: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Approval response
 */
export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
  timeout?: number; // milliseconds
}

/**
 * Executor factory - creates appropriate executor for a task
 */
export interface ExecutorFactory {
  /**
   * Create an executor for the given task
   */
  createExecutor(task: Task): TaskExecutor;
  
  /**
   * Register a new executor implementation
   */
  registerExecutor(kind: ExecutorKind, executor: TaskExecutor): void;
}
