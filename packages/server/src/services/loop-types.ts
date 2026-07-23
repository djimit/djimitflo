/**
 * Shared type definitions for the loop subsystem.
 * Extracted from loop-service.ts to reduce coupling and improve maintainability.
 */

import type { Database } from 'better-sqlite3';
import type { LoopFinding } from './loop-discovery-service';
import type { GoalRecord, GoalCreateInput, GoalUpdateInput, DecomposedLoopCandidate } from './goal-service';

export type { GoalRecord, GoalCreateInput, GoalUpdateInput, DecomposedLoopCandidate };
export type { LoopFinding };

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export type LoopRunStatus = 'created' | 'planning' | 'running' | 'verifying' | 'ready_for_human_merge' | 'blocked' | 'completed' | 'failed' | 'escalated' | 'cancelled' | 'interrupted';
export type GateStatus = 'pass' | 'fail' | 'skipped';
export type WorkerRole = 'planner' | 'maker' | 'checker' | 'security_checker' | 'memory_curator' | 'governance_guard';

export type LoopName =
  | 'doc-drift-and-small-fix-loop'
  | 'repo-maintenance-loop'
  | 'skill-quality-loop'
  | 'mcp-connector-validation-loop'
  | 'security-regression-loop'
  | 'okf-synchronization-loop'
  | 'overwatch-policy-drift-loop';

export interface LoopContract {
  name: LoopName;
  title: string;
  description: string;
  mode: 'closed';
  risk_class: RiskClass;
  trigger: string[];
  context_sources: string[];
  actions_allowed: string[];
  actions_forbidden: string[];
  verification: string[];
  state: string[];
  escalation: string[];
  stop_conditions: string[];
}

export interface LoopGate {
  name: string;
  status: GateStatus;
  evidence: string;
}

export interface LoopRunRecord {
  id: string;
  goal_id: string | null;
  loop_name: string;
  mode: 'closed' | 'open';
  status: LoopRunStatus;
  repository_path: string | null;
  state_file: string | null;
  findings: LoopFinding[];
  plan: Record<string, unknown>;
  gates: LoopGate[];
  next_actions: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkerLeaseRecord {
  id: string;
  loop_run_id: string;
  role: WorkerRole;
  runtime: string;
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled';
  finding_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  budget: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  parent_lease_id: string | null;
  spawn_tree_id: string | null;
  depth: number;
  spawned_by_agent_id: string | null;
}

export interface LoopEventRecord {
  id: string;
  loop_run_id: string;
  event_type: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface StartDocDriftLoopInput {
  loop_name?: LoopName;
  goal_id?: string;
  repository_path?: string;
  max_findings?: number;
  sovereign?: boolean;
}

export interface ContinueLoopInput {
  finding_ids?: string[];
  max_assignments?: number;
  max_maker_workers?: number;
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'pi' | 'mock';
}

export interface RetryLoopInput {
  maker_lease_id?: string;
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'pi' | 'mock';
  max_retries?: number;
}

export interface SplitLoopInput {
  finding_id?: string;
  reason?: string;
  children?: Array<{
    message?: string;
    suggested_fix?: string;
    file?: string;
    line?: number;
  }>;
}

export interface RuntimeContract {
  runtime: 'manual' | 'mock' | 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi';
  available: boolean;
  command: string | null;
  version?: string;
  status: 'ok' | 'drifted' | 'unavailable';
  probed_at?: string;
  cwd_flag?: string;
  json_flag?: string | string[];
  supports_json_events: boolean;
  supports_usage_parsing: boolean;
  supports_timeout_kill: boolean;
  evidence: string[];
  reason?: string;
}

export interface RuntimeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens: number;
  usage_source: 'runtime_stdout';
}

export interface RuntimeExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timedOutAt?: string;
  stdout: string;
  stderr: string;
  runtimePid?: number;
}

export interface RuntimeStopResult {
  stopMode: 'kill' | 'stop' | 'best_effort_no_process_handle';
  killAttempted: boolean;
}

export interface RuntimeProcessHandle {
  child: import('child_process').ChildProcess;
  leaseId: string;
  command: string;
  args: string[];
  startedAt: string;
  timeoutHandle?: NodeJS.Timeout;
}

export type RuntimeManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';

export interface CheckerVerdictInput {
  lease_id?: string;
  maker_lease_id?: string;
  verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence';
  notes?: string;
}

export interface RunChecksInput {
  lease_id?: string;
  timeout_ms?: number;
  scripts?: string[];
}

export interface ExecuteMakerInput {
  lease_id?: string;
  timeout_ms?: number;
  diff_max_lines?: number;
  skip_permissions?: boolean;
}

export interface ExecuteCheckerInput extends ExecuteMakerInput {
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock';
}

export type LoopDatabaseHandle = Database;
