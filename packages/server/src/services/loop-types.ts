/**
 * Shared type definitions for the loop subsystem.
 * Extracted from loop-service.ts to reduce coupling and improve maintainability.
 */

import type { Database } from 'better-sqlite3';
import type { LoopFinding } from './loop-discovery-service';
import type { GoalRecord, GoalCreateInput, GoalUpdateInput, DecomposedLoopCandidate } from './goal-service';
import type { LoopName } from '@djimitflo/shared';

export type { GoalRecord, GoalCreateInput, GoalUpdateInput, DecomposedLoopCandidate };
export type { LoopFinding };

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export type LoopRunStatus = 'created' | 'planning' | 'running' | 'verifying' | 'ready_for_human_merge' | 'blocked' | 'completed' | 'failed' | 'escalated' | 'cancelled' | 'interrupted';
/**
 * E2 observation validity: 'fail' = durable evidence shows the invariant failed; 'unknown' = the evidence needed to decide is
 * missing/unavailable (insufficient evidence — never a negative verdict, but still blocks certification/completion/merge);
 * 'skipped' = genuinely not applicable to this run.
 */
export type GateStatus = 'pass' | 'fail' | 'unknown' | 'skipped';
export type WorkerRole = 'planner' | 'maker' | 'checker' | 'security_checker' | 'memory_curator' | 'governance_guard';

export type { LoopName };

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

/**
 * P0-8: the one "this gate passed" rule. A security review that was skipped (the run is not high-risk) counts as a pass —
 * certification (certifyLoopRun) and the daemon's learning outcome (skill_outcomes, bandit, proposal outcome) both use it,
 * so a run is never 'regressed' for a learner while 'verified' in outcome_credits.
 */
export const gatePasses = (gate: Pick<LoopGate, 'name' | 'status'>): boolean =>
  gate.status === 'pass' || (gate.name === 'security_checker_verdict' && gate.status === 'skipped');
/** P0-8: every gate passed under {@link gatePasses}; no gates is not a pass. */
export const allGatesPassed = (gates: ReadonlyArray<Pick<LoopGate, 'name' | 'status'>>): boolean => gates.length > 0 && gates.every(gatePasses);

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
  /** A caller-supplied, bounded finding for the fix pipeline. */
  target_finding?: {
    file_path: string;
    description: string;
    category: 'bug' | 'security' | 'performance' | 'refactor';
  };
  /**
   * Synthesizes a single LoopFinding from goal_id's objective instead of
   * running discovery. Requires goal_id to resolve to a real goal — fails
   * loudly (OBJECTIVE_MODE_REQUIRES_GOAL) rather than silently falling back
   * to discovery, so an objective-mode run can never be mistaken for a
   * doc-drift no-op. See LoopService.createObjectiveFinding().
   */
  objective_mode?: boolean;
}

export interface ContinueLoopInput {
  finding_ids?: string[];
  max_assignments?: number;
  max_maker_workers?: number;
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'pi' | 'mock';
  /** Explicit model choice; advisory routing never supplies this implicitly. */
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface RetryLoopInput {
  maker_lease_id?: string;
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'pi' | 'mock';
  max_retries?: number;
  /** Explicit model choice; advisory routing never supplies this implicitly. */
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Evolve (E13): an extra maker next to a successful one, not a retry after failure; selection decides later. */
  sibling?: boolean;
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
  runtime: 'manual' | 'mock' | 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'atomic' | 'remote';
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
  conformance?: {
    status: 'pass' | 'fail' | 'manual';
    proof_class: 'static' | 'runtime_probe';
    contract_hash: string;
    checks: Array<{ name: string; passed: boolean; evidence: string }>;
  };
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
  events?: import('@djimitflo/shared').ExecutionEventCreateInput[];
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
  stop?: () => void;
}

export type RuntimeManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';

export interface CheckerVerdictInput {
  lease_id?: string;
  maker_lease_id?: string;
  verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence';
  notes?: string;
  /**
   * P1a: manual-runtime verdicts require explicit attestation (reviewer + reason). P0-5: reviewer_type says what reviewed —
   * 'heuristic' (an automated rule, e.g. the PR-review webhook) is never a human or independent review; absent = legacy/human.
   */
  manual_attestation?: { reviewer: string; reason: string; reviewer_type?: 'human' | 'heuristic' };
}

/**
 * P0-4: the authenticated principal that submits a verdict (route layer: req.user). Only a verdict submitted with an actor
 * is recorded as human attestation; the body's reviewer string is never trusted as identity.
 */
export interface VerdictActor {
  id: string;
  email?: string;
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
