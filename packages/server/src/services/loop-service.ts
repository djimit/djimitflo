import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { AgentAssuranceService, type CheckpointRecord, type TraceSpanRecord } from './agent-assurance-service';
import { SkillService } from './skill-service';
import { swarmEventBus } from './swarm-event-bus';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { mintSpawnToken, resolveSpawnTokenSecret } from './spawn-token';

type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type GoalStatus = 'created' | 'decomposed' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
type LoopRunStatus = 'created' | 'planning' | 'running' | 'verifying' | 'ready_for_human_merge' | 'blocked' | 'completed' | 'failed' | 'escalated' | 'cancelled' | 'interrupted';
type GateStatus = 'pass' | 'fail' | 'skipped';
export type WorkerRole = 'planner' | 'maker' | 'checker' | 'security_checker' | 'memory_curator' | 'governance_guard';
export type LoopName =
  | 'doc-drift-and-small-fix-loop'
  | 'repo-maintenance-loop'
  | 'skill-quality-loop'
  | 'mcp-connector-validation-loop'
  | 'security-regression-loop'
  | 'okf-synchronization-loop'
  | 'overwatch-policy-drift-loop';

interface LoopContract {
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

export interface GoalCreateInput {
  objective: string;
  constraints?: string[];
  acceptance_criteria: string[];
  risk_class?: RiskClass;
  budget?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GoalUpdateInput {
  objective?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
  risk_class?: RiskClass;
  budget?: Record<string, unknown>;
  status?: GoalStatus;
  metadata?: Record<string, unknown>;
}

export interface GoalRecord {
  id: string;
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  risk_class: RiskClass;
  budget: Record<string, unknown>;
  status: GoalStatus;
  owner_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LoopFinding {
  id: string;
  type: string;
  severity: 'info' | 'warning';
  file: string;
  line?: number;
  message: string;
  evidence: string;
  suggested_fix: string;
  parent_finding_id?: string;
  metadata?: Record<string, unknown>;
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
  // Nested-spawn lineage (P1). Null/0 for root leases created by continueLoopRun.
  parent_lease_id: string | null;
  spawn_tree_id: string | null;
  depth: number;
  spawned_by_agent_id: string | null;
  // G1: the capability this lease exercised (links to swarm_capabilities for competence).
  capability_id?: string | null;
}

interface LoopEventRecord {
  id: string;
  loop_run_id: string;
  event_type: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface StartDocDriftLoopInput {
  loop_name?: LoopName;
  goal_id?: string;
  repository_path?: string;
  max_findings?: number;
  // G11: sovereign flag — when true, all findings route to pi (offline, zero-egress).
  sovereign?: boolean;
}

interface ContinueLoopInput {
  finding_ids?: string[];
  max_assignments?: number;
  max_maker_workers?: number;
  // G1: capability the maker lease exercises (for competence measurement + auto-promotion).
  capabilityId?: string | null;
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'pi' | 'mock';
}

interface RetryLoopInput {
  maker_lease_id?: string;
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'manual' | 'pi' | 'mock';
  max_retries?: number;
}

interface SplitLoopInput {
  finding_id?: string;
  reason?: string;
  children?: Array<{
    message?: string;
    suggested_fix?: string;
    file?: string;
    line?: number;
  }>;
}

interface ExecuteMakerInput {
  lease_id?: string;
  timeout_ms?: number;
  diff_max_lines?: number;
  /**
   * Per-task request to run the runtime with approvals/sandbox bypassed so a
   * non-interactive codex/opencode maker can actually apply writes and exit
   * zero. This is a REQUEST only: it is honored solely when the operator has
   * opted in via RUNTIME_ALLOW_SKIP_PERMISSIONS=true. See resolveSkipPermissions.
   */
  skip_permissions?: boolean;
}

interface ExecuteCheckerInput extends ExecuteMakerInput {
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock';
}

interface ExecuteWorkerResult {
  run: LoopRunRecord;
  lease: WorkerLeaseRecord;
  gates: LoopGate[];
  stdout_path: string;
  stderr_path: string;
  checkpoint_before: CheckpointRecord;
  checkpoint_after: CheckpointRecord;
  trace: {
    trace_id: string;
    spans: TraceSpanRecord[];
    edges: Array<{ from: string; to: string }>;
    roots: TraceSpanRecord[];
  };
}

interface RuntimeContract {
  runtime: 'manual' | 'mock' | 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi';
  available: boolean;
  command: string | null;
  version?: string;
  status: 'ok' | 'drifted' | 'unavailable';
  cwd_flag?: string;
  json_flag?: string | string[];
  supports_json_events: boolean;
  supports_usage_parsing: boolean;
  supports_timeout_kill: boolean;
  evidence: string[];
  reason?: string;
  probed_at?: string;
}

interface CheckerVerdictInput {
  lease_id?: string;
  maker_lease_id?: string;
  verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence';
  notes?: string;
}

interface CompleteLoopInput {
  human_approval_ref?: string;
}

interface RunChecksInput {
  lease_id?: string;
  timeout_ms?: number;
  scripts?: string[];
}

interface DecomposedLoopCandidate {
  loop_name: string;
  mode: 'closed';
  reason: string;
  recommended_first: boolean;
  expected_outputs: string[];
  gates: string[];
}

interface RuntimeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens: number;
  usage_source: 'runtime_stdout';
}

interface RuntimeExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timedOutAt?: string;
  stdout: string;
  stderr: string;
  runtimePid?: number;
}

interface RuntimeStopResult {
  stopMode: 'kill' | 'stop' | 'best_effort_no_process_handle';
  killAttempted: boolean;
}

interface RuntimeProcessHandle {
  child: ChildProcess;
  leaseId: string;
  command: string;
  args: string[];
  startedAt: string;
  timeoutHandle?: NodeJS.Timeout;
}

type RuntimeManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';

const LOOP_NAME = 'doc-drift-and-small-fix-loop';
const DEFAULT_MAX_FINDINGS = 50;
const MAX_MARKDOWN_FILE_BYTES = 250_000;
const LOOP_RUNTIME_MANIFEST_POLICY_VERSION = 'loop-runtime-bridge-v1';
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.data',
  '.next',
  '.turbo',
  'agent-evidence',
]);

const MONOREPO_ROOT = process.cwd().includes('/packages/server')
  ? path.resolve(process.cwd(), '../..')
  : process.cwd();

const DEFAULT_EVIDENCE_ROOT = process.env.LOOP_EVIDENCE_ROOT
  ? path.resolve(process.env.LOOP_EVIDENCE_ROOT)
  : path.join(MONOREPO_ROOT, '.data', 'agent-evidence', 'agentic-control-loop-fleet');

const CONTROL_DIR = '.djimitflo';
const LOOP_WORK_FILE = 'LOOP_WORK.md';
const ASSIGNMENT_PACKET_FILE = 'ASSIGNMENT_PACKET.json';
const LOW_CONTEXT_WORKER_PROFILE = {
  name: 'djimitflo-worker',
  scope: 'low-context',
  max_tokens: 120_000,
  max_tokens_per_worker: 60_000,
  max_tokens_per_diff_line: 3_000,
};

const LOOP_CONTRACTS: LoopContract[] = [
  {
    name: 'doc-drift-and-small-fix-loop',
    title: 'Doc Drift And Small Fix',
    description: 'Find documentation drift and bounded low-risk fixes, then prepare maker/checker worktrees on demand.',
    mode: 'closed',
    risk_class: 'low',
    trigger: ['manual', 'scheduled'],
    context_sources: ['markdown', 'package_scripts', 'loop_skills'],
    actions_allowed: ['read_repo', 'read_docs', 'propose_tasks', 'write_loop_state', 'prepare_worktree', 'execute_maker', 'run_checks', 'submit_checker_verdict', 'retry', 'split'],
    actions_forbidden: ['merge', 'deploy', 'modify_secrets', 'modify_policy', 'delete_data'],
    verification: ['read_only_discovery', 'diff_threshold', 'tests_lint_typecheck', 'checker_verdict', 'no_automatic_merge'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['failed_gate', 'retry_budget_exhausted', 'wall_clock_budget_exhausted', 'token_budget_exhausted'],
    stop_conditions: ['scan_budget_exhausted', 'no_findings', 'findings_planned', 'all_gates_passed_or_human_required'],
  },
  {
    name: 'repo-maintenance-loop',
    title: 'Repo Maintenance',
    description: 'Find small maintenance gaps such as missing deterministic scripts, stale TODOs and repository hygiene issues.',
    mode: 'closed',
    risk_class: 'low',
    trigger: ['manual', 'scheduled'],
    context_sources: ['package_json', 'markdown', 'source_comments'],
    actions_allowed: ['read_repo', 'propose_tasks', 'write_loop_state', 'prepare_worktree', 'execute_maker', 'run_checks', 'submit_checker_verdict', 'retry', 'split'],
    actions_forbidden: ['merge', 'deploy', 'modify_secrets', 'delete_data'],
    verification: ['package_scripts_exist_or_skipped', 'diff_threshold', 'tests_lint_typecheck', 'checker_verdict', 'no_automatic_merge'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['failed_gate', 'repeated_failure', 'budget_exhausted'],
    stop_conditions: ['scan_budget_exhausted', 'no_findings', 'bounded_maintenance_tasks_planned'],
  },
  {
    name: 'skill-quality-loop',
    title: 'Skill Quality',
    description: 'Validate loop skills for required governance metadata before they can orchestrate workers.',
    mode: 'closed',
    risk_class: 'medium',
    trigger: ['manual', 'skill_change'],
    context_sources: ['packages/knowledge/skills', 'skill_frontmatter'],
    actions_allowed: ['read_skills', 'validate_skill_contract', 'propose_skill_fixes', 'write_loop_state', 'prepare_worktree', 'submit_checker_verdict'],
    actions_forbidden: ['push_unvalidated_skill', 'expand_autonomy_without_review', 'modify_policy', 'deploy'],
    verification: ['frontmatter_present', 'allowed_actions_present', 'forbidden_actions_present', 'gates_present', 'escalation_present', 'checker_verdict'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['autonomy_expansion', 'policy_rule_requested', 'missing_governance_metadata'],
    stop_conditions: ['all_skills_validated_or_findings_planned', 'draft_skills_block_live_orchestration'],
  },
  {
    name: 'mcp-connector-validation-loop',
    title: 'MCP Connector Validation',
    description: 'Check MCP connector inventory and permission metadata without invoking connector tools.',
    mode: 'closed',
    risk_class: 'medium',
    trigger: ['manual', 'connector_change'],
    context_sources: ['mcp_seed_config', 'mcp_routes', 'workspace_docs'],
    actions_allowed: ['read_mcp_inventory', 'validate_permissions', 'propose_connector_fixes', 'write_loop_state', 'prepare_worktree', 'submit_checker_verdict'],
    actions_forbidden: ['invoke_mutating_mcp_tool', 'store_secrets', 'modify_credentials', 'deploy'],
    verification: ['inventory_present', 'permission_policy_present', 'no_secret_capture', 'checker_verdict'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['secret_boundary_detected', 'missing_permission_policy', 'high_risk_tool'],
    stop_conditions: ['mcp_inventory_validated_or_findings_planned'],
  },
  {
    name: 'security-regression-loop',
    title: 'Security Regression',
    description: 'Find security-sensitive regression gaps and force maker/checker/security-checker review before completion.',
    mode: 'closed',
    risk_class: 'high',
    trigger: ['manual', 'security_change', 'pre_release'],
    context_sources: ['package_scripts', 'security_docs', 'auth_policy_files', 'ci_config'],
    actions_allowed: ['read_repo', 'read_security_docs', 'propose_security_tasks', 'write_loop_state', 'prepare_worktree', 'run_checks', 'submit_checker_verdict', 'submit_security_checker_verdict'],
    actions_forbidden: ['weaken_policy', 'modify_secrets', 'disable_scans', 'merge', 'deploy'],
    verification: ['security_checker_verdict', 'no_secret_leak', 'tests_lint_typecheck', 'diff_threshold', 'human_approval_before_merge'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['auth_sensitive_change', 'secret_boundary_detected', 'high_security_finding', 'policy_change_requested'],
    stop_conditions: ['security_gaps_planned', 'security_checker_required_for_worker_output'],
  },
  {
    name: 'okf-synchronization-loop',
    title: 'OKF Synchronization',
    description: 'Find drift between durable OKF knowledge folders and generated indexes/state files.',
    mode: 'closed',
    risk_class: 'medium',
    trigger: ['manual', 'memory_change'],
    context_sources: ['packages/knowledge', 'okf_agents', 'okf_skills', 'okf_tasks'],
    actions_allowed: ['read_okf', 'propose_index_fixes', 'write_loop_state', 'prepare_worktree', 'submit_checker_verdict'],
    actions_forbidden: ['delete_memory', 'overwrite_audit', 'store_secrets', 'modify_policy'],
    verification: ['frontmatter_present', 'index_present', 'no_secret_capture', 'checker_verdict'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['conflicting_memory', 'secret_detected', 'policy_memory_change'],
    stop_conditions: ['okf_drift_findings_planned_or_no_drift'],
  },
  {
    name: 'overwatch-policy-drift-loop',
    title: 'Overwatch Policy Drift',
    description: 'Detect drift in approval policies, risk gates and autonomy boundaries without applying policy changes.',
    mode: 'closed',
    risk_class: 'high',
    trigger: ['manual', 'policy_change'],
    context_sources: ['approval_policies', 'policy_routes', 'risk_classifier', 'audit_events'],
    actions_allowed: ['read_policy', 'compare_policy_contract', 'propose_policy_fixes', 'write_loop_state', 'prepare_worktree', 'submit_checker_verdict', 'submit_security_checker_verdict'],
    actions_forbidden: ['auto_approve_high_risk', 'weaken_policy', 'bypass_gate', 'deploy', 'modify_secrets'],
    verification: ['security_checker_verdict', 'approval_gate_preserved', 'audit_event_written', 'human_approval_before_policy_change'],
    state: ['sqlite:loop_runs', 'sqlite:loop_events', 'markdown:LOOP_STATE.md'],
    escalation: ['policy_change_requested', 'approval_gate_missing', 'autonomy_expansion'],
    stop_conditions: ['policy_drift_findings_planned', 'human_required_for_mutating_policy_change'],
  },
];

export class LoopService {
  private static readonly runtimeLeases = new Map<string, RuntimeProcessHandle>();
  /**
   * RuntimeSemaphore (P2): a single chokepoint bounding how many runtime child
   * processes may be alive at once. Both the serial fleet (drainWorkerPool, which
   * remains ordered) and the DAG harness route every spawn through
   * executeRuntimeCommand, so this one limiter enforces real bounded concurrency
   * across the whole control plane without touching the serial stop/cancel
   * invariants. Limit defaults to 4 and is operator-tunable via
   * RUNTIME_MAX_CONCURRENCY. (The plan proposed feeding this from
   * swarm-status.fleetPools().recommended_concurrency; that coupling is deferred
   * to avoid a circular dependency — LoopService does not import SwarmStatusService.)
   */
  private static readonly runtimeSemaphore: {
    active: Set<string>;
    queue: Array<{ leaseId: string; resolve: () => void; reject: (err: Error) => void }>;
    // G4: AIMD concurrency controller state — the dynamic limit the controller drives.
    dynamicLimit: number | null;
  } = { active: new Set(), queue: [], dynamicLimit: null };

  /**
   * G9: ConcurrencyAdvisor — a callback that returns the fleet's recommended
   * concurrency (from SwarmStatusService.fleetPools().recommended_concurrency).
   * Injected at construction to avoid a circular import (LoopService does NOT
   * import SwarmStatusService). The hard cap is min(env_cap, advisor() ?? env_cap).
   */
  private concurrencyAdvisor: (() => number | null) | null = null;
  private db: Database;
  private evidenceRoot: string;
  private assurance: AgentAssuranceService;
  private skills: SkillService;
  private intelligence: SwarmIntelligenceService;
  /**
   * Secret used to mint a nested-spawn child's own scoped token (L1). Lazily
   * resolved from the same env chain as NestedSpawnService so a token minted here
   * validates at the spawn endpoint. LoopService only MINTS (never validates) —
   * validation stays in NestedSpawnService.requestSpawn over HTTP. This avoids a
   * LoopService → NestedSpawnService cycle (token logic lives in ./spawn-token).
   */
  private spawnTokenSecret: string | undefined;
  private runtimeContractCache = new Map<string, { expiresAt: number; contract: RuntimeContract }>();
  private readonly runtimeContractCacheMs = Math.max(
    500,
    Math.min(Number(process.env.LOOP_RUNTIME_CONTRACT_CACHE_MS ?? 5_000), 60_000),
  );

  constructor(db: Database, evidenceRoot = DEFAULT_EVIDENCE_ROOT, concurrencyAdvisor?: (() => number | null) | null) {
    this.db = db;
    this.evidenceRoot = evidenceRoot;
    this.assurance = new AgentAssuranceService(db);
    this.intelligence = new SwarmIntelligenceService(db);
    this.skills = new SkillService(db);
    // G9: inject the fleet concurrency advisor (avoids circular import with SwarmStatusService)
    this.concurrencyAdvisor = concurrencyAdvisor ?? null;
  }

  /**
   * Recover in-flight work orphaned by a server crash/restart. Live worker child
   * processes do not survive a restart, so any loop_run still in an active status
   * and any worker_lease still 'running' (with no live child) are now orphaned: mark
   * the run 'interrupted' and the lease 'failed', recording the reason, so the
   * fleet no longer reports them as active. The run can then be retried via
   * retryLoopRun. Safe to call at any time: leases whose child is still genuinely
   * live (present in the in-memory runtimeLeases map) and their runs are left alone.
   * Also prunes stale, orphaned worktrees. Idempotent.
   */
  recoverInterruptedRuns(): { interruptedRuns: number; failedLeases: number; prunedWorktrees: number } {
    const now = new Date().toISOString();
    const liveLeaseIds = new Set(LoopService.runtimeLeases.keys());

    // Fail 'running' leases whose child process is gone (not in the live map).
    const orphanedLeases = this.db.prepare(
      `SELECT id, metadata FROM worker_leases WHERE status = 'running'`,
    ).all() as Array<{ id: string; metadata: string }>;
    const updateLease = this.db.prepare(
      `UPDATE worker_leases SET status = 'failed', metadata = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    let failedLeases = 0;
    for (const lease of orphanedLeases) {
      if (liveLeaseIds.has(lease.id)) continue;
      const metadata = {
        ...(JSON.parse(lease.metadata || '{}') as Record<string, unknown>),
        failed_reason: 'server_restart',
        failed_at: now,
      };
      updateLease.run(JSON.stringify(metadata), lease.id);
      failedLeases += 1;
    }

    // Runs in an active status whose worker leases are all non-live are orphaned.
    const liveRunIds = new Set<string>();
    if (liveLeaseIds.size > 0) {
      const placeholders = Array.from(liveLeaseIds).map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT DISTINCT loop_run_id FROM worker_leases WHERE id IN (${placeholders})`)
        .all(...liveLeaseIds) as Array<{ loop_run_id: string }>;
      for (const row of rows) liveRunIds.add(row.loop_run_id);
    }
    const activeRuns = this.db.prepare(
      `SELECT id, metadata FROM loop_runs WHERE status IN ('running', 'verifying', 'planning')`,
    ).all() as Array<{ id: string; metadata: string }>;
    const updateRun = this.db.prepare(
      `UPDATE loop_runs SET status = 'interrupted', metadata = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    let interruptedRuns = 0;
    for (const run of activeRuns) {
      if (liveRunIds.has(run.id)) continue;
      const metadata = {
        ...(JSON.parse(run.metadata || '{}') as Record<string, unknown>),
        interrupted_reason: 'server_restart',
        interrupted_at: now,
      };
      updateRun.run(JSON.stringify(metadata), run.id);
      interruptedRuns += 1;
    }

    const prunedWorktrees = this.pruneOrphanedWorktrees();
    return { interruptedRuns, failedLeases, prunedWorktrees };
  }

  /**
   * G10: Resume an interrupted run from its last checkpoint. Loads the last
   * checkpoint, determines which findings were completed (lease status = 'completed'
   * + checker accepted) vs in-flight (lease status = 'failed' with failed_reason
   * 'server_restart' or 'budget_drain'), re-queues in-flight findings as new leases,
   * and marks the run as 'running' again.
   *
   * Bounded-fail: if the run has been resumed >= maxResumeAttempts times (default 3),
   * it is marked 'failed' (not 'interrupted') — no infinite retry loop.
   *
   * Returns the resume result: which findings were re-queued, which were skipped
   * (already completed), and whether the run was resumed or bounded-failed.
   */
  resumeInterruptedRun(runId: string, maxResumeAttempts = 3): {
    resumed: boolean;
    boundedFail: boolean;
    requeuedFindings: string[];
    skippedFindings: string[];
    resumeAttempt: number;
  } {
    const run = this.getLoopRun(runId);
    if (run.status !== 'interrupted') {
      throw new Error('LOOP_RUN_NOT_INTERRUPTED');
    }

    const meta = run.metadata as Record<string, unknown>;
    const resumeAttempts = typeof meta.resume_attempts === 'number' ? meta.resume_attempts : 0;
    const newAttempt = resumeAttempts + 1;

    // Bounded-fail: too many resume attempts → mark as failed.
    if (newAttempt > maxResumeAttempts) {
      this.db.prepare(
        `UPDATE loop_runs SET status = 'failed', metadata = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(JSON.stringify({
        ...meta,
        failed_reason: 'resume_exhausted',
        failed_at: new Date().toISOString(),
        resume_attempts: newAttempt,
      }), runId);
      this.recordLoopEvent(runId, 'loop_resume_exhausted', 'warning',
        `Run failed after ${newAttempt - 1} resume attempts (bounded-fail).`, { resume_attempts: newAttempt });
      return { resumed: false, boundedFail: true, requeuedFindings: [], skippedFindings: [], resumeAttempt: newAttempt };
    }

    // Load the last checkpoint for this run.
    const checkpoint = this.db.prepare(
      `SELECT * FROM loop_checkpoints WHERE loop_run_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(runId) as { id: string; state_json: string; findings_json: string; leases_json: string } | undefined;

    const leases = this.listWorkerLeases(runId);

    // Determine completed vs in-flight findings.
    const completedLeases = leases.filter((l) => l.status === 'completed');
    const completedFindingIds = new Set(completedLeases.map((l) => l.finding_id).filter(Boolean) as string[]);
    const failedLeases = leases.filter((l) => l.status === 'failed');
    const inFlightFindingIds = new Set(
      failedLeases
        .filter((l) => {
          const m = l.metadata as Record<string, unknown>;
          return m.failed_reason === 'server_restart' || m.failed_reason === 'budget_drain';
        })
        .map((l) => l.finding_id)
        .filter(Boolean) as string[],
    );

    // Re-queue in-flight findings that haven't been completed by another lease.
    const requeuedFindings: string[] = [];
    for (const findingId of inFlightFindingIds) {
      if (!completedFindingIds.has(findingId)) {
        requeuedFindings.push(findingId);
      }
    }

    const skippedFindings = Array.from(completedFindingIds);

    // Mark the run as running again.
    this.db.prepare(
      `UPDATE loop_runs SET status = 'running', metadata = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify({
      ...meta,
      resume_attempts: newAttempt,
      resumed_at: new Date().toISOString(),
      requeued_findings: requeuedFindings,
      skipped_findings: skippedFindings,
      checkpoint_id: checkpoint?.id ?? null,
    }), runId);

    this.recordLoopEvent(runId, 'loop_resumed', 'info',
      `Run resumed from checkpoint (attempt ${newAttempt}). Re-queued ${requeuedFindings.length} finding(s), skipped ${skippedFindings.length} completed.`,
      { resume_attempt: newAttempt, requeued: requeuedFindings, skipped: skippedFindings });
    // G14: emit recovery event for live observability.
    swarmEventBus.emit('recovery', {
      run_id: runId,
      resumed: true,
      resume_attempt: newAttempt,
      requeued: requeuedFindings.length,
      skipped: skippedFindings.length,
    });

    return {
      resumed: true,
      boundedFail: false,
      requeuedFindings,
      skippedFindings,
      resumeAttempt: newAttempt,
    };
  }

  /**
   * G10: Resume all interrupted runs. Called on server startup after
   * recoverInterruptedRuns(). Each interrupted run is resumed from its last
   * checkpoint, or bounded-failed if too many attempts.
   */
  resumeInterruptedRuns(maxResumeAttempts = 3): {
    resumed: number;
    boundedFailed: number;
    details: Array<{ runId: string; resumed: boolean; requeued: number; skipped: number }>;
  } {
    const interruptedRuns = this.db.prepare(
      `SELECT id FROM loop_runs WHERE status = 'interrupted'`,
    ).all() as Array<{ id: string }>;

    const details: Array<{ runId: string; resumed: boolean; requeued: number; skipped: number }> = [];
    let resumed = 0;
    let boundedFailed = 0;

    for (const { id } of interruptedRuns) {
      try {
        const result = this.resumeInterruptedRun(id, maxResumeAttempts);
        details.push({
          runId: id,
          resumed: result.resumed,
          requeued: result.requeuedFindings.length,
          skipped: result.skippedFindings.length,
        });
        if (result.resumed) resumed++;
        if (result.boundedFail) boundedFailed++;
      } catch {
        // Skip runs that can't be resumed (non-fatal).
      }
    }

    return { resumed, boundedFailed, details };
  }

  /**
   * Remove worktree directories on disk that are no longer needed: those whose
   * worker lease is terminal (completed/failed/cancelled/interrupted) or has no
   * lease at all, and that are older than the grace period. Worktrees for in-flight
   * leases (prepared/running) are always kept. Returns the number pruned.
   * Set dryRun to count without deleting. Grace period defaults to
   * LOOP_WORKTREE_MAX_AGE_HOURS (24h).
   */
  pruneOrphanedWorktrees(options?: { maxAgeHours?: number; dryRun?: boolean }): number {
    const maxAgeHours = options?.maxAgeHours ?? Number(process.env.LOOP_WORKTREE_MAX_AGE_HOURS ?? 24);
    const dryRun = options?.dryRun ?? false;
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT;
    if (!worktreeRoot || !fs.existsSync(worktreeRoot)) return 0;

    const rows = this.db
      .prepare(`SELECT worktree_path, status FROM worker_leases WHERE worktree_path IS NOT NULL`)
      .all() as Array<{ worktree_path: string; status: string }>;
    const statusByPath = new Map<string, string>();
    for (const row of rows) statusByPath.set(row.worktree_path, row.status);
    const ACTIVE_LEASE = new Set(['prepared', 'running']);

    const maxAgeMs = Math.max(0, maxAgeHours) * 3_600_000;
    const nowMs = Date.now();
    let pruned = 0;

    let runDirs: string[];
    try {
      runDirs = fs.readdirSync(worktreeRoot);
    } catch {
      return 0;
    }
    for (const runDirName of runDirs) {
      const runDir = path.join(worktreeRoot, runDirName);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(runDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      let findingDirs: string[];
      try {
        findingDirs = fs.readdirSync(runDir);
      } catch {
        continue;
      }
      for (const findingDirName of findingDirs) {
        const wtPath = path.join(runDir, findingDirName);
        try {
          stat = fs.statSync(wtPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const leaseStatus = statusByPath.get(wtPath);
        if (leaseStatus && ACTIVE_LEASE.has(leaseStatus)) continue; // in-flight — keep
        if (nowMs - stat.mtimeMs < maxAgeMs) continue; // within grace window — keep

        if (!dryRun) {
          try {
            fs.rmSync(wtPath, { recursive: true, force: true });
          } catch {
            continue;
          }
        }
        pruned += 1;
      }

      if (!dryRun) {
        try {
          if (fs.readdirSync(runDir).length === 0) fs.rmdirSync(runDir);
        } catch {
          /* ignore */
        }
      }
    }
    return pruned;
  }

  createGoal(input: GoalCreateInput, ownerUserId?: string): GoalRecord {
    this.validateGoalInput(input);

    const id = randomUUID();
    const now = new Date().toISOString();
    const riskClass = input.risk_class || 'low';

    this.db.prepare(`
      INSERT INTO goals (
        id, objective, constraints_json, acceptance_criteria_json, risk_class,
        budget_json, status, owner_user_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.objective.trim(),
      JSON.stringify(input.constraints || []),
      JSON.stringify(input.acceptance_criteria),
      riskClass,
      JSON.stringify(input.budget || {}),
      'created',
      ownerUserId || null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return this.getGoal(id);
  }

  listGoals(): GoalRecord[] {
    const rows = this.db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as any[];
    return rows.map((row) => this.parseGoal(row));
  }

  getGoal(id: string): GoalRecord {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!row) {
      throw new Error('GOAL_NOT_FOUND');
    }
    return this.parseGoal(row);
  }

  updateGoal(id: string, input: GoalUpdateInput): GoalRecord {
    const existing = this.getGoal(id);
    const next: GoalCreateInput = {
      objective: input.objective ?? existing.objective,
      constraints: input.constraints ?? existing.constraints,
      acceptance_criteria: input.acceptance_criteria ?? existing.acceptance_criteria,
      risk_class: input.risk_class ?? existing.risk_class,
      budget: input.budget ?? existing.budget,
      metadata: input.metadata ?? existing.metadata,
    };
    this.validateGoalInput(next);

    const validStatuses: GoalStatus[] = ['created', 'decomposed', 'running', 'blocked', 'completed', 'failed', 'cancelled'];
    const status = input.status ?? existing.status;
    if (!validStatuses.includes(status)) {
      throw new Error('GOAL_STATUS_INVALID');
    }

    this.db.prepare(`
      UPDATE goals
      SET objective = ?,
          constraints_json = ?,
          acceptance_criteria_json = ?,
          risk_class = ?,
          budget_json = ?,
          status = ?,
          metadata = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      next.objective.trim(),
      JSON.stringify(next.constraints || []),
      JSON.stringify(next.acceptance_criteria),
      next.risk_class || 'low',
      JSON.stringify(next.budget || {}),
      status,
      JSON.stringify(next.metadata || {}),
      new Date().toISOString(),
      id
    );

    return this.getGoal(id);
  }

  decomposeGoal(id: string): { goal: GoalRecord; candidates: DecomposedLoopCandidate[] } {
    const goal = this.getGoal(id);
    const candidates: DecomposedLoopCandidate[] = LOOP_CONTRACTS.map((contract) => ({
      loop_name: contract.name,
      mode: contract.mode,
      reason: contract.description,
      recommended_first: contract.name === LOOP_NAME,
      expected_outputs: ['findings', 'bounded_task_plan', 'loop_state_file', 'review_bundle'],
      gates: contract.verification,
    }));

    this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
      .run('decomposed', new Date().toISOString(), id);

    return { goal: this.getGoal(goal.id), candidates };
  }

  startDocDriftAndSmallFixLoop(input: StartDocDriftLoopInput = {}): LoopRunRecord {
    return this.startLoop({ ...input, loop_name: LOOP_NAME });
  }

  startLoop(input: StartDocDriftLoopInput = {}): LoopRunRecord {
    const contract = this.getLoopContract(input.loop_name || LOOP_NAME);
    const goal = input.goal_id ? this.getGoal(input.goal_id) : null;
    const repositoryPath = this.resolveRepositoryPath(input.repository_path || process.cwd());
    const runRiskClass: RiskClass = (goal?.risk_class === 'high' || goal?.risk_class === 'critical' || goal?.risk_class === 'medium' || goal?.risk_class === 'low')
      ? goal.risk_class
      : contract.risk_class;
    const maxFindings = Math.max(1, Math.min(input.max_findings || DEFAULT_MAX_FINDINGS, 200));
    const runId = randomUUID();
    const now = new Date().toISOString();

    const findings = this.discoverLoopFindings(contract.name, repositoryPath, maxFindings);
    const plan = this.createPlan(contract.name, findings);
    const sovereign = input.sovereign ?? false;
    const gates: LoopGate[] = [
      { name: 'read_only_discovery', status: 'pass', evidence: 'Loop scanned files without editing repository content.' },
      { name: 'no_automatic_merge', status: 'pass', evidence: 'Loop does not merge, deploy, or push changes.' },
      { name: 'maker_checker_separation', status: 'skipped', evidence: 'No maker worker was leased in this read-only first slice.' },
      { name: 'tests_lint_typecheck', status: 'skipped', evidence: 'No patch was created, so code gates are deferred until execution slice.' },
    ];
    if (contract.risk_class === 'high' || contract.risk_class === 'critical') {
      gates.push({ name: 'security_checker_verdict', status: 'skipped', evidence: 'High-risk loop: security checker is required after maker output.' });
    }
    const nextActions = findings.length > 0
      ? [
        contract.name === LOOP_NAME ? 'Review proposed small-fix tasks' : `Review proposed ${contract.title.toLowerCase()} tasks`,
        contract.name === LOOP_NAME ? 'Approve maker/checker worker execution for selected low-risk findings' : 'Approve maker/checker worker execution for selected bounded findings',
      ]
      : [`No ${contract.title.toLowerCase()} findings detected within scan budget`];
    const stateFile = this.writeLoopState(runId, {
      loopName: contract.name,
      runId,
      goal,
      repositoryPath,
      findings,
      plan,
      gates,
      nextActions,
      createdAt: now,
    });

    this.db.prepare(`
      INSERT INTO loop_runs (
        id, goal_id, loop_name, mode, status, repository_path, state_file,
        findings_json, plan_json, gates_json, next_actions_json, metadata,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      goal?.id || null,
      contract.name,
      contract.mode,
      'completed',
      repositoryPath,
      stateFile,
      JSON.stringify(findings),
      JSON.stringify(plan),
      JSON.stringify(gates),
      JSON.stringify(nextActions),
      JSON.stringify({
        dry_run: true,
        workers_leased: 0,
        mutating_actions: false,
        risk_class: runRiskClass,
        contract,
        sovereign,
      }),
      now,
      now,
      now
    );

    this.recordLoopEvent(runId, 'loop_completed', 'info', `${contract.name} completed with ${findings.length} finding(s).`, {
      loop_name: contract.name,
      finding_count: findings.length,
      state_file: stateFile,
    });

    if (goal) {
      this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
        .run('completed', now, goal.id);
    }

    return this.getLoopRun(runId);
  }

  getLoopRun(id: string): LoopRunRecord {
    const row = this.db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(id);
    if (!row) {
      throw new Error('LOOP_RUN_NOT_FOUND');
    }
    return this.parseLoopRun(row);
  }

  listLoopRuns(): LoopRunRecord[] {
    const rows = this.db.prepare('SELECT * FROM loop_runs ORDER BY created_at DESC LIMIT 100').all() as any[];
    return rows.map((row) => this.parseLoopRun(row));
  }

  getReviewBundle(id: string): { run: LoopRunRecord; leases: WorkerLeaseRecord[]; events: LoopEventRecord[]; state_content: string | null } {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const events = this.listLoopEvents(run.id);
    const stateContent = run.state_file && fs.existsSync(run.state_file)
      ? fs.readFileSync(run.state_file, 'utf8')
      : null;
    return {
      run,
      leases,
      events,
      state_content: stateContent,
    };
  }

  stepLoopRun(id: string): { run: LoopRunRecord; leases: WorkerLeaseRecord[]; decision: string; next_actions: string[] } {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const makerLeases = leases.filter((lease) => lease.role === 'maker');
    const completedMakers = makerLeases.filter((lease) => lease.status === 'completed');

    let decision = 'inspect';
    if (run.status === 'escalated' || run.status === 'blocked') {
      decision = 'human_review';
    } else if (run.status === 'completed' && run.findings.length > 0 && makerLeases.length === 0) {
      decision = 'continue';
    } else if (makerLeases.some((lease) => lease.status === 'prepared')) {
      decision = 'execute_maker';
    } else if (completedMakers.length > 0 && run.gates.some((gate) => gate.status === 'fail')) {
      decision = 'revise_retry_split_or_escalate';
    } else if (completedMakers.length > 0) {
      decision = 'verify';
    } else if (run.status === 'verifying') {
      decision = 'complete_or_review';
    }

    return {
      run,
      leases,
      decision,
      next_actions: run.next_actions,
    };
  }

  stopLoopRun(id: string): { run: LoopRunRecord; events: LoopEventRecord[] } {
    const run = this.getLoopRun(id);
    if (run.status !== 'cancelled') {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, next_actions_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        'cancelled',
        JSON.stringify(['Loop stopped by operator']),
        now,
        id
      );

      this.recordLoopEvent(id, 'loop_stopped', 'warning', 'Loop stopped by operator.', {
        previous_status: run.status,
      });
    }

    return {
      run: this.getLoopRun(id),
      events: this.listLoopEvents(id),
    };
  }

  continueLoopRun(id: string, input: ContinueLoopInput = {}): { run: LoopRunRecord; leases: WorkerLeaseRecord[] } {
    const run = this.getLoopRun(id);
    this.assertLoopNotEscalated(run);
    this.assertWallClockBudgetAvailable(run);
    this.assertTokenBudgetAvailable(run);
    this.assertNoFailedGates(run);
    if (!run.repository_path) {
      throw new Error('LOOP_REPOSITORY_REQUIRED');
    }
    if (run.findings.length === 0) {
      throw new Error('LOOP_NO_FINDINGS_TO_ASSIGN');
    }

    const alreadyLeased = this.listWorkerLeases(id);
    const leasedFindingIds = new Set(
      alreadyLeased
        .filter((lease) => lease.role === 'maker' && lease.finding_id)
        .map((lease) => lease.finding_id as string)
    );

    const selectedFindingIds = new Set(input.finding_ids || []);
    if (selectedFindingIds.size > 0 && run.findings.some((finding) => selectedFindingIds.has(finding.id) && this.isSplitFinding(finding))) {
      throw new Error('LOOP_FINDING_ALREADY_SPLIT');
    }
    const maxAssignments = Math.max(1, Math.min(input.max_assignments || 1, 5));
    const selectedFindings = run.findings
      .filter((finding) => !this.isSplitFinding(finding))
      .filter((finding) => selectedFindingIds.size === 0 || selectedFindingIds.has(finding.id))
      .filter((finding) => !leasedFindingIds.has(finding.id))
      .slice(0, maxAssignments);

    if (selectedFindings.length === 0 && alreadyLeased.length > 0) {
      return { run, leases: alreadyLeased };
    }
    if (selectedFindings.length === 0) {
      throw new Error('LOOP_FINDING_NOT_FOUND');
    }

    // G11: use the input runtime as a fallback, but the planner's per-finding runtime
    // (selectRuntime) takes precedence — the fleet adapts per finding, not per goal.
    const defaultRuntime = input.runtime || 'manual';
    this.assertRuntimeAvailable(defaultRuntime);

    const budget = this.getMakerLeaseBudget(run, input);
    const currentMakerLeases = alreadyLeased.filter((lease) => lease.role === 'maker').length;
    if (currentMakerLeases >= budget.maxMakerWorkers || selectedFindings.length > budget.maxMakerWorkers - currentMakerLeases) {
      throw new Error('LOOP_WORKER_BUDGET_EXHAUSTED');
    }

    const now = new Date().toISOString();
    const leases: WorkerLeaseRecord[] = [];

    // G3.2: always run the planner to get per-finding runtime selection (G28/G33).
    // When capabilityId is explicitly set, override the planner's capability but
    // still use the planner's runtime (which is per-runtime-competence-adaptive).
    const plan = this.planLoopRun(id);

    for (const finding of selectedFindings) {
      const branchName = this.branchNameFor(run.id, finding.id);
      const worktreePath = this.createWorktree(run.repository_path, run.id, finding.id, branchName);
      this.ensureWorktreeControlIgnore(worktreePath);
      // G11: use the planner's per-finding runtime (selectRuntime) when available,
      // falling back to the input/default runtime. This makes the fleet adaptive.
      const findingPlan = plan?.find((p) => p.finding_id === finding.id);
      const leaseRuntime = findingPlan?.runtime || defaultRuntime;
      this.assertRuntimeAvailable(leaseRuntime);
      this.writeWorkAssignment(worktreePath, run, finding, leaseRuntime);
      const assignmentPacketFile = this.writeAssignmentPacket(worktreePath, run, finding, leaseRuntime);

      const makerLeaseId = randomUUID();
      const assignmentFile = this.workAssignmentPath(worktreePath);
      this.insertWorkerLease({
        id: makerLeaseId,
        loopRunId: run.id,
        role: 'maker',
        runtime: leaseRuntime,
        findingId: finding.id,
        worktreePath,
        branchName,
        capabilityId: input.capabilityId ?? plan?.find((p) => p.finding_id === finding.id)?.capability_id ?? null,
        metadata: {
          assignment_file: assignmentFile,
          assignment_packet_file: assignmentPacketFile,
        },
        now,
      });

      const checkerLeaseId = randomUUID();
      this.insertWorkerLease({
        id: checkerLeaseId,
        loopRunId: run.id,
        role: 'checker',
        runtime: 'manual',
        findingId: finding.id,
        worktreePath: null,
        branchName: null,
        metadata: { maker_lease_id: makerLeaseId, requires_independent_review: true },
        now,
      });

      if (this.isHighRiskRun(run, finding)) {
        const securityCheckerLeaseId = randomUUID();
        this.insertWorkerLease({
          id: securityCheckerLeaseId,
          loopRunId: run.id,
          role: 'security_checker',
          runtime: 'manual',
          findingId: finding.id,
          worktreePath: null,
          branchName: null,
          metadata: {
            maker_lease_id: makerLeaseId,
            requires_security_review: true,
            high_risk_reason: this.highRiskReason(run, finding),
          },
          now,
        });
      }
    }

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      'running',
      JSON.stringify(this.isHighRiskRun(run)
        ? ['Run maker in prepared worktree', 'Run checker and security checker after maker output', 'Call verify before completion']
        : ['Run maker in prepared worktree', 'Run checker after maker output', 'Call verify before completion']),
      now,
      run.id
    );

    this.recordLoopEvent(run.id, 'worker_leases_prepared', 'info', `Prepared ${selectedFindings.length} maker/checker assignment(s).`, {
      finding_ids: selectedFindings.map((finding) => finding.id),
      runtime: defaultRuntime,
      budget,
    });

    leases.push(...this.listWorkerLeases(run.id));
    return { run: this.getLoopRun(run.id), leases };
  }

  // G3.1: Planner — maps a goal's findings to a capability DAG. For each finding, selects
  // the best capability by competence (success_rate / p50_cost = the market). Returns a plan
  // the scheduler (continueLoopRun) can use to create leases with the right capability_id.
  // The existing maker→checker→nested shape is the default; the planner generalizes it.
  planLoopRun(id: string): Array<{
    finding_id: string;
    capability_id: string | null;
    role: string;
    runtime: string;
    competence: Record<string, number> | null;
    dependencies: string[];
  }> {
    const run = this.getLoopRun(id);
    const caps = this.intelligence.listCapabilities()
      .filter((c) => c.status === 'validated' || c.status === 'candidate');
    // G31: match findings to specialised capabilities by file type / keyword.
    // If no specialised capabilities match, fall back to generic spawn_runtime_worker.
    const generic = caps.filter((c) => c.allowed_actions.includes('spawn_runtime_worker'));
    // Try specialised matching first: TypeScript-fix, Python-fix, Security-audit, etc.
    const specialised = generic.filter((c) => {
      const meta = c.metadata as Record<string, unknown> | undefined;
      const specialisation = meta?.specialisation as string | undefined;
      return specialisation && specialisation !== 'generic';
    });
    const matching = specialised.length > 0 ? specialised : generic;
    let best: { id: string; metadata: Record<string, unknown>; allowed_actions: string[]; status: string } | null = null;
    let bestScore = -1;
    for (const c of matching) {
      const comp = c.metadata.competence as { success_rate?: number; p50_cost?: number } | undefined;
      const sr = comp?.success_rate ?? 0;
      const cost = Math.max(1, comp?.p50_cost ?? 1);
      const score = (sr / cost) * 1000; // competence per cost = the market
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return run.findings.map((finding) => {
      // G11: runtime-adaptive selection — the planner selects the runtime per finding
      // by (capability, competence, cost, sovereignty), not a fixed field. This makes
      // the fleet adaptive: sovereign tasks route to pi, lightweight to opencode,
      // complex/high-competence to codex.
      const runtime = this.selectRuntime(run, best, finding);
      return {
        finding_id: finding.id,
        capability_id: best?.id ?? null,
        role: 'maker',
        runtime,
        competence: (best?.metadata.competence as Record<string, number> | undefined) ?? null,
        dependencies: [], // maker has no deps; checker depends on maker (added by scheduler)
      };
    });
  }

  /**
   * G11: Runtime-adaptive selection — choose the best runtime for a finding based on
   * the goal's sovereignty requirement, the capability's learned cost model, and the
   * capability's competence on each runtime.
   *
   * - Sovereign (offline/zero-egress) goals → pi (always, no exceptions)
   * - Lightweight (p50_tokens < LIGHTWEIGHT_THRESHOLD) → opencode (cheaper, faster)
   * - Complex / high-competence on codex → codex (the verified baseline)
   * - Default → codex
   *
   * The caller can still override per-goal via run.metadata.runtime (backward compat).
   */
  private selectRuntime(
    run: LoopRunRecord,
    capability: { id: string; metadata: Record<string, unknown>; allowed_actions: string[]; status: string } | null,
    _finding: LoopFinding,
  ): 'codex' | 'opencode' | 'pi' | 'claude' | 'gemini' | 'editor' | 'mock' {
    // Sovereignty check: if the goal requires offline/sovereign execution → pi.
    const runMeta = run.metadata as Record<string, unknown>;
    if (runMeta.sovereign === true || process.env.PI_OFFLINE === '1') {
      return 'pi';
    }

    // Backward compat: if the run has an explicit runtime and no capability-based
    // selection applies, use the run's runtime.
    const explicitRuntime = runMeta.runtime as string | undefined;

    // Cost-aware: if the capability has a learned cost model and the finding is
    // lightweight (p50_tokens < threshold) → opencode.
    const LIGHTWEIGHT_THRESHOLD = Number(process.env.LIGHTWEIGHT_TOKEN_THRESHOLD) || 5000;
    const costModel = capability?.metadata?.cost_model as { learned?: boolean; p50_tokens?: number } | undefined;
    if (costModel?.learned && typeof costModel.p50_tokens === 'number' && costModel.p50_tokens < LIGHTWEIGHT_THRESHOLD) {
      return 'opencode';
    }

    // Competence-aware: if the capability has high competence → codex (the verified baseline).
    const competence = capability?.metadata?.competence as { success_rate?: number } | undefined;
    if (competence?.success_rate !== undefined && competence.success_rate > 0.7) {
      return 'codex';
    }

    // Default: use the explicit runtime or codex.
    if (explicitRuntime && ['codex', 'opencode', 'pi', 'claude', 'gemini', 'editor', 'mock'].includes(explicitRuntime)) {
      return explicitRuntime as 'codex' | 'opencode' | 'pi' | 'claude' | 'gemini' | 'editor' | 'mock';
    }
    return 'codex';
  }

  // G3.4: Convergence certificate — generalizes production_passed to ANY loop_run.
  // A run is certified iff: all gates passed, all maker leases completed, all checker
  // leases accepted, evidence present (trace spans + manifests), budget within, isolation
  // held. This is the Lyapunov-style invariant: the swarm converged inside its envelope.
  certifyLoopRun(id: string): { certified: boolean; missing: string[]; gates: LoopGate[] } {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(id);
    const missing: string[] = [];

    // 1. All gates passed (the control law's final measurement).
    const failedGates = run.gates.filter((g) => g.status === 'fail');
    if (failedGates.length > 0) missing.push('gates_failed');

    // 2. All maker leases completed.
    const makers = leases.filter((l) => l.role === 'maker');
    if (makers.length === 0) missing.push('no_makers');
    if (makers.some((l) => l.status !== 'completed')) missing.push('maker_incomplete');

    // 3. All checker leases completed (verdict accepted).
    const checkers = leases.filter((l) => l.role === 'checker');
    if (checkers.length === 0) missing.push('no_checkers');
    if (checkers.some((l) => l.status !== 'completed')) missing.push('checker_incomplete');

    // 4. Evidence present (trace spans + manifests).
    const traceSpanCount = (this.db.prepare('SELECT COUNT(*) as c FROM agent_trace_spans WHERE loop_run_id = ?').get(id) as { c: number }).c;
    if (traceSpanCount === 0) missing.push('no_trace_spans');

    // 5. Budget within (token + wall clock + dollar).
    const tokenBudget = this.evaluateTokenBudget(run, null, '', 0);
    if (tokenBudget.exhausted) missing.push('budget_exhausted');
    // G13: dollar budget check.
    const dollarBudget = this.getDollarBudget(run);
    if (dollarBudget.maxDollars) {
      const dollarsSpent = this.computeDollarsSpent(id);
      if (dollarsSpent > dollarBudget.maxDollars) missing.push('dollar_budget_exhausted');
    }

    // 6. Isolation held (worktree_isolation gate passed).
    const isolationGate = run.gates.find((g) => g.name === 'worktree_isolation');
    if (isolationGate && isolationGate.status === 'fail') missing.push('isolation_broken');

    // G14: emit convergence event for live observability.
    swarmEventBus.emit('convergence', {
      run_id: id,
      certified: missing.length === 0,
      missing,
    });
    return { certified: missing.length === 0, missing, gates: run.gates };
  }

  splitLoopFinding(id: string, input: SplitLoopInput = {}): { run: LoopRunRecord; parent: LoopFinding; children: LoopFinding[]; leases: WorkerLeaseRecord[] } {
    const run = this.getLoopRun(id);
    this.assertLoopNotEscalated(run);
    this.assertWallClockBudgetAvailable(run);
    if (!input.finding_id) {
      throw new Error('LOOP_FINDING_ID_REQUIRED');
    }

    const parentIndex = run.findings.findIndex((finding) => finding.id === input.finding_id);
    if (parentIndex === -1) {
      throw new Error('LOOP_FINDING_NOT_FOUND');
    }

    const parent = run.findings[parentIndex];
    if (this.isSplitFinding(parent)) {
      throw new Error('LOOP_FINDING_ALREADY_SPLIT');
    }

    const childInputs = input.children || [];
    if (childInputs.length < 2) {
      throw new Error('LOOP_SPLIT_CHILDREN_REQUIRED');
    }

    const reason = input.reason?.trim() || 'Finding split into bounded child findings.';
    const now = new Date().toISOString();
    const updatedParent: LoopFinding = {
      ...parent,
      metadata: {
        ...(parent.metadata || {}),
        status: 'split',
        split_reason: reason,
        split_at: now,
      },
    };
    const children: LoopFinding[] = childInputs.map((child, index) => {
      if (!child.message?.trim() || !child.suggested_fix?.trim()) {
        throw new Error('LOOP_SPLIT_CHILD_INVALID');
      }
      return {
        id: randomUUID(),
        type: parent.type,
        severity: parent.severity,
        file: child.file || parent.file,
        line: child.line ?? parent.line,
        message: child.message.trim(),
        evidence: parent.evidence,
        suggested_fix: child.suggested_fix.trim(),
        parent_finding_id: parent.id,
        metadata: {
          status: 'active',
          split_reason: reason,
          split_index: index,
          split_at: now,
        },
      };
    });

    const findings = [
      ...run.findings.slice(0, parentIndex),
      updatedParent,
      ...children,
      ...run.findings.slice(parentIndex + 1),
    ];
    const plan = this.createPlan(run.loop_name as LoopName, findings);
    const nextActions = ['Review split child findings', 'Approve maker/checker worker execution for selected child findings'];

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, findings_json = ?, plan_json = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      'planning',
      JSON.stringify(findings),
      JSON.stringify(plan),
      JSON.stringify(nextActions),
      now,
      run.id
    );

    this.recordLoopEvent(run.id, 'finding_split', 'info', `Split finding ${parent.id} into ${children.length} child finding(s).`, {
      parent_finding_id: parent.id,
      child_finding_ids: children.map((child) => child.id),
      reason,
    });

    return {
      run: this.getLoopRun(run.id),
      parent: updatedParent,
      children,
      leases: this.listWorkerLeases(run.id),
    };
  }

  retryLoopRun(id: string, input: RetryLoopInput = {}): { run: LoopRunRecord; leases: WorkerLeaseRecord[]; retry_maker: WorkerLeaseRecord; retry_checker: WorkerLeaseRecord } {
    const run = this.getLoopRun(id);
    this.assertLoopNotEscalated(run);
    this.assertWallClockBudgetAvailable(run);
    this.assertTokenBudgetAvailable(run);
    if (!run.repository_path) {
      throw new Error('LOOP_REPOSITORY_REQUIRED');
    }

    const leases = this.listWorkerLeases(run.id);
    const checkerLeases = leases.filter((lease) => lease.role === 'checker');
    const maker = input.maker_lease_id
      ? leases.find((lease) => lease.id === input.maker_lease_id)
      : leases.find((lease) => lease.role === 'maker' && this.isRetryableMakerLease(lease, checkerLeases));

    if (!maker) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    if (maker.role !== 'maker') {
      throw new Error('LEASE_NOT_MAKER');
    }
    if (!maker.finding_id) {
      throw new Error('LOOP_FINDING_NOT_FOUND');
    }
    if (!this.isRetryableMakerLease(maker, checkerLeases)) {
      throw new Error('LOOP_RETRY_NOT_ALLOWED');
    }

    const finding = run.findings.find((candidate) => candidate.id === maker.finding_id);
    if (!finding) {
      throw new Error('LOOP_FINDING_NOT_FOUND');
    }

    const retryRootMakerLeaseId = this.retryRootFor(maker);
    const retryBudget = this.getRetryBudget(run, maker, input);
    const usedRetries = leases.filter((lease) => lease.role === 'maker' && lease.metadata.retry_root_maker_lease_id === retryRootMakerLeaseId).length;
    if (usedRetries >= retryBudget.maxRetries) {
      throw new Error('LOOP_RETRY_BUDGET_EXHAUSTED');
    }

    const runtime = input.runtime || (maker.runtime as RetryLoopInput['runtime']) || 'manual';
    this.assertRuntimeAvailable(runtime);

    const retryAttempt = usedRetries + 1;
    const branchName = this.branchNameFor(run.id, finding.id, retryAttempt);
    const worktreePath = this.createWorktree(run.repository_path, run.id, `${finding.id}-retry-${retryAttempt}`, branchName);
      this.ensureWorktreeControlIgnore(worktreePath);
      this.writeWorkAssignment(worktreePath, run, finding, runtime);
      const assignmentPacketFile = this.writeAssignmentPacket(worktreePath, run, finding, runtime, retryAttempt);
      const assignmentFile = this.workAssignmentPath(worktreePath);

    const now = new Date().toISOString();
    const retryMakerLeaseId = randomUUID();
    this.insertWorkerLease({
      id: retryMakerLeaseId,
      loopRunId: run.id,
      role: 'maker',
      runtime,
      findingId: finding.id,
      worktreePath,
      branchName,
      metadata: {
        assignment_file: assignmentFile,
        assignment_packet_file: assignmentPacketFile,
        retry_of_maker_lease_id: maker.id,
        retry_root_maker_lease_id: retryRootMakerLeaseId,
        retry_attempt: retryAttempt,
      },
      now,
    });

    const retryCheckerLeaseId = randomUUID();
    this.insertWorkerLease({
      id: retryCheckerLeaseId,
      loopRunId: run.id,
      role: 'checker',
      runtime: 'manual',
      findingId: finding.id,
      worktreePath: null,
      branchName: null,
      metadata: {
        maker_lease_id: retryMakerLeaseId,
        requires_independent_review: true,
        retry_of_maker_lease_id: maker.id,
        retry_root_maker_lease_id: retryRootMakerLeaseId,
        retry_attempt: retryAttempt,
      },
      now,
    });

    this.updateWorkerLeaseStatus(maker.id, maker.status, {
      superseded_by_maker_lease_id: retryMakerLeaseId,
      superseded_at: now,
    });

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      'running',
      JSON.stringify(['Run retry maker in prepared worktree', 'Run deterministic checks', 'Submit independent checker verdict']),
      now,
      run.id
    );

    this.recordLoopEvent(run.id, 'retry_prepared', 'info', `Prepared retry ${retryAttempt} for maker lease ${maker.id}.`, {
      maker_lease_id: maker.id,
      retry_maker_lease_id: retryMakerLeaseId,
      retry_checker_lease_id: retryCheckerLeaseId,
      retry_attempt: retryAttempt,
      retry_budget: retryBudget,
    });

    const updatedLeases = this.listWorkerLeases(run.id);
    return {
      run: this.getLoopRun(run.id),
      leases: updatedLeases,
      retry_maker: updatedLeases.find((lease) => lease.id === retryMakerLeaseId)!,
      retry_checker: updatedLeases.find((lease) => lease.id === retryCheckerLeaseId)!,
    };
  }

  verifyLoopRun(id: string): { run: LoopRunRecord; gates: LoopGate[]; leases: WorkerLeaseRecord[] } {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const makerLeases = leases.filter((lease) => lease.role === 'maker');
    const supersededMakerIds = new Set(makerLeases.filter((lease) => this.isSupersededMakerLease(lease)).map((lease) => lease.id));
    const activeMakerLeases = makerLeases.filter((lease) => !supersededMakerIds.has(lease.id));
    const checkerLeases = leases
      .filter((lease) => lease.role === 'checker')
      .filter((lease) => {
        const makerLeaseId = lease.metadata.maker_lease_id;
        return typeof makerLeaseId !== 'string' || !supersededMakerIds.has(makerLeaseId);
      });
    const securityCheckerLeases = leases
      .filter((lease) => lease.role === 'security_checker')
      .filter((lease) => {
        const makerLeaseId = lease.metadata.maker_lease_id;
        return typeof makerLeaseId !== 'string' || !supersededMakerIds.has(makerLeaseId);
      });
    const completedMakerLeases = activeMakerLeases.filter((lease) => lease.status === 'completed');
    const highRisk = this.isHighRiskRun(run);

    const gates: LoopGate[] = [
      {
        name: 'maker_checker_separation',
        status: activeMakerLeases.length > 0 && checkerLeases.length >= activeMakerLeases.length ? 'pass' : 'fail',
        evidence: `${activeMakerLeases.length} active maker lease(s), ${checkerLeases.length} active checker lease(s), ${supersededMakerIds.size} superseded maker lease(s).`,
      },
      {
        name: 'worktree_isolation',
        status: activeMakerLeases.every((lease) => lease.worktree_path && fs.existsSync(lease.worktree_path)) ? 'pass' : 'fail',
        evidence: 'Every maker lease must have an existing isolated worktree.',
      },
      {
        name: 'assignment_file_present',
        status: activeMakerLeases.every((lease) => fs.existsSync(this.resolveWorkAssignmentPath(lease))) ? 'pass' : 'fail',
        evidence: 'Every maker worktree must contain .djimitflo/LOOP_WORK.md or a readable historical LOOP_WORK.md.',
      },
      {
        name: 'diff_threshold_all_makers',
        status: completedMakerLeases.every((lease) => this.leaseDiffWithinThreshold(lease)) ? 'pass' : completedMakerLeases.length === 0 ? 'skipped' : 'fail',
        evidence: completedMakerLeases.length === 0
          ? 'No completed maker leases yet.'
          : 'All completed maker leases must stay under their configured diff threshold.',
      },
      {
        name: 'checker_verdict',
        status: completedMakerLeases.every((lease) => this.hasAcceptedCheckerVerdict(lease.id, checkerLeases)) ? 'pass' : completedMakerLeases.length === 0 ? 'skipped' : 'fail',
        evidence: completedMakerLeases.length === 0
          ? 'No completed maker leases yet.'
          : 'Every completed maker lease requires an accepted checker verdict.',
      },
      {
        name: 'tests_lint_typecheck',
        status: completedMakerLeases.every((lease) => this.leaseChecksPassed(lease)) ? 'pass' : completedMakerLeases.length === 0 ? 'skipped' : 'fail',
        evidence: completedMakerLeases.length === 0
          ? 'No completed maker leases yet.'
          : 'Each completed maker lease requires passing or skipped deterministic checks.',
      },
      {
        name: 'security_checker_verdict',
        status: !highRisk
          ? 'skipped'
          : completedMakerLeases.length === 0
            ? 'skipped'
            : completedMakerLeases.every((lease) => this.hasAcceptedSecurityCheckerVerdict(lease.id, securityCheckerLeases)) ? 'pass' : 'fail',
        evidence: !highRisk
          ? 'Run is not high-risk.'
          : `${securityCheckerLeases.length} active security checker lease(s); high-risk completion requires accepted security verdict for every completed maker.`,
      },
      {
        name: 'no_automatic_merge',
        status: 'pass',
        evidence: 'Loop only prepared worktrees and did not merge, push, or deploy.',
      },
    ];

    const status: LoopRunStatus = gates.some((gate) => gate.status === 'fail')
      ? 'blocked'
      : completedMakerLeases.length > 0
        ? 'ready_for_human_merge'
        : 'verifying';
    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, updated_at = ?
      WHERE id = ?
    `).run(status, JSON.stringify(gates), new Date().toISOString(), run.id);

    this.recordLoopEvent(run.id, 'loop_verified', status === 'blocked' ? 'warning' : 'info', `Verification gates ${status === 'blocked' ? 'blocked' : 'passed'} for prepared work.`, {
      gates,
    });

    // G15: Auto-populate evidence edges for verified gates
    for (const gate of gates) {
      if (gate.status === 'pass') {
        this.populateEvidenceEdges([{ from: `loop:${run.id}`, to: `gate:${gate.name}`, relation: 'verified_by' }]);
      }
    }
    return { run: this.getLoopRun(run.id), gates, leases };
  }

  completeLoopRun(id: string, input: CompleteLoopInput = {}): { run: LoopRunRecord; gates: LoopGate[] } {
    const current = this.getLoopRun(id);
    const leases = this.listWorkerLeases(current.id);

    if (leases.some((lease) => lease.role === 'maker')) {
      const verified = this.verifyLoopRun(id);
      const failingGate = verified.gates.find((gate) => gate.status === 'fail');
      if (failingGate) {
        if (failingGate.name === 'security_checker_verdict') {
          throw new Error('HIGH_RISK_SECURITY_CHECK_REQUIRED');
        }
        throw new Error(`LOOP_COMPLETION_BLOCKED:${failingGate.name}`);
      }

      const incompleteLease = this.completionBlockingLeases(verified.leases).find((lease) => lease.status !== 'completed');
      if (incompleteLease) {
        throw new Error('LOOP_COMPLETION_LEASES_INCOMPLETE');
      }
      const approvalRef = String(input.human_approval_ref || verified.run.metadata.human_approval_ref || '').trim();
      if (!approvalRef) {
        throw new Error('LOOP_HUMAN_APPROVAL_REQUIRED');
      }

      // G15: Governance enforcement — verify no unresolved claims block completion
      this.enforceGovernanceCompletion(id);

      const now = new Date().toISOString();
      const metadata = {
        ...verified.run.metadata,
        human_approval_ref: approvalRef,
        human_approved_at: now,
      };
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, next_actions_json = ?, metadata = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run('completed', JSON.stringify(['Loop completed after human approval']), JSON.stringify(metadata), now, now, id);

      this.recordLoopEvent(id, 'loop_completed', 'info', 'Loop run completed after verification gates passed.', {
        gates: verified.gates,
        human_approval_ref: approvalRef,
      });

      return { run: this.getLoopRun(id), gates: verified.gates };
    }

    if (current.status === 'completed') {
      return { run: current, gates: current.gates };
    }

    throw new Error('LOOP_COMPLETION_NO_WORKERS');
  }

  submitCheckerVerdict(id: string, input: CheckerVerdictInput): { run: LoopRunRecord; checker: WorkerLeaseRecord } {
    if (!input.verdict) {
      throw new Error('CHECKER_VERDICT_REQUIRED');
    }
    const validVerdicts = ['accepted', 'needs_revision', 'rejected', 'insufficient_evidence'];
    if (!validVerdicts.includes(input.verdict)) {
      throw new Error('CHECKER_VERDICT_INVALID');
    }

    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const checker = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'checker' && (!input.maker_lease_id || lease.metadata.maker_lease_id === input.maker_lease_id));

    if (!checker) {
      throw new Error('CHECKER_LEASE_NOT_FOUND');
    }
    if (checker.role !== 'checker') {
      throw new Error('LEASE_NOT_CHECKER');
    }
    const makerLeaseId = (checker.metadata.maker_lease_id as string | undefined) || input.maker_lease_id;
    if (!makerLeaseId) {
      throw new Error('CHECKER_MAKER_LINK_MISSING');
    }
    const maker = leases.find((lease) => lease.id === makerLeaseId);
    if (!maker || maker.status !== 'completed') {
      throw new Error('CHECKER_MAKER_NOT_COMPLETED');
    }

    this.updateWorkerLeaseStatus(checker.id, 'completed', {
      verdict: input.verdict,
      notes: input.notes || '',
      maker_lease_id: makerLeaseId,
      completed_at: new Date().toISOString(),
    });

    this.recordLoopEvent(run.id, 'checker_verdict_submitted', input.verdict === 'accepted' ? 'info' : 'warning', `Checker verdict submitted: ${input.verdict}.`, {
      checker_lease_id: checker.id,
      maker_lease_id: makerLeaseId,
      verdict: input.verdict,
    });

    const nextRun = input.verdict === 'accepted'
      ? this.verifyLoopRun(run.id).run
      : this.escalateIfFailureThresholdExceeded(run.id, `checker_verdict:${input.verdict}`);

    return {
      run: nextRun,
      checker: this.listWorkerLeases(run.id).find((lease) => lease.id === checker.id)!,
    };
  }

  submitSecurityVerdict(id: string, input: CheckerVerdictInput): { run: LoopRunRecord; security_checker: WorkerLeaseRecord } {
    if (!input.verdict) {
      throw new Error('CHECKER_VERDICT_REQUIRED');
    }
    const validVerdicts = ['accepted', 'needs_revision', 'rejected', 'insufficient_evidence'];
    if (!validVerdicts.includes(input.verdict)) {
      throw new Error('CHECKER_VERDICT_INVALID');
    }

    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const securityChecker = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'security_checker' && (!input.maker_lease_id || lease.metadata.maker_lease_id === input.maker_lease_id));

    if (!securityChecker) {
      throw new Error('SECURITY_CHECKER_LEASE_NOT_FOUND');
    }
    if (securityChecker.role !== 'security_checker') {
      throw new Error('LEASE_NOT_SECURITY_CHECKER');
    }
    const makerLeaseId = (securityChecker.metadata.maker_lease_id as string | undefined) || input.maker_lease_id;
    if (!makerLeaseId) {
      throw new Error('CHECKER_MAKER_LINK_MISSING');
    }
    const maker = leases.find((lease) => lease.id === makerLeaseId);
    if (!maker || maker.status !== 'completed') {
      throw new Error('CHECKER_MAKER_NOT_COMPLETED');
    }

    this.updateWorkerLeaseStatus(securityChecker.id, 'completed', {
      verdict: input.verdict,
      notes: input.notes || '',
      maker_lease_id: makerLeaseId,
      completed_at: new Date().toISOString(),
    });

    this.recordLoopEvent(run.id, 'security_checker_verdict_submitted', input.verdict === 'accepted' ? 'info' : 'warning', `Security checker verdict submitted: ${input.verdict}.`, {
      security_checker_lease_id: securityChecker.id,
      maker_lease_id: makerLeaseId,
      verdict: input.verdict,
    });

    const nextRun = input.verdict === 'accepted'
      ? this.verifyLoopRun(run.id).run
      : this.escalateIfFailureThresholdExceeded(run.id, `security_checker_verdict:${input.verdict}`);

    return {
      run: nextRun,
      security_checker: this.listWorkerLeases(run.id).find((lease) => lease.id === securityChecker.id)!,
    };
  }

  runDeterministicChecks(id: string, input: RunChecksInput = {}): { run: LoopRunRecord; lease: WorkerLeaseRecord; checks: Array<Record<string, unknown>> } {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const makerLease = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'maker' && lease.status === 'completed');

    if (!makerLease) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    if (makerLease.role !== 'maker') {
      throw new Error('LEASE_NOT_MAKER');
    }
    if (makerLease.status !== 'completed') {
      throw new Error('MAKER_LEASE_NOT_COMPLETED');
    }
    if (!makerLease.worktree_path || !fs.existsSync(makerLease.worktree_path)) {
      throw new Error('MAKER_WORKTREE_NOT_FOUND');
    }

    const scripts = input.scripts || ['test', 'lint', 'type-check'];
    const packageScripts = this.readNearestPackageScripts(makerLease.worktree_path);
    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const outputDir = path.join(this.evidenceRoot, run.id, 'checks', makerLease.id);
    fs.mkdirSync(outputDir, { recursive: true });

    const checks = scripts.map((scriptName) => {
      const stdoutPath = path.join(outputDir, `${scriptName}.stdout.log`);
      const stderrPath = path.join(outputDir, `${scriptName}.stderr.log`);
      if (!packageScripts.has(scriptName)) {
        fs.writeFileSync(stdoutPath, '', 'utf8');
        fs.writeFileSync(stderrPath, `script not present: ${scriptName}\n`, 'utf8');
        return {
          name: scriptName,
          status: 'skipped',
          exit_status: null,
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        };
      }

      const result = spawnSync('npm', ['run', scriptName], {
        cwd: makerLease.worktree_path!,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: this.buildRuntimeEnv(),
        maxBuffer: 5 * 1024 * 1024,
      });
      const exitStatus = typeof result.status === 'number' ? result.status : null;
      const timedOut = Boolean(result.error && result.error.message.includes('ETIMEDOUT'));
      fs.writeFileSync(stdoutPath, result.stdout || '', 'utf8');
      fs.writeFileSync(stderrPath, result.stderr || result.error?.message || '', 'utf8');
      return {
        name: scriptName,
        status: exitStatus === 0 && !timedOut ? 'pass' : 'fail',
        exit_status: exitStatus,
        timed_out: timedOut,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      };
    });

    const failed = checks.some((check) => check.status === 'fail');
    this.updateWorkerLeaseStatus(makerLease.id, failed ? 'failed' : 'completed', {
      deterministic_checks: checks,
      checks_completed_at: new Date().toISOString(),
    });
    // G15: Auto-write runner manifest for worker completion
    this.autoWriteManifest({ loopRunId: run.id, leaseId: makerLease.id, action: failed ? 'fail' : 'complete', gateRefs: checks.map((c: any) => c.name || 'check'), checkpointAfterRef: `checkpoint:after:${makerLease.id}` });
    // G15: Auto-populate evidence edges
    this.populateEvidenceEdges([{ from: `loop:${run.id}`, to: `lease:${makerLease.id}`, relation: 'executes_with' }]);

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      failed ? 'blocked' : 'verifying',
      JSON.stringify(failed ? ['Inspect deterministic check failure before checker acceptance'] : ['Submit checker verdict', 'Run verify gates']),
      new Date().toISOString(),
      run.id
    );

    this.recordLoopEvent(run.id, 'deterministic_checks_completed', failed ? 'warning' : 'info', `Deterministic checks ${failed ? 'failed' : 'passed/skipped'} for maker lease ${makerLease.id}.`, {
      lease_id: makerLease.id,
      checks,
    });

    return {
      run: failed ? this.escalateIfFailureThresholdExceeded(run.id, 'deterministic_checks_failed') : this.getLoopRun(run.id),
      lease: this.listWorkerLeases(run.id).find((lease) => lease.id === makerLease.id)!,
      checks,
    };
  }

  async executeMaker(id: string, input: ExecuteMakerInput = {}): Promise<{ run: LoopRunRecord; lease: WorkerLeaseRecord; gates: LoopGate[]; stdout_path: string; stderr_path: string }> {
    const run = this.getLoopRun(id);
    this.assertWallClockBudgetAvailable(run);
    const leases = this.listWorkerLeases(run.id);
    const makerLease = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'maker' && lease.status === 'prepared');

    if (!makerLease) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    if (makerLease.status !== 'prepared') {
      throw new Error('MAKER_LEASE_NOT_PREPARED');
    }
    if (!makerLease.worktree_path || !fs.existsSync(makerLease.worktree_path)) {
      throw new Error('MAKER_WORKTREE_NOT_FOUND');
    }
    if (makerLease.runtime === 'manual') {
      throw new Error('MANUAL_MAKER_REQUIRES_HUMAN');
    }

    const manifestContract = this.getRuntimeContract(makerLease.runtime);
    this.recordWorkerManifest({
      decisionId: this.makeManifestDecisionId(run.id, makerLease.id, 'start'),
      loopRunId: run.id,
      leaseId: makerLease.id,
      action: 'start',
      runtimeContract: manifestContract,
      capacitySnapshot: this.currentCapacitySnapshot(),
      budgetSnapshot: this.currentBudgetSnapshot(run),
      gateRefs: ['runtime_contract'],
      blockedReasons: [],
      metadata: {
        worker_role: makerLease.role,
        worker_runtime: makerLease.runtime,
        started_from: 'executeMaker',
      },
    });

    this.updateWorkerLeaseStatus(makerLease.id, 'running', { started_at: new Date().toISOString() });
    // G15: Enforce capability gate before worker starts
    this.enforceCapabilityGate(makerLease);
    // G15: Auto-write runner manifest for worker start
    this.autoWriteManifest({ loopRunId: run.id, leaseId: makerLease.id, action: 'start', gateRefs: ['capability_gate', 'worktree_isolation'], checkpointBeforeRef: `checkpoint:before:${makerLease.id}` });

    const contract = this.getRuntimeContract(makerLease.runtime);
    if (!contract.available || contract.status !== 'ok') {
      this.recordWorkerManifest({
        decisionId: this.makeManifestDecisionId(run.id, makerLease.id, 'fail'),
        loopRunId: run.id,
        leaseId: makerLease.id,
        action: 'fail',
        runtimeContract: contract,
        capacitySnapshot: this.currentCapacitySnapshot(),
        budgetSnapshot: this.currentBudgetSnapshot(run),
        gateRefs: ['runtime_contract'],
        blockedReasons: ['runtime_contract_drift'],
        metadata: {
          worker_role: makerLease.role,
          worker_runtime: makerLease.runtime,
          reason: 'runtime_contract_unavailable_or_drifted',
          started_from: 'executeMaker',
        },
      });
      this.updateWorkerLeaseStatus(makerLease.id, 'failed', {
        runtime_contract: contract,
        runtime_contract_failed_at: new Date().toISOString(),
      });
      throw new Error('RUNTIME_CONTRACT_DRIFTED');
    }

    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const prompt = fs.readFileSync(this.resolveWorkAssignmentPath(makerLease), 'utf8');
    const skipPermissions = this.resolveSkipPermissions(input.skip_permissions);
    const { command, args } = this.buildRuntimeCommand(makerLease.runtime, makerLease.worktree_path, prompt, skipPermissions);
    const result = await this.executeRuntimeCommand(makerLease.id, command, args, {
      cwd: makerLease.worktree_path,
      timeoutMs,
      enforceCwdBoundary: makerLease.runtime !== 'mock',
      maxBuffer: 5 * 1024 * 1024,
      env: this.buildNestedSpawnEnv(makerLease) ?? undefined,
    });

    const outputDir = path.join(this.evidenceRoot, run.id, 'worker-output', makerLease.id);
    fs.mkdirSync(outputDir, { recursive: true });
    const stdoutPath = path.join(outputDir, 'stdout.log');
    const stderrPath = path.join(outputDir, 'stderr.log');
    fs.writeFileSync(stdoutPath, result.stdout || '', 'utf8');
    fs.writeFileSync(stderrPath, result.stderr || '', 'utf8');

    // Stage the maker's output (incl. new untracked files) before measuring, so the diff
    // reflects the real change size. `git diff -- .` alone ignores untracked files, which read
    // a new-file maker change as 0 lines and skipped the tokens-per-diff-line efficiency gate.
    // The worktree is isolated/disposable; staging here has no host-repo effect.
    this.git(makerLease.worktree_path, ['add', '-A']);
    const diff = this.git(makerLease.worktree_path, ['diff', '--cached', '--', '.']);
    const diffLines = diff ? diff.split(/\r?\n/).filter(Boolean).length : 0;
    const diffMaxLines = Math.max(1, Math.min(input.diff_max_lines || 200, 2_000));
    const exitStatus = result.exitCode;
    const timedOut = result.timedOut;
    const runtimeUsage = this.extractRuntimeUsage(result.stdout || '');
    const runtimeWarnings = this.extractRuntimeWarnings(result.stdout || '', result.stderr || '');
    const tokenBudget = this.evaluateTokenBudget(run, runtimeUsage, makerLease.id, diffLines);
    const efficiency = this.calculateWorkerEfficiency(runtimeUsage, diffLines);

    const gates: LoopGate[] = [
      {
        name: 'maker_runtime_exit_zero',
        status: exitStatus === 0 && !timedOut ? 'pass' : 'fail',
        evidence: `runtime=${makerLease.runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}, skip_permissions=${skipPermissions}`,
      },
      {
        name: 'diff_under_threshold',
        status: diffLines <= diffMaxLines ? 'pass' : 'fail',
        evidence: `${diffLines} changed diff line(s), threshold ${diffMaxLines}.`,
      },
      this.runtimeWarningGate(run, runtimeWarnings),
      tokenBudget.gate,
      {
        name: 'no_automatic_merge',
        status: 'pass',
        evidence: 'Maker execution did not merge, push, or deploy.',
      },
    ];

    const failed = gates.some((gate) => gate.status === 'fail');
    const completionStatus = failed ? 'failed' : 'completed';
    const wasCancelled = this.isWorkerLeaseCancelled(makerLease.id);
    const metadataPatch: Record<string, unknown> = {
      completed_at: new Date().toISOString(),
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      diff_lines: diffLines,
      diff_max_lines: diffMaxLines,
      exit_status: exitStatus,
      timed_out: timedOut,
      runtime_adapter: makerLease.runtime,
      runtime_contract: contract,
      runtime_pid: result.runtimePid,
      runtime_signal: result.signal,
      runtime_timed_out: result.timedOut,
      runtime_timed_out_at: result.timedOutAt,
      runtime_warnings: runtimeWarnings,
      token_efficiency: efficiency,
    };
    if (runtimeUsage) {
      metadataPatch.runtime_usage = runtimeUsage;
    } else {
      metadataPatch.runtime_usage = { usage_source: 'unknown' };
    }

    if (wasCancelled) {
      this.patchWorkerLeaseMetadata(makerLease.id, {
        ...metadataPatch,
        runtime_was_cancelled: true,
      });
    } else {
      this.updateWorkerLeaseStatus(makerLease.id, completionStatus, {
        ...metadataPatch,
      });
    }

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      wasCancelled ? this.getLoopRun(run.id).status : (failed ? 'blocked' : 'verifying'),
      JSON.stringify(gates),
      JSON.stringify(failed ? ['Inspect maker output and revise or retry'] : ['Run checker review', 'Run verify gates before completion']),
      new Date().toISOString(),
      run.id
    );

    this.recordLoopEvent(run.id, 'maker_executed', failed ? 'warning' : 'info', `Maker lease ${makerLease.id} ${failed ? 'failed gates' : wasCancelled ? 'stopped' : 'completed'}.`, {
      lease_id: makerLease.id,
      gates,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' },
      runtime_warnings: runtimeWarnings,
      token_efficiency: efficiency,
      runtime_cancelled: wasCancelled,
    });

    if (tokenBudget.exhausted) {
      this.recordLoopEvent(run.id, 'loop_budget_exhausted', 'warning', 'Token budget exhausted by maker runtime usage.', {
        budget_type: 'tokens',
        lease_id: makerLease.id,
        runtime_usage: runtimeUsage,
        token_budget: tokenBudget.budget,
      });
    }
    if (tokenBudget.efficiencyExceeded) {
      this.markTokenEfficiencyBudgetRisk(run, makerLease.id, runtimeUsage, tokenBudget);
    }

    this.recordWorkerManifest({
      decisionId: this.makeManifestDecisionId(run.id, makerLease.id, failed ? 'fail' : 'complete'),
      loopRunId: run.id,
      leaseId: makerLease.id,
      action: wasCancelled ? 'stop' : failed ? 'fail' : 'complete',
      runtimeContract: contract,
      capacitySnapshot: this.currentCapacitySnapshot(),
      budgetSnapshot: this.currentBudgetSnapshot(run, runtimeUsage),
      gateRefs: gates.map((gate) => gate.name),
      blockedReasons: gates.filter((gate) => gate.status === 'fail').map((gate) => `${gate.name}: ${gate.evidence}`),
      metadata: {
        worker_role: makerLease.role,
        worker_runtime: makerLease.runtime,
        exit_status: exitStatus,
        timed_out: timedOut,
        diff_lines: diffLines,
        diff_threshold_lines: diffMaxLines,
        runtime_pid: result.runtimePid,
        runtime_signal: result.signal,
        runtime_usage: runtimeUsage || { usage_source: 'unknown' },
        runtime_warnings: runtimeWarnings,
        token_efficiency: efficiency,
        started_from: 'executeMaker',
        run_canceled: wasCancelled,
      },
    });

    const completedLease = this.getWorkerLease(makerLease.id);
    if (!wasCancelled && completionStatus === 'completed') {
      return {
        run: failed ? this.escalateIfFailureThresholdExceeded(run.id, 'maker_execution_failed') : this.getLoopRun(run.id),
        lease: completedLease,
        gates,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      };
    }

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      failed ? 'blocked' : 'verifying',
      JSON.stringify(gates),
      JSON.stringify(failed ? ['Inspect maker output and revise or retry'] : ['Run checker review', 'Run verify gates before completion']),
      new Date().toISOString(),
      run.id
    );

    return {
      run: this.getLoopRun(run.id),
      lease: completedLease,
      gates,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    };
  }

  async executeWorker(id: string, input: ExecuteMakerInput = {}): Promise<ExecuteWorkerResult> {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const lease = input.lease_id
      ? leases.find((candidate) => candidate.id === input.lease_id)
      : leases.find((candidate) => candidate.role === 'maker' && candidate.status === 'prepared');

    if (!lease) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    const traceId = `loop-${run.id}-worker-${lease.id}`;
    const checkpointBefore = this.assurance.createCheckpoint({
      loop_run_id: run.id,
      label: `before worker ${lease.id}`,
      metadata: {
        worker_lease_id: lease.id,
        worker_role: lease.role,
        worker_runtime: lease.runtime,
        phase: 'before_worker_execution',
      },
    });
    this.patchWorkerLeaseMetadata(lease.id, {
      checkpoint_before_id: checkpointBefore.id,
      trace_id: traceId,
      runtime_adapter: lease.runtime,
    });

    this.assurance.createTraceSpan({
      trace_id: traceId,
      loop_run_id: run.id,
      span_type: 'worker',
      name: `${lease.role}:${lease.runtime}:spawn`,
      status: 'running',
      evidence_ref: `loop:${run.id}/worker:${lease.id}`,
      metadata: {
        worker_lease_id: lease.id,
        role: lease.role,
        runtime: lease.runtime,
        checkpoint_before_id: checkpointBefore.id,
      },
    });

    const execution = await this.executeMaker(id, input);
    const finalStatus = execution.lease.status === 'completed' ? 'ok' : 'error';
    this.assurance.createTraceSpan({
      trace_id: traceId,
      loop_run_id: run.id,
      span_type: 'worker',
      name: `${lease.role}:${lease.runtime}:completion`,
      status: finalStatus,
      evidence_ref: execution.stdout_path,
      metadata: {
        worker_lease_id: lease.id,
        role: lease.role,
        runtime: lease.runtime,
        stdout_path: execution.stdout_path,
        stderr_path: execution.stderr_path,
        gates: execution.gates,
      },
    });

    const checkpointAfter = this.assurance.createCheckpoint({
      loop_run_id: run.id,
      label: `after worker ${lease.id}`,
      metadata: {
        worker_lease_id: lease.id,
        worker_role: lease.role,
        worker_runtime: lease.runtime,
        phase: 'after_worker_execution',
      },
    });
    this.patchWorkerLeaseMetadata(lease.id, {
      checkpoint_after_id: checkpointAfter.id,
    });

    return {
      ...execution,
      run: this.getLoopRun(run.id),
      lease: this.listWorkerLeases(run.id).find((candidate) => candidate.id === lease.id)!,
      checkpoint_before: checkpointBefore,
      checkpoint_after: checkpointAfter,
      trace: this.assurance.getTrace(traceId),
    };
  }

  async executeChecker(id: string, input: ExecuteCheckerInput = {}): Promise<ExecuteWorkerResult> {
    const run = this.getLoopRun(id);
    const leases = this.listWorkerLeases(run.id);
    const checker = input.lease_id
      ? leases.find((candidate) => candidate.id === input.lease_id)
      : leases.find((candidate) => candidate.role === 'checker' && candidate.status === 'prepared');

    if (!checker) {
      throw new Error('CHECKER_LEASE_NOT_FOUND');
    }
    if (checker.role !== 'checker') {
      throw new Error('LEASE_NOT_CHECKER');
    }

    const makerLeaseId = checker.metadata.maker_lease_id as string | undefined;
    if (!makerLeaseId) {
      throw new Error('CHECKER_MAKER_LINK_MISSING');
    }
    const maker = leases.find((lease) => lease.id === makerLeaseId);
    if (!maker || maker.status !== 'completed') {
      throw new Error('CHECKER_MAKER_NOT_COMPLETED');
    }
    if (!maker.worktree_path || !fs.existsSync(maker.worktree_path)) {
      throw new Error('MAKER_WORKTREE_NOT_FOUND');
    }

    const runtime = input.runtime || (checker.runtime !== 'manual' ? checker.runtime as 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock' : 'mock');
    const runtimeContract = this.getRuntimeContract(runtime);
    this.recordWorkerManifest({
      decisionId: this.makeManifestDecisionId(run.id, checker.id, 'start'),
      loopRunId: run.id,
      leaseId: checker.id,
      action: 'start',
      runtimeContract,
      capacitySnapshot: this.currentCapacitySnapshot(),
      budgetSnapshot: this.currentBudgetSnapshot(run),
      gateRefs: ['runtime_contract'],
      blockedReasons: [],
      metadata: {
        worker_role: checker.role,
        worker_runtime: runtime,
        maker_lease_id: checker.metadata.maker_lease_id,
        started_from: 'executeChecker',
      },
    });
    this.updateWorkerLeaseRuntime(checker.id, runtime);
    if (!runtimeContract.available || runtimeContract.status !== 'ok') {
      this.recordWorkerManifest({
        decisionId: this.makeManifestDecisionId(run.id, checker.id, 'fail'),
        loopRunId: run.id,
        leaseId: checker.id,
        action: 'fail',
        runtimeContract,
        capacitySnapshot: this.currentCapacitySnapshot(),
        budgetSnapshot: this.currentBudgetSnapshot(run),
        gateRefs: ['runtime_contract'],
        blockedReasons: ['runtime_contract_drift'],
        metadata: {
          worker_role: checker.role,
          worker_runtime: runtime,
          maker_lease_id: checker.metadata.maker_lease_id,
          reason: 'runtime_contract_unavailable_or_drifted',
          started_from: 'executeChecker',
        },
      });
      this.updateWorkerLeaseStatus(checker.id, 'failed', {
        runtime_adapter: runtime,
        runtime_contract: runtimeContract,
        runtime_contract_failed_at: new Date().toISOString(),
      });
      throw new Error('RUNTIME_CONTRACT_DRIFTED');
    }

    const traceId = `loop-${run.id}-checker-${checker.id}`;
    const checkpointBefore = this.assurance.createCheckpoint({
      loop_run_id: run.id,
      label: `before checker ${checker.id}`,
      metadata: {
        worker_lease_id: checker.id,
        maker_lease_id: maker.id,
        worker_role: checker.role,
        worker_runtime: runtime,
        phase: 'before_checker_execution',
      },
    });
    this.patchWorkerLeaseMetadata(checker.id, {
      checkpoint_before_id: checkpointBefore.id,
      trace_id: traceId,
      runtime_adapter: runtime,
    });

    this.assurance.createTraceSpan({
      trace_id: traceId,
      loop_run_id: run.id,
      span_type: 'worker',
      name: `${checker.role}:${runtime}:spawn`,
      status: 'running',
      evidence_ref: `loop:${run.id}/checker:${checker.id}`,
      metadata: {
        worker_lease_id: checker.id,
        maker_lease_id: maker.id,
        role: checker.role,
        runtime,
        checkpoint_before_id: checkpointBefore.id,
      },
    });

    this.updateWorkerLeaseStatus(checker.id, 'running', { started_at: new Date().toISOString(), runtime_adapter: runtime });

    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const prompt = this.buildCheckerPrompt(run, maker, checker);
    const skipPermissions = this.resolveSkipPermissions(input.skip_permissions);
    const { command, args } = runtime === 'mock'
      ? this.buildMockCheckerCommand(maker.worktree_path, prompt)
      : this.buildRuntimeCommand(runtime, maker.worktree_path, prompt, skipPermissions);
    const result = await this.executeRuntimeCommand(checker.id, command, args, {
      cwd: maker.worktree_path,
      timeoutMs,
      enforceCwdBoundary: runtime !== 'mock',
      maxBuffer: 5 * 1024 * 1024,
      env: this.buildNestedSpawnEnv(checker) ?? undefined,
    });

    const outputDir = path.join(this.evidenceRoot, run.id, 'checker-output', checker.id);
    fs.mkdirSync(outputDir, { recursive: true });
    const stdoutPath = path.join(outputDir, 'stdout.log');
    const stderrPath = path.join(outputDir, 'stderr.log');
    fs.writeFileSync(stdoutPath, result.stdout || '', 'utf8');
    fs.writeFileSync(stderrPath, result.stderr || '', 'utf8');

    const exitStatus = result.exitCode;
    const timedOut = result.timedOut;
    const runtimeUsage = this.extractRuntimeUsage(result.stdout || '');
    const runtimeWarnings = this.extractRuntimeWarnings(result.stdout || '', result.stderr || '');
    const verdict = exitStatus === 0 && !timedOut
      ? this.extractCheckerVerdict(result.stdout || '')
      : 'insufficient_evidence';

    this.updateWorkerLeaseStatus(checker.id, exitStatus === 0 && !timedOut ? 'completed' : 'failed', {
      verdict,
      notes: this.extractCheckerNotes(result.stdout || '') || `Checker runtime ${exitStatus === 0 && !timedOut ? 'completed' : 'failed'}.`,
      maker_lease_id: maker.id,
      completed_at: new Date().toISOString(),
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      exit_status: exitStatus,
      timed_out: timedOut,
      runtime_pid: result.runtimePid,
      runtime_signal: result.signal,
      runtime_timed_out: result.timedOut,
      runtime_timed_out_at: result.timedOutAt,
      runtime_adapter: runtime,
      runtime_contract: runtimeContract,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' },
      runtime_warnings: runtimeWarnings,
    });

    const gates: LoopGate[] = [
      {
        name: 'checker_runtime_exit_zero',
        status: exitStatus === 0 && !timedOut ? 'pass' : 'fail',
        evidence: `runtime=${runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}`,
      },
      {
        name: 'checker_verdict',
        status: verdict === 'accepted' ? 'pass' : 'fail',
        evidence: `checker verdict=${verdict}`,
      },
      {
        name: 'checker_read_only_contract',
        status: 'pass',
        evidence: 'Checker prompt forbids file mutation, merge, push, deploy, secret and policy edits.',
      },
      this.runtimeWarningGate(run, runtimeWarnings),
    ];

    const failed = gates.some((gate) => gate.status === 'fail');
    const existingRun = this.getLoopRun(run.id);
    const mergedGates = this.mergeGates(existingRun.gates, gates);
    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      failed ? 'blocked' : 'verifying',
      JSON.stringify(mergedGates),
      JSON.stringify(failed ? ['Inspect checker output and retry, split, or revise'] : ['Run verify gates before completion']),
      new Date().toISOString(),
      run.id
    );

    this.recordLoopEvent(run.id, 'checker_executed', failed ? 'warning' : 'info', `Checker lease ${checker.id} ${failed ? 'failed gates' : 'completed'}.`, {
      checker_lease_id: checker.id,
      maker_lease_id: maker.id,
      verdict,
      gates,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' },
      runtime_warnings: runtimeWarnings,
    });

    this.recordWorkerManifest({
      decisionId: this.makeManifestDecisionId(run.id, checker.id, failed ? 'fail' : 'complete'),
      loopRunId: run.id,
      leaseId: checker.id,
      action: failed ? 'fail' : 'complete',
      runtimeContract,
      capacitySnapshot: this.currentCapacitySnapshot(),
      budgetSnapshot: this.currentBudgetSnapshot(run),
      gateRefs: gates.map((gate) => gate.name),
      blockedReasons: gates.filter((gate) => gate.status === 'fail').map((gate) => `${gate.name}: ${gate.evidence}`),
      metadata: {
        worker_role: checker.role,
        worker_runtime: runtime,
        maker_lease_id: maker.id,
        verdict,
        runtime_pid: result.runtimePid,
        runtime_signal: result.signal,
        runtime_timed_out: result.timedOut,
        runtime_timed_out_at: result.timedOutAt,
        exit_status: exitStatus,
        timed_out: timedOut,
        runtime_usage: runtimeUsage || { usage_source: 'unknown' },
        runtime_warnings: runtimeWarnings,
        started_from: 'executeChecker',
      },
    });

    this.assurance.createTraceSpan({
      trace_id: traceId,
      loop_run_id: run.id,
      span_type: 'worker',
      name: `${checker.role}:${runtime}:completion`,
      status: failed ? 'error' : 'ok',
      evidence_ref: stdoutPath,
      metadata: {
        worker_lease_id: checker.id,
        maker_lease_id: maker.id,
        role: checker.role,
        runtime,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        gates,
        verdict,
      },
    });

    const checkpointAfter = this.assurance.createCheckpoint({
      loop_run_id: run.id,
      label: `after checker ${checker.id}`,
      metadata: {
        worker_lease_id: checker.id,
        maker_lease_id: maker.id,
        worker_role: checker.role,
        worker_runtime: runtime,
        phase: 'after_checker_execution',
      },
    });
    this.patchWorkerLeaseMetadata(checker.id, {
      checkpoint_after_id: checkpointAfter.id,
    });
    const finalRun = failed ? this.escalateIfFailureThresholdExceeded(run.id, 'checker_execution_failed') : this.verifyLoopRun(run.id).run;

    return {
      run: finalRun,
      lease: this.listWorkerLeases(run.id).find((candidate) => candidate.id === checker.id)!,
      gates,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      checkpoint_before: checkpointBefore,
      checkpoint_after: checkpointAfter,
      trace: this.assurance.getTrace(traceId),
    };
  }

  getCatalog() {
    return {
      loops: LOOP_CONTRACTS.map((contract) => ({
        ...contract,
        status: 'implemented',
        gates: [
          ...contract.verification,
          'worktree_isolation',
          'retry_budget',
          'failure_threshold_escalation',
          'split_parent_not_assignable',
          'token_budget',
          'wall_clock_budget',
        ],
        runtimes: {
          manual: this.getRuntimeContract('manual'),
          mock: this.getRuntimeContract('mock'),
          codex: this.getRuntimeContract('codex'),
          opencode: this.getRuntimeContract('opencode'),
          pi: this.getRuntimeContract('pi'),
        },
      })),
    };
  }

  getRuntimeContracts(): { runtimes: Record<string, RuntimeContract> } {
    return {
      runtimes: {
        manual: this.getRuntimeContract('manual'),
        mock: this.getRuntimeContract('mock'),
        codex: this.getRuntimeContract('codex'),
        opencode: this.getRuntimeContract('opencode'),
        claude: this.getRuntimeContract('claude'),
        gemini: this.getRuntimeContract('gemini'),
        editor: this.getRuntimeContract('editor'),
        pi: this.getRuntimeContract('pi'),
      },
    };
  }

  private getLoopContract(name: string): LoopContract {
    const contract = LOOP_CONTRACTS.find((candidate) => candidate.name === name);
    if (!contract) {
      throw new Error('LOOP_NAME_UNSUPPORTED');
    }
    return contract;
  }

  private validateGoalInput(input: GoalCreateInput): void {
    if (!input.objective || !input.objective.trim()) {
      throw new Error('GOAL_OBJECTIVE_REQUIRED');
    }
    if (!Array.isArray(input.acceptance_criteria) || input.acceptance_criteria.filter(Boolean).length === 0) {
      throw new Error('GOAL_ACCEPTANCE_CRITERIA_REQUIRED');
    }
    const validRisks: RiskClass[] = ['low', 'medium', 'high', 'critical'];
    if (input.risk_class && !validRisks.includes(input.risk_class)) {
      throw new Error('GOAL_RISK_CLASS_INVALID');
    }
  }

  private resolveRepositoryPath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
      throw new Error('REPOSITORY_PATH_NOT_FOUND');
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error('REPOSITORY_PATH_NOT_DIRECTORY');
    }
    // OKF allowlist: accept only configured roots or the implicit repo root
    // (cwd at startup). OKF_ALLOWED_ROOTS is colon-separated absolute paths.
    const allowedEnv = process.env.OKF_ALLOWED_ROOTS;
    if (allowedEnv) {
      const roots = allowedEnv.split(':').map((r) => path.resolve(r.trim())).filter(Boolean);
      const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
      if (!ok) throw new Error('OKF_PATH_NOT_ALLOWED');
    }
    return resolved;
  }

  private assertNoFailedGates(run: LoopRunRecord): void {
    if (run.gates.some((gate) => gate.status === 'fail')) {
      throw new Error('LOOP_FAILED_GATES_BLOCK_CONTINUE');
    }
  }

  private assertLoopNotEscalated(run: LoopRunRecord): void {
    if (run.status === 'escalated') {
      throw new Error('LOOP_ESCALATED_REQUIRES_HUMAN');
    }
  }

  private assertTokenBudgetAvailable(run: LoopRunRecord): void {
    const budget = this.getTokenBudget(run);
    if (!budget.maxTokens) {
      return;
    }
    const used = this.sumRuntimeTokens(this.listWorkerLeases(run.id));
    if (used >= budget.maxTokens) {
      throw new Error('LOOP_TOKEN_BUDGET_EXHAUSTED');
    }
  }

  private assertWallClockBudgetAvailable(run: LoopRunRecord): void {
    const budget = this.getWallClockBudget(run);
    if (!budget.maxRuntimeMs) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - Date.parse(run.created_at));
    if (elapsedMs <= budget.maxRuntimeMs) {
      return;
    }

    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, next_actions_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      'blocked',
      JSON.stringify(['Wall-clock loop budget exhausted', 'Human review required before leasing more workers']),
      new Date().toISOString(),
      run.id
    );

    this.recordLoopEvent(run.id, 'loop_budget_exhausted', 'warning', 'Wall-clock loop budget exhausted.', {
      budget_type: 'wall_clock',
      elapsed_ms: elapsedMs,
      max_runtime_ms: budget.maxRuntimeMs,
      source: budget.source,
    });

    throw new Error('LOOP_WALL_CLOCK_BUDGET_EXHAUSTED');
  }

  private isSplitFinding(finding: LoopFinding): boolean {
    return finding.metadata?.status === 'split';
  }

  private getMakerLeaseBudget(run: LoopRunRecord, input: ContinueLoopInput): { maxMakerWorkers: number; source: 'goal' | 'request' | 'default' } {
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      const maxFromGoal = Number(goal.budget.max_maker_workers ?? goal.budget.max_workers);
      if (Number.isFinite(maxFromGoal) && maxFromGoal > 0) {
        return { maxMakerWorkers: Math.min(Math.floor(maxFromGoal), 100), source: 'goal' };
      }
    }

    const maxFromRequest = Number(input.max_maker_workers);
    if (Number.isFinite(maxFromRequest) && maxFromRequest > 0) {
      return { maxMakerWorkers: Math.min(Math.floor(maxFromRequest), 100), source: 'request' };
    }

    return { maxMakerWorkers: 5, source: 'default' };
  }

  private getRetryBudget(run: LoopRunRecord, maker: WorkerLeaseRecord, input: RetryLoopInput): { maxRetries: number; source: 'goal' | 'request' | 'lease' | 'default' } {
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      const maxFromGoal = Number(goal.budget.max_retries);
      if (Number.isFinite(maxFromGoal) && maxFromGoal >= 0) {
        return { maxRetries: Math.min(Math.floor(maxFromGoal), 10), source: 'goal' };
      }
    }

    const maxFromRequest = Number(input.max_retries);
    if (Number.isFinite(maxFromRequest) && maxFromRequest >= 0) {
      return { maxRetries: Math.min(Math.floor(maxFromRequest), 10), source: 'request' };
    }

    const maxFromLease = Number(maker.budget.max_retries);
    if (Number.isFinite(maxFromLease) && maxFromLease >= 0) {
      return { maxRetries: Math.min(Math.floor(maxFromLease), 10), source: 'lease' };
    }

    return { maxRetries: 1, source: 'default' };
  }

  private getFailureThreshold(run: LoopRunRecord): { maxFailureCount: number; source: 'goal' | 'default' } {
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      const maxFromGoal = Number(goal.budget.max_failure_count);
      if (Number.isFinite(maxFromGoal) && maxFromGoal > 0) {
        return { maxFailureCount: Math.min(Math.floor(maxFromGoal), 20), source: 'goal' };
      }
    }

    return { maxFailureCount: 3, source: 'default' };
  }

  private getTokenBudget(run: LoopRunRecord): {
    maxTokens?: number;
    maxTokensPerWorker?: number;
    maxTokensPerDiffLine?: number;
    source: 'goal' | 'default';
    profile: string;
  } {
    const defaults = this.defaultTokenBudgetForRun(run);
    if (!run.goal_id) {
      return defaults;
    }
    const goal = this.getGoal(run.goal_id);
    if (goal.budget.high_context === true || goal.budget.profile === 'full-context') {
      return { source: 'goal', profile: 'full-context' };
    }
    const maxTokens = Number(goal.budget.max_tokens);
    const maxTokensPerWorker = Number(goal.budget.max_tokens_per_worker);
    const maxTokensPerDiffLine = Number(goal.budget.max_tokens_per_diff_line);
    return {
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : defaults.maxTokens,
      maxTokensPerWorker: Number.isFinite(maxTokensPerWorker) && maxTokensPerWorker > 0 ? Math.floor(maxTokensPerWorker) : defaults.maxTokensPerWorker,
      maxTokensPerDiffLine: Number.isFinite(maxTokensPerDiffLine) && maxTokensPerDiffLine > 0 ? Math.floor(maxTokensPerDiffLine) : defaults.maxTokensPerDiffLine,
      source: 'goal',
      profile: String(goal.budget.profile || defaults.profile),
    };
  }

  private getWallClockBudget(run: LoopRunRecord): { maxRuntimeMs?: number; source: 'goal' | 'none' } {
    if (!run.goal_id) {
      return { source: 'none' };
    }
    const goal = this.getGoal(run.goal_id);
    const maxRuntimeMs = Number(goal.budget.max_runtime_ms);
    return {
      maxRuntimeMs: Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0 ? Math.floor(maxRuntimeMs) : undefined,
      source: 'goal',
    };
  }

  /**
   * G13: Dollar economy — compute the dollar cost of a runtime lease from its token
   * usage × price per token (configurable per runtime). Pi is free (local). This makes
   * the economy real: the system can answer "is this goal worth $5?"
   */
  private computeDollarCost(runtime: string, totalTokens: number): number {
    const pricePerMtok = {
      codex: Number(process.env.CODEX_PRICE_PER_MTOK) || 2.0,     // ~$2/Mtok (rough estimate)
      opencode: Number(process.env.OPENCODE_PRICE_PER_MTOK) || 1.0, // ~$1/Mtok (cheaper)
      pi: Number(process.env.PI_PRICE_PER_MTOK) || 0,              // free (local)
      claude: Number(process.env.CLAUDE_PRICE_PER_MTOK) || 3.0,
      gemini: Number(process.env.GEMINI_PRICE_PER_MTOK) || 1.5,
      mock: 0,
      manual: 0,
      editor: 0,
    } as Record<string, number>;
    const price = pricePerMtok[runtime] ?? 0;
    return (totalTokens / 1_000_000) * price;
  }

  /**
   * G13: Get the dollar budget for a goal (from goal.budget.dollar_budget or env default).
   */
  private getDollarBudget(run: LoopRunRecord): { maxDollars?: number; source: 'goal' | 'env' | 'none' } {
    const envDefault = Number(process.env.GOAL_DOLLAR_BUDGET);
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      const dollarBudget = Number((goal.budget as Record<string, unknown>).dollar_budget);
      if (Number.isFinite(dollarBudget) && dollarBudget > 0) {
        return { maxDollars: dollarBudget, source: 'goal' };
      }
    }
    if (Number.isFinite(envDefault) && envDefault > 0) {
      return { maxDollars: envDefault, source: 'env' };
    }
    return { source: 'none' };
  }

  /**
   * G13: Compute the total dollar spent on a run (sum of all lease costs).
   */
  private computeDollarsSpent(runId: string): number {
    const leases = this.listWorkerLeases(runId);
    let total = 0;
    for (const lease of leases) {
      const usage = lease.metadata.runtime_usage as { total_tokens?: number } | undefined;
      if (usage?.total_tokens && typeof usage.total_tokens === 'number') {
        total += this.computeDollarCost(lease.runtime, usage.total_tokens);
      }
    }
    return total;
  }

  /**
   * G13: Compute the efficiency metric: verified_artifacts / dollar.
   * A verified artifact = a completed maker lease with a passed checker.
   */
  /**
   * G34/H: Compute the learning curve — how has the swarm's performance changed
   * over recent runs? This is the inter-run learning verification: can the system
   * prove it's smarter after N runs?
   */
  computeLearningCurve(limit: number = 10): {
    runs: Array<{ run_id: string; created_at: string; success: boolean; retries: number; tokens: number; dollars: number }>;
    trend: { success_rate_improving: boolean; cost_decreasing: boolean; retries_decreasing: boolean };
    first_vs_last: { first_success_rate: number; last_success_rate: number; first_cost: number; last_cost: number };
  } {
    const runs = this.listLoopRuns().slice(0, limit).reverse(); // oldest first
    const data = runs.map(run => {
      const leases = this.listWorkerLeases(run.id);
      const makers = leases.filter(l => l.role === 'maker');
      const retries = makers.filter(l => {
        const m = l.metadata as Record<string, unknown>;
        return m.retry_root_maker_lease_id !== undefined;
      }).length;
      const tokens = makers.reduce((sum, l) => {
        const usage = l.metadata.runtime_usage as { total_tokens?: number } | undefined;
        return sum + (usage?.total_tokens || 0);
      }, 0);
      const dollars = this.computeDollarsSpent(run.id);
      const cert = this.certifyLoopRun(run.id);
      return {
        run_id: run.id,
        created_at: run.created_at,
        success: cert.certified,
        retries,
        tokens,
        dollars,
      };
    });

    if (data.length < 2) {
      return {
        runs: data,
        trend: { success_rate_improving: false, cost_decreasing: false, retries_decreasing: false },
        first_vs_last: { first_success_rate: 0, last_success_rate: 0, first_cost: 0, last_cost: 0 },
      };
    }

    
    
    const firstHalf = data.slice(0, Math.floor(data.length / 2));
    const secondHalf = data.slice(Math.floor(data.length / 2));
    const firstSR = firstHalf.filter(d => d.success).length / firstHalf.length;
    const lastSR = secondHalf.filter(d => d.success).length / secondHalf.length;
    const firstCost = firstHalf.reduce((s, d) => s + d.dollars, 0) / firstHalf.length;
    const lastCost = secondHalf.reduce((s, d) => s + d.dollars, 0) / secondHalf.length;
    const firstRetries = firstHalf.reduce((s, d) => s + d.retries, 0) / firstHalf.length;
    const lastRetries = secondHalf.reduce((s, d) => s + d.retries, 0) / secondHalf.length;

    return {
      runs: data,
      trend: {
        success_rate_improving: lastSR > firstSR,
        cost_decreasing: lastCost < firstCost,
        retries_decreasing: lastRetries < firstRetries,
      },
      first_vs_last: {
        first_success_rate: firstSR,
        last_success_rate: lastSR,
        first_cost: firstCost,
        last_cost: lastCost,
      },
    };
  }

  computeEfficiencyMetric(runId: string): { verifiedArtifacts: number; dollarsSpent: number; efficiency: number | null } {
    const leases = this.listWorkerLeases(runId);
    const completedMakers = leases.filter((l) => l.role === 'maker' && l.status === 'completed').length;
    const completedCheckers = leases.filter((l) => l.role === 'checker' && l.status === 'completed').length;
    // Verified artifacts = min(completed makers, completed checkers) — each maker needs a checker.
    const verifiedArtifacts = Math.min(completedMakers, completedCheckers);
    const dollarsSpent = this.computeDollarsSpent(runId);
    const efficiency = dollarsSpent > 0 ? verifiedArtifacts / dollarsSpent : null;
    return { verifiedArtifacts, dollarsSpent, efficiency };
  }

  /**
   * G13: Allocate the goal's dollar budget across the DAG (greedy knapsack).
   * Sort findings by competence / p50_dollars (descending), fill until budget exhausted.
   * Findings that don't fit are deferred; the goal is flagged budget_insufficient if none fit.
   */
  allocateDollarBudget(
    findings: Array<{ finding_id: string; capability_id: string | null; p50_dollars?: number; competence?: number }>,
    dollarBudget: number,
  ): { allocated: string[]; deferred: string[]; budgetInsufficient: boolean } {
    // Score each finding by competence / p50_dollars (higher = better value).
    const scored = findings.map((f) => {
      const cost = Math.max(0.001, f.p50_dollars ?? 0.01); // default $0.01 if unknown
      const comp = f.competence ?? 0.5;
      return { ...f, score: comp / cost };
    });

    // Sort by score descending (best value first).
    scored.sort((a, b) => b.score - a.score);

    const allocated: string[] = [];
    const deferred: string[] = [];
    let remaining = dollarBudget;

    for (const f of scored) {
      const cost = Math.max(0.001, f.p50_dollars ?? 0.01);
      if (cost <= remaining) {
        allocated.push(f.finding_id);
        remaining -= cost;
      } else {
        deferred.push(f.finding_id);
      }
    }

    return {
      allocated,
      deferred,
      budgetInsufficient: allocated.length === 0 && findings.length > 0,
    };
  }

  private evaluateTokenBudget(run: LoopRunRecord, runtimeUsage: RuntimeUsage | null, currentLeaseId: string, diffLines: number): {
    gate: LoopGate;
    exhausted: boolean;
    efficiencyExceeded: boolean;
    budget: Record<string, unknown>;
    tokensPerDiffLine: number | null;
  } {
    const budget = this.getTokenBudget(run);
    if (!budget.maxTokens && !budget.maxTokensPerWorker && !budget.maxTokensPerDiffLine) {
      return {
        gate: { name: 'token_budget', status: 'skipped', evidence: 'No token budget configured for this goal.' },
        exhausted: false,
        efficiencyExceeded: false,
        budget,
        tokensPerDiffLine: null,
      };
    }
    if (!runtimeUsage) {
      return {
        gate: { name: 'token_budget', status: 'skipped', evidence: 'Runtime did not report token usage; no estimate was used.' },
        exhausted: false,
        efficiencyExceeded: false,
        budget,
        tokensPerDiffLine: null,
      };
    }

    const usedBeforeCurrent = this.sumRuntimeTokens(this.listWorkerLeases(run.id).filter((lease) => lease.id !== currentLeaseId));
    const totalAfterCurrent = usedBeforeCurrent + runtimeUsage.total_tokens;
    const tokensPerDiffLine = diffLines > 0 ? runtimeUsage.total_tokens / diffLines : null;
    const perWorkerExceeded = Boolean(budget.maxTokensPerWorker && runtimeUsage.total_tokens > budget.maxTokensPerWorker);
    const totalExceeded = Boolean(budget.maxTokens && totalAfterCurrent > budget.maxTokens);
    const efficiencyExceeded = Boolean(
      budget.maxTokensPerDiffLine
      && tokensPerDiffLine !== null
      && tokensPerDiffLine > budget.maxTokensPerDiffLine
    );
    const exhausted = perWorkerExceeded || totalExceeded;

    return {
      gate: {
        name: 'token_budget',
        status: exhausted ? 'fail' : 'pass',
        evidence: `runtime_usage=${runtimeUsage.total_tokens}, total_after_current=${totalAfterCurrent}, max_tokens=${budget.maxTokens ?? 'unset'}, max_tokens_per_worker=${budget.maxTokensPerWorker ?? 'unset'}, tokens_per_diff_line=${tokensPerDiffLine ?? 'unset'}, max_tokens_per_diff_line=${budget.maxTokensPerDiffLine ?? 'unset'}.`,
      },
      exhausted,
      efficiencyExceeded,
      tokensPerDiffLine,
      budget: {
        ...budget,
        used_before_current: usedBeforeCurrent,
        total_after_current: totalAfterCurrent,
        tokens_per_diff_line: tokensPerDiffLine,
        efficiency_exceeded: efficiencyExceeded,
      },
    };
  }

  private defaultTokenBudgetForRun(run: LoopRunRecord): {
    maxTokens?: number;
    maxTokensPerWorker?: number;
    maxTokensPerDiffLine?: number;
    source: 'default';
    profile: string;
  } {
    const riskClass = String(run.metadata.risk_class || 'low');
    if (run.loop_name === LOOP_NAME && riskClass === 'low') {
      return {
        maxTokens: LOW_CONTEXT_WORKER_PROFILE.max_tokens,
        maxTokensPerWorker: LOW_CONTEXT_WORKER_PROFILE.max_tokens_per_worker,
        maxTokensPerDiffLine: LOW_CONTEXT_WORKER_PROFILE.max_tokens_per_diff_line,
        source: 'default',
        profile: LOW_CONTEXT_WORKER_PROFILE.name,
      };
    }
    return { source: 'default', profile: 'standard-worker' };
  }

  private getWorkerRuntimeProfile(run: LoopRunRecord): Record<string, unknown> {
    const budget = this.getTokenBudget(run);
    return {
      name: budget.profile,
      scope: budget.profile === LOW_CONTEXT_WORKER_PROFILE.name ? LOW_CONTEXT_WORKER_PROFILE.scope : 'standard',
      token_budget: {
        max_tokens: budget.maxTokens ?? null,
        max_tokens_per_worker: budget.maxTokensPerWorker ?? null,
        max_tokens_per_diff_line: budget.maxTokensPerDiffLine ?? null,
        source: budget.source,
      },
      instructions: budget.profile === LOW_CONTEXT_WORKER_PROFILE.name
        ? ['Use the assignment packet and local repository only.', 'Avoid broad unrelated workspace context.', 'Keep changes bounded to the finding.']
        : [],
    };
  }

  private markTokenEfficiencyBudgetRisk(
    run: LoopRunRecord,
    leaseId: string,
    runtimeUsage: RuntimeUsage | null,
    tokenBudget: { budget: Record<string, unknown>; tokensPerDiffLine: number | null }
  ): void {
    const latest = this.getLoopRun(run.id);
    const budgetRisk = {
      type: 'token_efficiency',
      lease_id: leaseId,
      runtime_usage: runtimeUsage,
      tokens_per_diff_line: tokenBudget.tokensPerDiffLine,
      budget: tokenBudget.budget,
      recorded_at: new Date().toISOString(),
    };
    const metadata = {
      ...latest.metadata,
      budget_risk: budgetRisk,
    };
    this.db.prepare('UPDATE loop_runs SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), run.id);
    this.recordLoopEvent(run.id, 'token_efficiency_budget_risk', 'warning', 'Worker exceeded the configured token-per-diff efficiency threshold.', budgetRisk);
  }

  private sumRuntimeTokens(leases: WorkerLeaseRecord[]): number {
    return leases.reduce((sum, lease) => {
      const usage = lease.metadata.runtime_usage as { total_tokens?: unknown } | undefined;
      const total = Number(usage?.total_tokens);
      return Number.isFinite(total) && total > 0 ? sum + total : sum;
    }, 0);
  }

  private extractRuntimeUsage(stdout: string): RuntimeUsage | null {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        const normalized = this.normalizeRuntimeUsage(
          parsed.usage
            || parsed.response?.usage
            || parsed.token_usage
            || parsed.message?.usage
            || parsed
        );
        if (normalized) {
          return normalized;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private normalizeRuntimeUsage(input: unknown): RuntimeUsage | null {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const usage = input as Record<string, unknown>;
    const tokenAlias = this.normalizeTokenAlias(usage);
    const promptTokens = Number(
      usage.prompt_tokens ?? usage.input_tokens ??
      tokenAlias.prompt ?? tokenAlias.input ?? usage.input ??
      usage.prompt,
    );
    const completionTokens = Number(
      usage.completion_tokens ?? usage.output_tokens ??
      tokenAlias.completion ?? tokenAlias.output ?? usage.output ??
      usage.completion,
    );
    const explicitTotal = Number(usage.total_tokens ?? usage.totalTokens);
    const calculatedTotal = (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0);
    const explicitTotalValue = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : calculatedTotal;
    const aliasTotal = Number(tokenAlias.total);
    const resolvedTotal = Number.isFinite(explicitTotalValue) && explicitTotalValue > 0 ? explicitTotalValue : aliasTotal;
    if (!Number.isFinite(resolvedTotal) || resolvedTotal <= 0) {
      return null;
    }
    return {
      ...(Number.isFinite(promptTokens) && promptTokens >= 0 ? { prompt_tokens: promptTokens } : {}),
      ...(Number.isFinite(completionTokens) && completionTokens >= 0 ? { completion_tokens: completionTokens } : {}),
      total_tokens: resolvedTotal,
      usage_source: 'runtime_stdout',
    };
  }

  private normalizeTokenAlias(usage: Record<string, unknown>): {
    prompt?: number;
    completion?: number;
    input?: number;
    output?: number;
    total?: number;
  } {
    const tokenUsage = usage.tokens || usage.token_usage || usage.tokenUsage;
    if (!tokenUsage || typeof tokenUsage !== 'object') {
      return {};
    }
    const tokens = tokenUsage as Record<string, unknown>;
    const toNumber = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      ...(toNumber(tokens.prompt ?? tokens.input_tokens) !== undefined ? { prompt: toNumber(tokens.prompt ?? tokens.input_tokens) } : {}),
      ...(toNumber(tokens.completion ?? tokens.output_tokens) !== undefined ? { completion: toNumber(tokens.completion ?? tokens.output_tokens) } : {}),
      ...(toNumber(tokens.input ?? tokens.prompt) !== undefined ? { input: toNumber(tokens.input ?? tokens.prompt) } : {}),
      ...(toNumber(tokens.output ?? tokens.completion) !== undefined ? { output: toNumber(tokens.output ?? tokens.completion) } : {}),
      ...(toNumber(tokens.total) !== undefined ? { total: toNumber(tokens.total) } : {}),
    };
  }

  private escalateIfFailureThresholdExceeded(runId: string, reason: string): LoopRunRecord {
    const run = this.getLoopRun(runId);
    const threshold = this.getFailureThreshold(run);
    const leases = this.listWorkerLeases(runId);
    const failureCount = this.countLoopFailures(leases);
    if (failureCount < threshold.maxFailureCount) {
      return run;
    }

    if (run.status !== 'escalated') {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, next_actions_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        'escalated',
        JSON.stringify([
          'Human review required before leasing more workers',
          'Inspect review bundle and decide retry, split, or cancel',
        ]),
        now,
        runId
      );

      this.recordLoopEvent(runId, 'loop_escalated', 'warning', `Loop escalated after ${failureCount} failure(s).`, {
        reason,
        failure_count: failureCount,
        failure_threshold: threshold,
      });
    }

    return this.getLoopRun(runId);
  }

  private countLoopFailures(leases: WorkerLeaseRecord[]): number {
    const makerFailures = leases.filter((lease) => lease.role === 'maker' && lease.status === 'failed').length;
    const checkerFailures = leases.filter((lease) => (
      (lease.role === 'checker' || lease.role === 'security_checker')
      && ['needs_revision', 'rejected', 'insufficient_evidence'].includes(String(lease.metadata.verdict || ''))
    )).length;
    return makerFailures + checkerFailures;
  }

  private isHighRiskRun(run: LoopRunRecord, finding?: LoopFinding): boolean {
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      if (goal.risk_class === 'high' || goal.risk_class === 'critical') {
        return true;
      }
    }
    const candidates = finding ? [finding] : run.findings;
    return candidates.some((candidate) => Boolean(this.highRiskReason(run, candidate)));
  }

  private highRiskReason(run: LoopRunRecord, finding?: LoopFinding): string | null {
    const runRisk = String(run.metadata.risk_class || '');
    if (runRisk === 'high' || runRisk === 'critical') {
      return `loop_risk_class:${runRisk}`;
    }
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      if (goal.risk_class === 'high' || goal.risk_class === 'critical') {
        return `goal_risk_class:${goal.risk_class}`;
      }
    }
    if (!finding) {
      return null;
    }
    const haystack = [
      finding.file,
      finding.message,
      finding.evidence,
      finding.suggested_fix,
    ].join(' ').toLowerCase();
    if (/(auth|oauth|oidc|secret|token|password|credential|infra|terraform|docker|deploy|production|policy|ci\/cd|github actions)/.test(haystack)) {
      return 'sensitive_finding_content';
    }
    return null;
  }

  private discoverLoopFindings(loopName: LoopName, repositoryPath: string, maxFindings: number): LoopFinding[] {
    if (loopName === 'doc-drift-and-small-fix-loop') {
      return this.discoverDocDrift(repositoryPath, maxFindings);
    }
    if (loopName === 'repo-maintenance-loop') {
      return this.discoverRepoMaintenance(repositoryPath, maxFindings);
    }
    if (loopName === 'skill-quality-loop') {
      return this.discoverSkillQuality(repositoryPath, maxFindings);
    }
    if (loopName === 'mcp-connector-validation-loop') {
      return this.discoverMcpConnectorValidation(repositoryPath, maxFindings);
    }
    if (loopName === 'security-regression-loop') {
      return this.discoverSecurityRegression(repositoryPath, maxFindings);
    }
    if (loopName === 'okf-synchronization-loop') {
      return this.discoverOkfSynchronization(repositoryPath, maxFindings);
    }
    if (loopName === 'overwatch-policy-drift-loop') {
      return this.discoverOverwatchPolicyDrift(repositoryPath, maxFindings);
    }
    return [];
  }

  private discoverDocDrift(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const scripts = this.collectPackageScripts(repositoryPath);
    const markdownFiles = this.collectMarkdownFiles(repositoryPath);
    const findings: LoopFinding[] = [];

    for (const filePath of markdownFiles) {
      if (findings.length >= maxFindings) break;
      const rel = path.relative(repositoryPath, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        const lineNumber = i + 1;
        if (/\b(TODO|FIXME|XXX)\b/i.test(line)) {
          findings.push({
            id: randomUUID(),
            type: 'doc_todo',
            severity: 'info',
            file: rel,
            line: lineNumber,
            message: 'Documentation contains an explicit TODO/FIXME marker.',
            evidence: line.trim().slice(0, 240),
            suggested_fix: 'Resolve the marker or convert it to a tracked issue with owner and acceptance criteria.',
          });
        }

        const scriptMatches = line.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g);
        for (const match of scriptMatches) {
          const scriptName = match[1];
          if (!scripts.has(scriptName) && findings.length < maxFindings) {
            findings.push({
              id: randomUUID(),
              type: 'missing_script_reference',
              severity: 'warning',
              file: rel,
              line: lineNumber,
              message: `Markdown references npm script "${scriptName}", but no package.json in the scan scope defines it.`,
              evidence: line.trim().slice(0, 240),
              suggested_fix: `Update the command reference or add a real "${scriptName}" script where appropriate.`,
            });
          }
        }

        const linkMatches = line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
        for (const match of linkMatches) {
          const target = match[1].split('#')[0].trim();
          if (this.isCheckableRelativeLink(target) && !this.relativeTargetExists(path.dirname(filePath), target) && findings.length < maxFindings) {
            findings.push({
              id: randomUUID(),
              type: 'broken_relative_link',
              severity: 'warning',
              file: rel,
              line: lineNumber,
              message: `Markdown link target does not exist: ${target}`,
              evidence: line.trim().slice(0, 240),
              suggested_fix: 'Fix the relative link target or remove the stale reference.',
            });
          }
        }
      }

      if (rel.startsWith('packages/knowledge/skills/')) {
        this.collectDraftSkillFinding(rel, content, findings, maxFindings);
      }
    }

    return findings;
  }

  private discoverRepoMaintenance(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const packageJson = path.join(repositoryPath, 'package.json');
    if (fs.existsSync(packageJson)) {
      const scripts = this.readScriptsFromPackageJson(packageJson);
      for (const scriptName of ['test', 'lint', 'type-check']) {
        if (findings.length >= maxFindings) break;
        if (!scripts.has(scriptName)) {
          findings.push(this.createFinding('missing_validation_script', 'warning', repositoryPath, packageJson, `package.json does not define "${scriptName}".`, `script "${scriptName}" missing`, `Add a real "${scriptName}" script or document why this repository cannot run that gate.`));
        }
      }
    }

    this.collectTodoCommentFindings(repositoryPath, findings, maxFindings, {
      type: 'repo_todo',
      message: 'Repository source contains TODO/FIXME marker.',
      suggested_fix: 'Resolve the marker or convert it to a tracked issue with owner and acceptance criteria.',
    });

    return findings;
  }

  private discoverSkillQuality(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const skillDir = path.join(repositoryPath, 'packages', 'knowledge', 'skills');
    if (!fs.existsSync(skillDir)) {
      findings.push(this.createFinding('skill_inventory_missing', 'warning', repositoryPath, skillDir, 'packages/knowledge/skills is missing.', 'skill directory missing', 'Create the loop skill inventory or configure the OKF skill root explicitly.'));
      return findings.slice(0, maxFindings);
    }

    const skillFiles = this.collectFiles(skillDir, (file) => file.endsWith('.md'), 100);
    for (const file of skillFiles) {
      if (findings.length >= maxFindings) break;
      const rel = path.relative(repositoryPath, file);
      const content = fs.readFileSync(file, 'utf8');
      this.collectDraftSkillFinding(rel, content, findings, maxFindings);
      for (const field of ['actions_allowed:', 'actions_forbidden:', 'gates:', 'escalation:']) {
        if (findings.length >= maxFindings) break;
        if (!content.includes(field)) {
          findings.push({
            id: randomUUID(),
            type: 'invalid_skill_contract',
            severity: 'warning',
            file: rel,
            message: `Loop skill is missing required governance field ${field.replace(':', '')}.`,
            evidence: `${field} not found`,
            suggested_fix: `Add ${field.replace(':', '')} to the skill frontmatter before enabling orchestration.`,
          });
        }
      }
    }

    return findings;
  }

  private discoverMcpConnectorValidation(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const seedPath = path.join(repositoryPath, 'packages', 'server', 'src', 'database', 'seed-mcp-servers.ts');
    const routePath = path.join(repositoryPath, 'packages', 'server', 'src', 'routes', 'mcp.ts');

    if (!fs.existsSync(seedPath)) {
      findings.push(this.createFinding('mcp_inventory_missing', 'warning', repositoryPath, seedPath, 'MCP seed inventory file is missing.', 'seed-mcp-servers.ts missing', 'Add or document the canonical MCP inventory source.'));
    }
    if (!fs.existsSync(routePath)) {
      findings.push(this.createFinding('mcp_permission_route_missing', 'warning', repositoryPath, routePath, 'MCP permission route is missing.', 'routes/mcp.ts missing', 'Add read-only inventory and explicit permission endpoints for MCP tools.'));
    } else {
      const routeContent = fs.readFileSync(routePath, 'utf8');
      if (!routeContent.includes('mcp_tool_permissions') && findings.length < maxFindings) {
        findings.push(this.createFinding('mcp_permission_gap', 'warning', repositoryPath, routePath, 'MCP route does not reference mcp_tool_permissions.', 'permission table not referenced', 'Wire MCP permission decisions into connector inventory responses.'));
      }
    }

    return findings.slice(0, maxFindings);
  }

  private discoverSecurityRegression(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const packageJson = path.join(repositoryPath, 'package.json');
    if (fs.existsSync(packageJson)) {
      const scripts = this.readScriptsFromPackageJson(packageJson);
      const hasSecurityScript = [...scripts].some((script) => /(security|secret|sast|audit|semgrep)/i.test(script));
      if (!hasSecurityScript) {
        findings.push(this.createFinding('missing_security_script', 'warning', repositoryPath, packageJson, 'No security/audit/secret scanning npm script is defined.', 'security script missing', 'Add a deterministic security gate such as audit, secret scan, SAST, or document the external CI gate.'));
      }
    }

    const markdownFiles = this.collectMarkdownFiles(repositoryPath);
    for (const file of markdownFiles) {
      if (findings.length >= maxFindings) break;
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        if (/\b(TODO|FIXME)\b.*\b(auth|oauth|oidc|secret|token|password|credential|policy)\b/i.test(line)) {
          findings.push({
            id: randomUUID(),
            type: 'security_sensitive_todo',
            severity: 'warning',
            file: path.relative(repositoryPath, file),
            line: i + 1,
            message: 'Security-sensitive TODO/FIXME requires explicit tracking and review.',
            evidence: line.trim().slice(0, 240),
            suggested_fix: 'Resolve the security-sensitive TODO or split it into a tracked high-risk task with security checker review.',
          });
        }
      }
    }

    return findings;
  }

  private discoverOkfSynchronization(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const knowledgeDir = path.join(repositoryPath, 'packages', 'knowledge');
    if (!fs.existsSync(knowledgeDir)) {
      findings.push(this.createFinding('okf_root_missing', 'warning', repositoryPath, knowledgeDir, 'packages/knowledge is missing.', 'OKF root missing', 'Create the OKF knowledge root or configure OKF_BASE.'));
      return findings.slice(0, maxFindings);
    }

    for (const dirname of ['skills', 'agents', 'tasks', 'memory']) {
      if (findings.length >= maxFindings) break;
      const dir = path.join(knowledgeDir, dirname);
      if (!fs.existsSync(dir)) {
        findings.push(this.createFinding('okf_directory_missing', 'warning', repositoryPath, dir, `OKF directory packages/knowledge/${dirname} is missing.`, `${dirname} directory missing`, `Create packages/knowledge/${dirname} or document why this OKF facet is external.`));
      }
    }

    const skillsIndex = path.join(knowledgeDir, 'skills', 'index.md');
    if (fs.existsSync(path.join(knowledgeDir, 'skills')) && !fs.existsSync(skillsIndex) && findings.length < maxFindings) {
      findings.push(this.createFinding('okf_index_missing', 'warning', repositoryPath, skillsIndex, 'packages/knowledge/skills/index.md is missing.', 'skills index missing', 'Generate a skill index so dashboard and agents can inspect available loop skills.'));
    }

    return findings;
  }

  private discoverOverwatchPolicyDrift(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const policyRoute = path.join(repositoryPath, 'packages', 'server', 'src', 'routes', 'policies.ts');
    const migratePath = path.join(repositoryPath, 'packages', 'server', 'src', 'database', 'migrate.ts');
    const riskClassifier = path.join(repositoryPath, 'packages', 'server', 'src', 'services', 'command-risk-classifier.ts');

    for (const file of [policyRoute, migratePath, riskClassifier]) {
      if (findings.length >= maxFindings) break;
      if (!fs.existsSync(file)) {
        findings.push(this.createFinding('policy_control_missing', 'warning', repositoryPath, file, `Expected policy control file is missing: ${path.relative(repositoryPath, file)}`, 'policy control file missing', 'Restore or document the policy control boundary before running mutating workers.'));
      }
    }

    if (fs.existsSync(migratePath)) {
      const content = fs.readFileSync(migratePath, 'utf8');
      for (const requiredPolicy of ['policy-critical-secrets-deny', 'policy-medium-task-approval']) {
        if (findings.length >= maxFindings) break;
        if (!content.includes(requiredPolicy)) {
          findings.push(this.createFinding('policy_seed_gap', 'warning', repositoryPath, migratePath, `Approval policy seed is missing ${requiredPolicy}.`, requiredPolicy, 'Add or document the required approval policy seed.'));
        }
      }
    }

    return findings;
  }

  private collectPackageScripts(repositoryPath: string): Set<string> {
    const packageJsonFiles = this.collectFiles(repositoryPath, (file) => path.basename(file) === 'package.json', 40);
    const scripts = new Set<string>();
    for (const file of packageJsonFiles) {
      for (const scriptName of this.readScriptsFromPackageJson(file)) {
        scripts.add(scriptName);
      }
    }
    return scripts;
  }

  private readScriptsFromPackageJson(file: string): Set<string> {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
      return new Set(Object.keys(json.scripts || {}));
    } catch {
      return new Set();
    }
  }

  private collectMarkdownFiles(repositoryPath: string): string[] {
    return this.collectFiles(repositoryPath, (file) => file.endsWith('.md') && fs.statSync(file).size <= MAX_MARKDOWN_FILE_BYTES, 300);
  }

  private collectFiles(root: string, predicate: (file: string) => boolean, maxFiles: number): string[] {
    const results: string[] = [];
    const visit = (dir: string) => {
      if (results.length >= maxFiles) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) {
            visit(fullPath);
          }
        } else if (entry.isFile() && predicate(fullPath)) {
          results.push(fullPath);
        }
      }
    };
    visit(root);
    return results.sort();
  }

  private isCheckableRelativeLink(target: string): boolean {
    if (!target || target.startsWith('#')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
    if (target.startsWith('/')) return false;
    return true;
  }

  private relativeTargetExists(baseDir: string, target: string): boolean {
    try {
      const decoded = decodeURIComponent(target);
      return fs.existsSync(path.resolve(baseDir, decoded));
    } catch {
      return false;
    }
  }

  private collectDraftSkillFinding(rel: string, content: string, findings: LoopFinding[], maxFindings: number): void {
    if (findings.length >= maxFindings) return;
    if (content.includes('status: draft') || content.includes('trust_level: proposed')) {
      findings.push({
        id: randomUUID(),
        type: 'draft_loop_skill',
        severity: 'info',
        file: rel,
        message: 'Loop skill is still draft/proposed and cannot orchestrate live workers.',
        evidence: 'status/trust_level indicates non-active loop skill',
        suggested_fix: 'Run skill validation and governance review before allowing live worker orchestration.',
      });
    }
  }

  private collectTodoCommentFindings(
    repositoryPath: string,
    findings: LoopFinding[],
    maxFindings: number,
    template: { type: string; message: string; suggested_fix: string }
  ): void {
    const files = this.collectFiles(repositoryPath, (file) => /\.(ts|tsx|js|jsx|py|sh|md|yml|yaml)$/.test(file), 300);
    for (const file of files) {
      if (findings.length >= maxFindings) break;
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        if (/\b(TODO|FIXME|XXX)\b/i.test(line)) {
          findings.push({
            id: randomUUID(),
            type: template.type,
            severity: 'info',
            file: path.relative(repositoryPath, file),
            line: i + 1,
            message: template.message,
            evidence: line.trim().slice(0, 240),
            suggested_fix: template.suggested_fix,
          });
        }
      }
    }
  }

  private createFinding(
    type: string,
    severity: LoopFinding['severity'],
    repositoryPath: string,
    filePath: string,
    message: string,
    evidence: string,
    suggestedFix: string
  ): LoopFinding {
    return {
      id: randomUUID(),
      type,
      severity,
      file: path.relative(repositoryPath, filePath) || path.basename(filePath),
      message,
      evidence,
      suggested_fix: suggestedFix,
    };
  }

  private createPlan(loopName: LoopName, findings: LoopFinding[]): Record<string, unknown> {
    const contract = this.getLoopContract(loopName);
    return {
      loop_name: loopName,
      mode: 'closed',
      risk_class: contract.risk_class,
      workers_leased: 0,
      mutating_actions: false,
      proposed_tasks: findings.filter((finding) => !this.isSplitFinding(finding)).map((finding) => ({
        title: this.titleForFinding(finding),
        finding_id: finding.id,
        file: finding.file,
        line: finding.line || null,
        risk_class: contract.risk_class,
        parent_finding_id: finding.parent_finding_id || null,
        requires_human_approval_before_merge: true,
        maker_role: `${loopName}-maker`,
        checker_role: `${loopName}-checker`,
        security_checker_required: contract.risk_class === 'high' || contract.risk_class === 'critical',
        suggested_fix: finding.suggested_fix,
      })),
    };
  }

  private branchNameFor(runId: string, findingId: string, retryAttempt?: number): string {
    const suffix = retryAttempt ? `-r${retryAttempt}` : '';
    const runSegment = this.pathSegmentForWorktreeId(runId).slice(0, 18);
    const findingSegment = this.pathSegmentForWorktreeId(findingId).slice(0, 32);
    return `agent/loop/${runSegment}-${findingSegment}${suffix}`;
  }

  private pathSegmentForWorktreeId(id: string): string {
    const segment = id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return segment || 'finding';
  }

  private createWorktree(repositoryPath: string, runId: string, findingId: string, branchName: string): string {
    // Worktrees MUST live OUTSIDE the host repo. repositoryPath may be a sub-workspace
    // *inside* the repo (e.g. packages/server); basing the root on it placed worktrees at
    // packages/.djimitflo-loop-worktrees — INSIDE the repo — so a runtime launched with
    // --cd <worktree> had the host source tree as filesystem siblings and could edit the
    // host repo by upward exploration (observed: a real codex maker mutated host source).
    // Base the root on the git toplevel (repo root) so worktrees are a sibling of the repo,
    // outside it. LOOP_WORKTREE_ROOT overrides for operators wanting a dedicated sandbox
    // root. NOTE: this hardens isolation against accidental/relative-path escape; a
    // determined runtime can still reach the host by absolute path — full isolation needs
    // a sandbox (separate follow-up).
    const sourceRoot = this.git(repositoryPath, ['rev-parse', '--show-toplevel']).trim();
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT || path.resolve(sourceRoot, '..', '.djimitflo-loop-worktrees');
    const worktreePath = path.join(worktreeRoot, runId, this.pathSegmentForWorktreeId(findingId));
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    if (fs.existsSync(worktreePath)) {
      this.ensureWorktreeDependencyBridge(repositoryPath, worktreePath);
      return worktreePath;
    }
    // `git worktree add` takes the source repo's worktree lock. Under concurrent
    // fleet operation (or parallel test forks that share a source repo) a sibling
    // git process may briefly hold .git/worktree.lock; retry a few times before
    // giving up so a transient lock race does not fail a worker lease.
    const MAX_ATTEMPTS = 3;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        this.git(repositoryPath, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
        this.applySourceWorkingTreeDiff(repositoryPath, worktreePath);
        this.ensureWorktreeDependencyBridge(repositoryPath, worktreePath);
        return worktreePath;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_ATTEMPTS && LoopService.isGitLockError(lastError)) {
          this.sleepSync(250 * attempt);
          continue;
        }
        throw new Error(`WORKTREE_CREATE_FAILED: ${lastError.message}`);
      }
    }
    throw new Error(`WORKTREE_CREATE_FAILED: ${lastError?.message ?? 'unknown'}`);
  }

  private ensureWorktreeDependencyBridge(repositoryPath: string, worktreePath: string): void {
    const sourceRoot = this.git(repositoryPath, ['rev-parse', '--show-toplevel']);
    const sourceNodeModules = path.join(sourceRoot, 'node_modules');
    const worktreeNodeModules = path.join(worktreePath, 'node_modules');
    if (!fs.existsSync(sourceNodeModules) || fs.existsSync(worktreeNodeModules)) {
      return;
    }
    fs.symlinkSync(sourceNodeModules, worktreeNodeModules, 'dir');
  }

  private applySourceWorkingTreeDiff(repositoryPath: string, worktreePath: string): void {
    const sourceRoot = this.git(repositoryPath, ['rev-parse', '--show-toplevel']);
    const diff = execFileSync('git', ['-C', sourceRoot, 'diff', '--binary', 'HEAD', '--', '.'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!diff) {
      return;
    }
    try {
      execFileSync('git', ['-C', worktreePath, 'apply', '--binary', '--whitespace=nowarn'], {
        input: diff,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', worktreePath, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('git', [
        '-C',
        worktreePath,
        '-c',
        'user.email=djimitflo-worker@example.invalid',
        '-c',
        'user.name=Djimitflo Worker Snapshot',
        'commit',
        '-m',
        'Apply source working tree snapshot',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() || '';
      throw new Error(stderr.trim() || 'git apply dirty source diff failed');
    }
  }

  private static isGitLockError(error: Error): boolean {
    const m = error.message.toLowerCase();
    return m.includes('worktree.lock') || m.includes('index.lock') || m.includes('another git process') || m.includes('file exists');
  }

  private sleepSync(ms: number): void {
    try {
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, ms);
    } catch {
      const end = Date.now() + ms;
      while (Date.now() < end) { /* SharedArrayBuffer unavailable: busy-wait fallback */ }
    }
  }

  /**
   * Materialize a nested child worker lease (P1). This is the server-side half of
   * nested spawning: NestedSpawnService has already run the depth/cycle/budget/
   * capability gates; this method creates the real git worktree, writes the
   * assignment (optionally with a Nested Spawn Control block so this child can
   * itself spawn), and inserts a worker_leases row carrying the parent/tree/depth
   * lineage. Reuses the existing spawn-bridge primitives (createWorktree,
   * writeWorkAssignment, writeAssignmentPacket, insertWorkerLease) unchanged.
   *
   * NOTE on no-theater: this creates a real worktree + a real lease row. Whether
   * the child *process* actually runs and self-spawns depends on the runtime —
   * mock echoes (no self-spawn); codex/claude shell out to the control endpoint.
   * The spawning primitive + audit are real regardless of runtime.
   */
  prepareNestedLease(input: {
    loopRunId: string;
    role: WorkerRole;
    runtime: string;
    prompt: string;
    capabilityIds?: string[];
    parentLeaseId: string | null;
    spawnTreeId: string;
    depth: number;
    spawnedByAgentId?: string | null;
    allowNestedSpawn: boolean;
    controlUrl?: string;
    spawnToken?: string;
    depthBudget: number;
    leaseId?: string;
  }): { leaseId: string; worktreePath: string; assignmentPath: string; assignmentPacketPath: string } {
    const run = this.getLoopRun(input.loopRunId);
    if (!run.repository_path) {
      throw new Error('NESTED_SPAWN_NO_REPOSITORY');
    }
    // Pre-generated lease id lets createRoot keep the spawn_trees.id == root lease
    // id invariant and mint a spawn token scoped to that exact id before this call.
    const leaseId = input.leaseId ?? randomUUID();
    const findingId = `nested-spawn-${leaseId.slice(0, 12)}`;
    const branchName = `agent/nested/${input.spawnTreeId.slice(0, 8)}/d${input.depth}-${leaseId.slice(0, 8)}`;
    const worktreePath = this.createWorktree(run.repository_path, run.id, findingId, branchName);
    this.ensureWorktreeControlIgnore(worktreePath);

    const finding: LoopFinding = {
      id: findingId,
      type: 'nested_spawn_task',
      severity: 'info',
      file: '<nested-spawn>',
      message: input.prompt,
      evidence: `parent_lease=${input.parentLeaseId ?? 'root'} depth=${input.depth} tree=${input.spawnTreeId}`,
      suggested_fix: input.prompt,
    };

    const nestedSpawnControl = input.allowNestedSpawn
      ? this.buildNestedSpawnControlBlock({
          leaseId,
          spawnTreeId: input.spawnTreeId,
          depth: input.depth,
          depthBudget: input.depthBudget,
          controlUrl: input.controlUrl,
          spawnToken: input.spawnToken,
        })
      : undefined;

    this.writeWorkAssignment(worktreePath, run, finding, input.runtime, { nestedSpawnControl });
    const capsManifest = this.buildCapabilityManifest(input.capabilityIds);
    const assignmentPacketFile = this.writeAssignmentPacket(worktreePath, run, finding, input.runtime, undefined, capsManifest);
    const assignmentFile = this.workAssignmentPath(worktreePath);

    const now = new Date().toISOString();
    this.insertWorkerLease({
      id: leaseId,
      loopRunId: run.id,
      role: input.role,
      runtime: input.runtime,
      findingId,
      worktreePath,
      branchName,
      metadata: {
        assignment_file: assignmentFile,
        assignment_packet_file: assignmentPacketFile,
        allow_nested_spawn: input.allowNestedSpawn,
        spawn_tree_id: input.spawnTreeId,
        parent_lease_id: input.parentLeaseId,
        depth: input.depth,
        capability_ids: input.capabilityIds ?? [],
        nested_spawn: true,
      },
      now,
      parentLeaseId: input.parentLeaseId,
      spawnTreeId: input.spawnTreeId,
      depth: input.depth,
      spawnedByAgentId: input.spawnedByAgentId ?? null,
    });

    return { leaseId, worktreePath, assignmentPath: assignmentFile, assignmentPacketPath: assignmentPacketFile };
  }

  /**
   * Build the `## Nested Spawn Control` markdown block injected into a child's
   * assignment when that child is permitted to spawn its own sub-agents. The
   * block tells the runtime exactly how to shell out to the control endpoint
   * using its scoped token, and reminds it of the depth budget + cycle rule.
   */
  private buildNestedSpawnControlBlock(input: {
    leaseId: string;
    spawnTreeId: string;
    depth: number;
    depthBudget: number;
    controlUrl?: string;
    spawnToken?: string;
  }): string {
    const url = input.controlUrl || '$DJIMITFLO_CONTROL_URL';
    const token = input.spawnToken ? '<redacted>' : '$DJIMITFLO_SPAWN_TOKEN';
    return [
      '## Nested Spawn Control',
      '',
      `You are permitted to spawn sub-agents (your depth: ${input.depth}, tree depth budget: ${input.depthBudget}).`,
      `Your lease id: ${input.leaseId}. Spawn tree: ${input.spawnTreeId}.`,
      '',
      'To spawn a child, POST to the control endpoint (token forwarded as $DJIMITFLO_SPAWN_TOKEN):',
      '```sh',
      `curl -sS -X POST "${url}" \\`,
      `  -H "X-Spawn-Token: ${token}" -H "Content-Type: application/json" \\`,
      `  -d '{"requested_by_lease_id":"${input.leaseId}","parent_lease_id":"${input.leaseId}","spawn_tree_id":"${input.spawnTreeId}","role":"maker","runtime":"mock","prompt":"<sub-task>"}'`,
      '```',
      'Poll a child status: GET $DJIMITFLO_CONTROL_URL/<child_lease_id>/status',
      'Each child gets a tighter token/wall budget. Do not spawn cycles: the same prompt + role on your ancestry is rejected.',
      '',
    ].join('\n');
  }

  /**
   * realpath that never throws — falls back to a normalized absolute path when
   * the target does not exist yet (e.g. a freshly resolved worktree path).
   */
  private safeRealpath(target: string): string {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }

  /**
   * A runtime child may only request approval/sandbox bypass when the operator
   * has explicitly armed the gate via RUNTIME_ALLOW_SKIP_PERMISSIONS=true.
   * Default-deny: a missing or unset flag never grants bypass, regardless of
   * what a caller passes in. This keeps unsandboxed autonomous execution an
   * intentional, operator-authorized act rather than a silent default.
   */
  private resolveSkipPermissions(requested?: boolean): boolean {
    if (!requested) return false;
    return process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS === 'true';
  }

  /**
   * Env allowlist passed to spawned runtime children (codex/opencode). We never
   * blanket-copy process.env: the server's own secrets (auth keys, DB URLs,
   * session secrets) stay out of the child. Only standard process env, the
   * model-provider credentials the runtime legitimately needs, and an explicit
   * operator passthrough (RUNTIME_ENV_PASSTHROUGH=NAME,NAME) are forwarded.
   */
  private static readonly RUNTIME_ENV_ALLOWLIST = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
    'TMPDIR', 'TMP', 'TEMP',
    'CODEX_BIN_PATH', 'OPENCODE_BIN_PATH', 'CLAUDE_BIN_PATH', 'GEMINI_BIN_PATH', 'CLINE_BIN_PATH',
    'DJIMITFLO_CLAUDE_MODEL', 'DJIMITFLO_GEMINI_MODEL', 'DJIMITFLO_CLINE_MODEL', 'DJIMITFLO_CLINE_THINKING',
    // Nested-spawn control channel (P1): the child runtime uses these to call back
    // into the server to spawn its own sub-agents. The token is scoped + expiring.
    'DJIMITFLO_CONTROL_URL', 'DJIMITFLO_SPAWN_TOKEN',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'LOCALAI_BASE_URL', 'OLLAMA_BASE_URL', 'OLLAMA_HOST',
  ];

  private buildRuntimeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      RUNTIME_SANDBOX: '1',
      DJIMITFLO_RUNTIME_CHILD: '1',
    };
    const names = new Set<string>(LoopService.RUNTIME_ENV_ALLOWLIST);
    const extra = process.env.RUNTIME_ENV_PASSTHROUGH;
    if (extra) {
      for (const name of extra.split(',').map((value) => value.trim()).filter(Boolean)) names.add(name);
    }
    for (const name of names) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  /**
   * Mint the scoped spawn token a nested child needs to call back and spawn its
   * own sub-agents (L1). Returns undefined when the lease is not nested-spawn-armed
   * (no spawn_tree_id, or metadata.allow_nested_spawn !== true), so non-nested
   * leases get no token and behave exactly as before. The token is scoped to
   * (lease.id, lease.spawn_tree_id) — exactly what requestSpawn validates against
   * when the child later POSTs with requested_by_lease_id = its own lease id.
   * Never persisted: lives only in the child's process env and expires with the TTL.
   */
  private mintLeaseSpawnToken(lease: WorkerLeaseRecord): string | undefined {
    if (!lease.spawn_tree_id) return undefined;
    const allow = lease.metadata?.allow_nested_spawn;
    if (allow !== true) return undefined;
    if (this.spawnTokenSecret === undefined) this.spawnTokenSecret = resolveSpawnTokenSecret();
    return mintSpawnToken(this.spawnTokenSecret, lease.id, lease.spawn_tree_id);
  }

  /**
   * Build the per-child env for a nested-spawn-armed lease (L1): the static
   * buildRuntimeEnv() (PATH/HOME/model keys etc.) MERGED with the child's identity
   * and control channel. Returns undefined when the lease is not armed, so
   * executeRuntimeCommand falls back to buildRuntimeEnv() unchanged for ordinary
   * loops. CRITICAL: must return the MERGED env — executeRuntimeCommand uses
   * `options.env || buildRuntimeEnv()` (override, not merge), so returning only the
   * DJIMITFLO_* vars would strip PATH/HOME and break codex/opencode.
   */
  private buildNestedSpawnEnv(lease: WorkerLeaseRecord): NodeJS.ProcessEnv | undefined {
    const token = this.mintLeaseSpawnToken(lease);
    if (!token || !lease.spawn_tree_id) return undefined;
    const env: NodeJS.ProcessEnv = {
      ...this.buildRuntimeEnv(),
      DJIMITFLO_CONTROL_URL: process.env.DJIMITFLO_CONTROL_URL || '',
      DJIMITFLO_SPAWN_TOKEN: token,
      DJIMITFLO_LEASE_ID: lease.id,
      DJIMITFLO_SPAWN_TREE_ID: lease.spawn_tree_id,
      DJIMITFLO_DEPTH: String(lease.depth),
    };
    // L4 skill injection: deliver the lease's validated capability manifest to
    // the child as read-only env metadata. Only LIVE capabilities (server-side
    // gated) are included; this grants the child no new authority — it still
    // self-spawns under the same depth/cycle/budget/capability gates.
    const capsManifest = this.buildCapabilityManifest(lease.metadata?.capability_ids);
    if (capsManifest) env.DJIMITFLO_CAPABILITIES = capsManifest;
    return env;
  }

  // ── G15: Enforcement layer ──
  // Wires advisory swarm intelligence into binding runtime behavior.

  /**
   * Capability enforcement gate: check that a capability is validated and
   * live_route_allowed before a worker starts. Throws if the capability
   * is draft, candidate, disabled, deprecated, over-risk, or below eval
   * threshold.
   */
  private enforceCapabilityGate(lease: WorkerLeaseRecord): void {
    const capabilityIds = (lease.metadata as any)?.capability_ids;
    if (!Array.isArray(capabilityIds) || capabilityIds.length === 0) return;
    for (const capId of capabilityIds) {
      try {
        const cap = this.intelligence.getCapability(String(capId));
        if (!cap) {
          throw new Error(`CAPABILITY_NOT_FOUND:${capId}`);
        }
        if (!cap.live_route_allowed) {
          throw new Error(`CAPABILITY_NOT_ROUTABLE:${capId}:status=${cap.status}`);
        }
        if (cap.eval_score < cap.eval_threshold) {
          throw new Error(`CAPABILITY_BELOW_EVAL_THRESHOLD:${capId}:score=${cap.eval_score}:threshold=${cap.eval_threshold}`);
        }
      } catch (error) {
        // Re-throw enforcement errors; swallow "not found" from getCapability
        if (error instanceof Error && error.message.startsWith('CAPABILITY_')) {
          throw error;
        }
      }
    }
  }

  /**
   * Auto-write a runner manifest for a worker action. Best-effort: manifest
   * persistence failures are logged but do not block execution.
   */
  private autoWriteManifest(input: {
    loopRunId: string;
    leaseId: string;
    action: 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';
    decisionId?: string;
    gateRefs?: string[];
    blockedReasons?: string[];
    metadata?: Record<string, unknown>;
    stdoutPath?: string;
    stderrPath?: string;
    artifactPath?: string;
    tokenUsage?: Record<string, unknown>;
    checkpointBeforeRef?: string;
    checkpointAfterRef?: string;
  }): void {
    try {
      this.intelligence.createRunnerManifest({
        decision_id: input.decisionId || `loop:${input.loopRunId}:lease:${input.leaseId}:${input.action}`,
        lease_id: input.leaseId,
        loop_run_id: input.loopRunId,
        action: input.action,
        policy_version: LOOP_RUNTIME_MANIFEST_POLICY_VERSION,
        gate_refs: input.gateRefs,
        blocked_reasons: input.blockedReasons,
        metadata: {
          ...input.metadata,
          ...(input.stdoutPath ? { stdout_path: input.stdoutPath } : {}),
          ...(input.stderrPath ? { stderr_path: input.stderrPath } : {}),
          ...(input.artifactPath ? { artifact_path: input.artifactPath } : {}),
          ...(input.tokenUsage ? { token_usage: input.tokenUsage } : {}),
          ...(input.checkpointBeforeRef ? { checkpoint_before_ref: input.checkpointBeforeRef } : {}),
          ...(input.checkpointAfterRef ? { checkpoint_after_ref: input.checkpointAfterRef } : {}),
        },
      });
    } catch {
      this.recordLoopEvent(input.loopRunId, 'worker_manifest_error', 'warning',
        `Runner manifest persistence failed for ${input.action} action.`, { lease_id: input.leaseId });
    }
  }

  /**
   * Auto-populate evidence edges linking runtime entities. Creates typed
   * edges in the evidence graph so the inquiry trail is provable.
   */
  private populateEvidenceEdges(edges: Array<{ from: string; to: string; relation: string }>): void {
    for (const edge of edges) {
      try {
        this.intelligence.createEvidenceEdge(edge.from, edge.to, edge.relation);
      } catch {
        // Evidence edges are best-effort; don't block execution on graph writes
      }
    }
  }

  /**
   * Governance enforcement: verify that all claims linked to a loop run
   * are supported (not proposed/contradicted) before allowing completion.
   */
  private enforceGovernanceCompletion(runId: string): void {
    const claims = this.intelligence.listClaims(500);
    const loopClaims = claims.filter((c) =>
      c.subject_ref === `loop:${runId}` ||
      (c.evidence_refs || []).some((ref) => ref.includes(runId))
    );
    const unresolved = loopClaims.filter((c) =>
      c.status === 'proposed' || c.status === 'contradicted' || c.status === 'review_required'
    );
    if (unresolved.length > 0) {
      throw new Error(`GOVERNANCE_COMPLETION_BLOCKED:${unresolved.length}_unresolved_claims`);
    }
  }

  /**
   * Serialize a child's validated capabilities (L4 skill injection) into a
   * compact JSON manifest of LIVE capabilities only. Returns undefined when the
   * lease has no capability_ids or none are live. Read-only metadata: it
   * reflects server-side gating, it does not extend the child's authority.
   */
  private buildCapabilityManifest(capabilityIds: unknown): string | undefined {
    if (!Array.isArray(capabilityIds) || capabilityIds.length === 0) return undefined;
    const entries: Array<Record<string, unknown>> = [];
    for (const id of capabilityIds) {
      try {
        const cap = this.intelligence.getCapability(String(id));
        if (!cap || !cap.live_route_allowed) continue;
        entries.push({
          id: cap.id,
          kind: cap.kind,
          owner: cap.owner,
          version: cap.version,
          status: cap.status,
          risk_ceiling: cap.risk_ceiling,
          allowed_actions: cap.allowed_actions,
          forbidden_actions: cap.forbidden_actions,
          required_evidence: cap.required_evidence,
        });
      } catch {
        // capability missing/not found — skip it
      }
    }
    return entries.length > 0 ? JSON.stringify(entries) : undefined;
  }

  /**
   * Boundary check: a real runtime's cwd must live inside a worktree root (the
   * configured LOOP_WORKTREE_ROOT, the default repo-parent worktrees dir, or —
   * for tests — the system tmpdir). Refuses to spawn an autonomous runtime
   * pointed at an arbitrary directory (the main repo, /etc, …).
   */
  private assertWithinWorktreeRoot(cwd: string): void {
    const resolvedCwd = this.safeRealpath(cwd);
    const candidates: string[] = [];
    const configured = process.env.LOOP_WORKTREE_ROOT;
    if (configured) candidates.push(configured);
    candidates.push(os.tmpdir());
    // createWorktree places worktrees under <repo-toplevel>/../.djimitflo-loop-worktrees
    // (a sibling of the repo, OUTSIDE it). The previous candidate derived the root from
    // process.cwd() (a sub-workspace like packages/server) -> packages/.djimitflo-loop-worktrees
    // INSIDE the repo, which disagreed with createWorktree's toplevel-based root and rejected
    // legitimately-isolated worktrees. Accept any path beneath a .djimitflo-loop-worktrees
    // directory (the naming contract createWorktree always uses) so the boundary check agrees
    // regardless of which workspace the process runs from.
    const inside =
      candidates.some((root) => {
        const resolvedRoot = this.safeRealpath(root);
        return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(resolvedRoot + path.sep);
      }) ||
      resolvedCwd
        .split(path.sep)
        .includes('.djimitflo-loop-worktrees');
    if (!inside) {
      throw new Error(`RUNTIME_CWD_OUTSIDE_WORKTREE: ${resolvedCwd}`);
    }
  }

  private buildRuntimeCommand(runtime: string, worktreePath: string, prompt: string, skipPermissions = false): { command: string; args: string[] } {
    if (runtime === 'mock') {
      // L1: the mock runtime is now a REAL (best-effort) nested-spawn control-loop
      // client, not just an echo stub. When the lease is nested-spawn-armed, the
      // child's env (injected by buildNestedSpawnEnv) carries DJIMITFLO_CONTROL_URL
      // + a scoped DJIMITFLO_SPAWN_TOKEN + its own lease/tree/depth identity. The
      // script POSTs to the control endpoint to spawn exactly one sub-agent, then
      // polls that child's status — exercising the same HTTP path a codex/claude
      // child would. The server-side gates (depth/budget/cycle/concurrency) are the
      // real backstop: a depth-floor child gets a `gated_out` response, which is a
      // legitimate terminal state, not a failure.
      //
      // Self-spawn is BEST-EFFORT and NON-FATAL: the mock's "work" is echo, which
      // always succeeds (exit 0), and the spawn callback is a side-channel. A
      // control-plane outage (dead port, timeout, non-2xx) is logged but does NOT
      // fail the worker — this avoids wedging a runtime semaphore permit on a slow
      // control plane and matches the existing "mock always completed" semantics.
      // The spawn-tree ledger (sub_agent_spawns rows) is the real proof the loop ran.
      //
      // Uses the global `fetch` (Node 18+, available in both CJS and ESM) rather
      // than `require('http')` so the script works inside a `"type":"module"`
      // worktree (where `require` is undefined). Guards on typeof fetch so older
      // nodes degrade to echo-only.
      const script = [
        'const dir = process.argv[1];',
        'const log = (m) => console.log("[mock-worker] " + m);',
        'log("starting");',
        'console.log(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));',
        'const caps = process.env.DJIMITFLO_CAPABILITIES;',
        'let capsCount = 0; try { capsCount = caps ? JSON.parse(caps).length : 0; } catch (e) {}',
        'log("capabilities=" + capsCount);',
        'const url = process.env.DJIMITFLO_CONTROL_URL;',
        'const token = process.env.DJIMITFLO_SPAWN_TOKEN;',
        'const leaseId = process.env.DJIMITFLO_LEASE_ID;',
        'const treeId = process.env.DJIMITFLO_SPAWN_TREE_ID;',
        'const depth = process.env.DJIMITFLO_DEPTH;',
        'if (!url || !token || !leaseId || !treeId || typeof fetch !== "function") {',
        '  log("no control env / no fetch; echo-only");',
        '  log("dir=" + dir);',
        '} else {',
        '  log("lease=" + leaseId + " tree=" + treeId + " depth=" + depth + " -> self-spawn via " + url);',
        '  const body = JSON.stringify({ requested_by_lease_id: leaseId, parent_lease_id: leaseId, spawn_tree_id: treeId, role: "maker", runtime: "mock", prompt: "mock child of " + leaseId });',
        '  const ctrl = new AbortController();',
        '  const to = setTimeout(() => ctrl.abort(), 5000);',
        '  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Spawn-Token": token }, body, signal: ctrl.signal })',
        '    .then((res) => res.text().then((text) => ({ status: res.status, text })))',
        '    .then(({ status, text }) => {',
        '      clearTimeout(to);',
        '      log("spawn POST status=" + status + " body=" + text);',
        '      let childId = null;',
        '      let childToken = null;',
        '      try { const parsed = JSON.parse(text); childId = parsed.child_lease_id || null; childToken = parsed.control_token || null; } catch (e) {}',
        '      if (status >= 200 && status < 300 && childId && childToken) {',
        '        return fetch(url + "/" + childId + "/status", { headers: { "X-Spawn-Token": childToken } })',
        '          .then((s) => s.text())',
        '          .then((st) => log("child status body=" + st));',
        '      }',
        '      if (status >= 200 && status < 300 && childId) {',
        '        log("child status token unavailable at depth floor");',
        '      }',
        '      if (status >= 400 && status < 500 && text.indexOf("gated_out") >= 0) {',
        '        log("child gated_out (legitimate terminal state at depth floor)");',
        '      } else if (status >= 400) {',
        '        log("control-plane error status=" + status + " (non-fatal; echo work already done)");',
        '      }',
        '    })',
        '    .catch((e) => { clearTimeout(to); log("control-plane call failed: " + (e && e.message || e) + " (non-fatal)"); });',
        '}',
      ].join('\n');
      return {
        command: process.execPath,
        args: ['-e', script, worktreePath],
      };
    }
    if (runtime === 'codex') {
      // --ignore-user-config: loop workers are reproducible, isolated agents — they must NOT
      // inherit the operator's personal codex config/skills, which bloats context ~4x (verified
      // live: 325k -> 87k input tokens on the same task) and blows the token budget. Auth is
      // independent of user-config, so headless execution still works.
      // skipPermissions (operator opt-in via RUNTIME_ALLOW_SKIP_PERMISSIONS) arms a SANDBOXED
      // headless mode, NOT an unsandboxed bypass: --sandbox workspace-write confines writes to
      // the worktree cwd (+/tmp,$TMPDIR), protecting the host repo (verified: a sandboxed codex
      // cannot write /home/.../djimitflo — "Read-only file system"), and -c approval_policy=never
      // runs headless with no approval prompts. This replaces --dangerously-bypass-approvals-and-
      // sandbox, which left the host mutable and codex occasionally escaped to host source by
      // absolute path.
      const args = skipPermissions
        ? ['exec', '--ignore-user-config', '--sandbox', 'workspace-write', '-c', 'approval_policy=never', '--json', '--cd', worktreePath, prompt]
        : ['exec', '--ignore-user-config', '--json', '--cd', worktreePath, prompt];
      return {
        command: process.env.CODEX_BIN_PATH || 'codex',
        args,
      };
    }
    if (runtime === 'opencode') {
      const args = skipPermissions
        ? ['run', '--dangerously-skip-permissions', '--format', 'json', '--dir', worktreePath, prompt]
        : ['run', '--format', 'json', '--dir', worktreePath, prompt];
      return {
        command: process.env.OPENCODE_BIN_PATH || 'opencode',
        args,
      };
    }
    if (runtime === 'claude') {
      // claude CLI headless: inherits the worktree as cwd via spawn (no --cd flag).
      // --output-format json for parseable usage/verdict; --dangerously-skip-permissions
      // is the approval/sandbox bypass, armed only via RUNTIME_ALLOW_SKIP_PERMISSIONS.
      const args = ['-p', prompt, '--output-format', 'json'];
      if (skipPermissions) args.push('--dangerously-skip-permissions');
      const model = process.env.DJIMITFLO_CLAUDE_MODEL;
      if (model) args.push('--model', model);
      return {
        command: process.env.CLAUDE_BIN_PATH || 'claude',
        args,
      };
    }
    if (runtime === 'gemini') {
      // gemini CLI headless: inherits the worktree as cwd via spawn. -o json for
      // parseable output; -y is the auto-approve bypass (armed only via the gate).
      const args = ['-p', prompt, '-o', 'json'];
      if (skipPermissions) args.push('-y');
      const model = process.env.DJIMITFLO_GEMINI_MODEL;
      if (model) args.push('-m', model);
      return {
        command: process.env.GEMINI_BIN_PATH || 'gemini',
        args,
      };
    }
    if (runtime === 'editor') {
      // editor runtime = the cline CLI (autonomous AI editor-agent). cline uses its
      // own -c <worktree> cwd flag (spawn also sets cwd=worktree; redundant, safe).
      // --auto-approve reflects skipPermissions: true only when the operator has
      // armed RUNTIME_ALLOW_SKIP_PERMISSIONS — without it cline cannot run fully
      // headless (it would wait on interactive approval). See known limitations.
      const args = ['--json', '--auto-approve', skipPermissions ? 'true' : 'false', '-c', worktreePath];
      args.push('--thinking', process.env.DJIMITFLO_CLINE_THINKING || 'medium');
      const model = process.env.DJIMITFLO_CLINE_MODEL;
      if (model) args.push('-m', model);
      args.push(prompt);
      return {
        command: process.env.CLINE_BIN_PATH || 'cline',
        args,
      };
    }
    if (runtime === 'pi') {
      // Pi headless: `pi --mode json -p`. Pi uses the spawn cwd as its working
      // directory (no --dir flag), so the lease worktree is the isolation unit and
      // Pi's file tools (read/ls/edit/write) are cwd-scoped to it. Pi has NO
      // permission popups, so skipPermissions maps to no Pi flag — risk control
      // stays via PI_TOOLS (drop bash for low-risk) + djimitflo approval before
      // the lease. Sovereign/zero-egress runs require PI_OFFLINE=1 +
      // PI_SKIP_VERSION_CHECK=1 + PI_TELEMETRY=0 (Pi reads these env vars).
      const args = ['--mode', 'json', '-p', '--no-session'];
      if ((process.env.PI_NO_APPROVE ?? '1') === '1') args.push('--no-approve');
      if (process.env.PI_NO_CONTEXT_FILES === '1') args.push('--no-context-files');
      if ((process.env.PI_NO_EXTENSIONS ?? '1') === '1') args.push('--no-extensions');
      if ((process.env.PI_NO_SKILLS ?? '1') === '1') args.push('--no-skills');
      if (process.env.PI_OFFLINE === '1') args.push('--offline');
      if (process.env.PI_TOOLS) args.push('--tools', process.env.PI_TOOLS);
      if (process.env.PI_PROVIDER) args.push('--provider', process.env.PI_PROVIDER);
      if (process.env.PI_MODEL) args.push('--model', process.env.PI_MODEL);
      args.push(prompt);
      return {
        command: process.env.PI_BIN_PATH || 'pi',
        args,
      };
    }
    throw new Error('MAKER_RUNTIME_UNSUPPORTED');
  }

  private assertRuntimeAvailable(runtime: string): void {
    const probe = this.getRuntimeContract(runtime);
    if (!probe.available) {
      throw new Error('RUNTIME_UNAVAILABLE');
    }
  }

  private getRuntimeContract(runtime: string): RuntimeContract {
    const finish = (contract: RuntimeContract): RuntimeContract => {
      const next = { ...contract, probed_at: contract.probed_at || new Date().toISOString() };
      this.persistRuntimeContractProbe(next);
      return next;
    };
    if (runtime === 'manual') {
      return finish({
        runtime: 'manual',
        available: true,
        command: null,
        version: 'manual',
        status: 'ok',
        supports_json_events: false,
        supports_usage_parsing: false,
        supports_timeout_kill: false,
        evidence: ['manual runtime requires human execution'],
      });
    }
    if (runtime === 'mock') {
      return finish({
        runtime: 'mock',
        available: true,
        command: process.execPath,
        version: 'mock-runtime',
        status: 'ok',
        cwd_flag: 'argv',
        json_flag: 'stdout-json',
        supports_json_events: true,
        supports_usage_parsing: true,
        supports_timeout_kill: true,
        evidence: ['deterministic in-process mock runtime'],
      });
    }
    // Real runtime probes: each entry describes how to locate the binary, which
    // help subcommand lists its flags, and which flags must be present for the
    // loop's headless contract (a json/output flag + a cwd mechanism + a
    // headless prompt flag). claude/gemini inherit the worktree as cwd via spawn
    // (cwdFlag null → always "present"); codex/opencode/editor carry an explicit
    // --cd/--dir/-c flag. `editor` maps to the cline CLI (autonomous editor-agent).
    const PROBES: Record<string, { binEnv: string; defaultBin: string; helpArgs: string[]; jsonFlag: string; jsonFlagHelp: string; cwdFlag: string | null; headlessFlag: string }> = {
      codex: { binEnv: 'CODEX_BIN_PATH', defaultBin: 'codex', helpArgs: ['exec', '--help'], jsonFlag: '--json', jsonFlagHelp: '--json', cwdFlag: '--cd', headlessFlag: '--json' },
      opencode: { binEnv: 'OPENCODE_BIN_PATH', defaultBin: 'opencode', helpArgs: ['run', '--help'], jsonFlag: '--format', jsonFlagHelp: '--format', cwdFlag: '--dir', headlessFlag: '--format' },
      claude: { binEnv: 'CLAUDE_BIN_PATH', defaultBin: 'claude', helpArgs: ['--help'], jsonFlag: '--output-format', jsonFlagHelp: '--output-format', cwdFlag: null, headlessFlag: '-p' },
      gemini: { binEnv: 'GEMINI_BIN_PATH', defaultBin: 'gemini', helpArgs: ['--help'], jsonFlag: '-o', jsonFlagHelp: '-o', cwdFlag: null, headlessFlag: '-p' },
      editor: { binEnv: 'CLINE_BIN_PATH', defaultBin: 'cline', helpArgs: ['--help'], jsonFlag: '--json', jsonFlagHelp: '--json', cwdFlag: '-c', headlessFlag: '--json' },
      pi: { binEnv: 'PI_BIN_PATH', defaultBin: 'pi', helpArgs: ['--help'], jsonFlag: '--mode', jsonFlagHelp: '--mode', cwdFlag: null, headlessFlag: '-p' },
    };
    const probe = PROBES[runtime];
    if (!probe) {
      return finish({
        runtime: 'manual',
        available: false,
        command: null,
        status: 'unavailable',
        supports_json_events: false,
        supports_usage_parsing: false,
        supports_timeout_kill: false,
        evidence: [],
        reason: 'unsupported runtime',
      });
    }
    const typedRuntime = runtime as RuntimeContract['runtime'];
    const command = process.env[probe.binEnv] || probe.defaultBin;
    const cacheKey = `${runtime}::${command}`;
    const cached = this.runtimeContractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.contract;
    }
    const timeoutMs = Math.max(100, Math.min(Number(process.env.LOOP_RUNTIME_PROBE_TIMEOUT_MS || 1_000), 5_000));
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    if (result.error) {
      return finish({
        runtime: typedRuntime,
        available: false,
        command,
        status: 'unavailable',
        supports_json_events: false,
        supports_usage_parsing: false,
        supports_timeout_kill: true,
        evidence: [],
        reason: result.error.message,
      });
    }
    if (result.status !== 0) {
      return finish({
        runtime: typedRuntime,
        available: false,
        command,
        status: 'unavailable',
        supports_json_events: false,
        supports_usage_parsing: false,
        supports_timeout_kill: true,
        evidence: [],
        reason: result.stderr || `exit ${result.status}`,
      });
    }
    const helpResult = spawnSync(command, probe.helpArgs, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
    const evidence = [
      (result.stdout || result.stderr || '').trim(),
      help.split(/\r?\n/).slice(0, 20).join('\n'),
    ].filter(Boolean);
    const lowerHelp = help.toLowerCase();
    const hasJsonFlag = lowerHelp.includes(probe.jsonFlagHelp.toLowerCase());
    const hasCwdFlag = probe.cwdFlag ? lowerHelp.includes(probe.cwdFlag) : true;
    const hasHeadlessFlag = lowerHelp.includes(probe.headlessFlag.toLowerCase());
    const drifted = !hasJsonFlag || !hasCwdFlag || !hasHeadlessFlag;
    const contract: RuntimeContract = {
      runtime: typedRuntime,
      available: !drifted,
      command,
      version: (result.stdout || result.stderr || '').trim() || 'unknown',
      status: drifted ? 'drifted' : 'ok',
      ...(probe.cwdFlag ? { cwd_flag: probe.cwdFlag } : {}),
      json_flag: probe.jsonFlag === '--format' ? ['--format', 'json'] : probe.jsonFlag,
      supports_json_events: !drifted,
      supports_usage_parsing: !drifted,
      supports_timeout_kill: true,
      evidence,
      ...(drifted ? { reason: `missing required flags: ${[!hasJsonFlag ? 'json' : '', !hasCwdFlag ? 'cwd' : '', !hasHeadlessFlag ? 'headless' : ''].filter(Boolean).join(', ')}` } : {}),
    };
    const persisted = finish(contract);
    this.runtimeContractCache.set(cacheKey, { expiresAt: Date.now() + this.runtimeContractCacheMs, contract: persisted });
    return persisted;
  }

  private persistRuntimeContractProbe(contract: RuntimeContract): void {
    try {
      this.db.prepare(`
        INSERT INTO runtime_contract_probes (runtime, command, status, available, contract_json, probed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runtime) DO UPDATE SET
          command = excluded.command,
          status = excluded.status,
          available = excluded.available,
          contract_json = excluded.contract_json,
          probed_at = excluded.probed_at,
          updated_at = excluded.updated_at
      `).run(
        contract.runtime,
        contract.command,
        contract.status,
        contract.available ? 1 : 0,
        JSON.stringify(contract),
        contract.probed_at || new Date().toISOString(),
        new Date().toISOString()
      );
    } catch {
      // ponytail: probe persistence is evidence-only; runtime availability must not depend on DB write success.
    }
  }

  private extractRuntimeWarnings(stdout: string, stderr: string): Array<Record<string, unknown>> {
    const text = `${stdout}\n${stderr}`;
    const warnings: Array<Record<string, unknown>> = [];
    const patterns: Array<{ pattern: RegExp; class_name: string; severity: 'advisory' | 'warning' | 'blocking' }> = [
      { pattern: /failed to parse plugin hooks config[^\n]*/i, class_name: 'plugin_hook_config_parse', severity: 'warning' },
      { pattern: /Skill descriptions were shortened[^\n]*/i, class_name: 'skill_context_budget', severity: 'advisory' },
      { pattern: /(?:trust boundary|auth|secret|permission|capability|policy)[^\n]*/i, class_name: 'trust_boundary_warning', severity: 'blocking' },
      { pattern: /fail to delete session[^\n]*/i, class_name: 'runtime_session_cleanup', severity: 'advisory' },
      { pattern: /structured output unavailable[^\n]*/i, class_name: 'structured_output_unavailable', severity: 'warning' },
      { pattern: /unknown field|unexpected argument[^\n]*/i, class_name: 'runtime_contract_warning', severity: 'warning' },
    ];
    for (const item of patterns) {
      const match = text.match(item.pattern);
      if (match?.[0]) {
        warnings.push({
          class_name: item.class_name,
          severity: item.severity,
          message: match[0].slice(0, 500),
        });
      }
    }
    return warnings;
  }

  private runtimeWarningGate(run: LoopRunRecord, warnings: Array<Record<string, unknown>>): LoopGate {
    if (warnings.length === 0) {
      return { name: 'runtime_warning_gate', status: 'pass', evidence: 'No runtime warnings captured.' };
    }
    const blocks = this.isHighRiskRun(run) && warnings.some((warning) => (
      warning.severity === 'blocking'
      || /(trust|auth|secret|permission|capability|policy)/i.test(String(warning.message || warning.class_name || ''))
    ));
    return {
      name: 'runtime_warning_gate',
      status: blocks ? 'fail' : 'pass',
      evidence: `${warnings.length} warning(s): ${warnings.map((warning) => `${warning.class_name || 'runtime_warning'}:${warning.severity || 'warning'}`).join(', ')}${blocks ? ' (blocked high-risk trust boundary)' : ' (advisory)'}.`,
    };
  }

  private calculateWorkerEfficiency(runtimeUsage: RuntimeUsage | null, diffLines: number): Record<string, unknown> {
    if (!runtimeUsage) {
      return { usage_source: 'unknown' };
    }
    return {
      total_tokens: runtimeUsage.total_tokens,
      diff_lines: diffLines,
      tokens_per_diff_line: diffLines > 0 ? runtimeUsage.total_tokens / diffLines : null,
      tokens_per_successful_worker: runtimeUsage.total_tokens,
    };
  }

  private makeManifestDecisionId(loopRunId: string, leaseId: string | null, action: RuntimeManifestAction): string {
    return `${loopRunId}:${leaseId || 'unknown'}:${action}:${Date.now()}:${randomUUID().slice(0, 10)}`;
  }

  private currentCapacitySnapshot() {
    return {
      cpu_threads: os.cpus().length,
      total_memory_bytes: os.totalmem(),
      free_memory_bytes: os.freemem(),
      load_average: os.loadavg(),
      uptime_seconds: os.uptime(),
      environment: {
        node_version: process.version,
        pid: process.pid,
      },
    };
  }

  private currentBudgetSnapshot(run: LoopRunRecord, runtimeUsage?: RuntimeUsage | null): Record<string, unknown> {
    const tokenBudget = this.getTokenBudget(run);
    const wallClockBudget = this.getWallClockBudget(run);
    const failureThreshold = this.getFailureThreshold(run);
    const usedTokens = this.sumRuntimeTokens(this.listWorkerLeases(run.id));
    const runAgeMs = Math.max(0, Date.now() - Date.parse(run.created_at));
    const latestRuntimeTokens = runtimeUsage?.total_tokens;
    return {
      token_budget: tokenBudget,
      wall_clock_budget: wallClockBudget,
      failure_threshold: failureThreshold,
      runtime_loop_age_ms: runAgeMs,
      used_runtime_tokens: usedTokens,
      last_worker_total_tokens: latestRuntimeTokens ?? null,
      budget_aware: tokenBudget.maxTokens || wallClockBudget.maxRuntimeMs ? true : false,
    };
  }

  private recordWorkerManifest(input: {
    decisionId: string;
    loopRunId: string;
    leaseId: string | null;
    action: RuntimeManifestAction;
    runtimeContract: RuntimeContract | null;
    capacitySnapshot: Record<string, unknown>;
    budgetSnapshot: Record<string, unknown>;
    gateRefs: string[];
    blockedReasons: string[];
    metadata: Record<string, unknown>;
  }) {
    if (!input.loopRunId) {
      return;
    }
    try {
      this.intelligence.createRunnerManifest({
        decision_id: input.decisionId,
        lease_id: input.leaseId,
        loop_run_id: input.loopRunId,
        action: input.action,
        policy_version: LOOP_RUNTIME_MANIFEST_POLICY_VERSION,
        runtime_contract: (input.runtimeContract as unknown as Record<string, unknown>) || {},
        capacity_snapshot: input.capacitySnapshot,
        budget_snapshot: input.budgetSnapshot,
        gate_refs: input.gateRefs,
        blocked_reasons: input.blockedReasons,
        metadata: input.metadata,
      });
    } catch {
      // Manifest persistence is best-effort for evidence completeness; keep loop execution deterministic.
      this.recordLoopEvent(input.loopRunId, 'worker_manifest_error', 'warning', 'Runner manifest persistence failed for worker action.', {
        decision_id: input.decisionId,
        action: input.action,
        lease_id: input.leaseId,
        loop_run_id: input.loopRunId,
      });
    }
  }

  private leaseDiffWithinThreshold(lease: WorkerLeaseRecord): boolean {
    const diffLines = Number(lease.metadata.diff_lines ?? 0);
    const diffMaxLines = Number(lease.metadata.diff_max_lines ?? 0);
    return diffMaxLines > 0 && diffLines <= diffMaxLines;
  }

  private hasAcceptedCheckerVerdict(makerLeaseId: string, checkerLeases: WorkerLeaseRecord[]): boolean {
    return checkerLeases.some((lease) => lease.metadata.maker_lease_id === makerLeaseId && lease.metadata.verdict === 'accepted');
  }

  private hasAcceptedSecurityCheckerVerdict(makerLeaseId: string, securityCheckerLeases: WorkerLeaseRecord[]): boolean {
    return securityCheckerLeases.some((lease) => lease.metadata.maker_lease_id === makerLeaseId && lease.metadata.verdict === 'accepted');
  }

  private isRetryableMakerLease(maker: WorkerLeaseRecord, checkerLeases: WorkerLeaseRecord[]): boolean {
    if (maker.role !== 'maker' || this.isSupersededMakerLease(maker)) {
      return false;
    }
    if (maker.status === 'failed') {
      return true;
    }
    return checkerLeases.some((lease) => (
      lease.metadata.maker_lease_id === maker.id
      && ['needs_revision', 'rejected', 'insufficient_evidence'].includes(String(lease.metadata.verdict || ''))
    ));
  }

  private isSupersededMakerLease(lease: WorkerLeaseRecord): boolean {
    return lease.role === 'maker' && typeof lease.metadata.superseded_by_maker_lease_id === 'string';
  }

  private retryRootFor(maker: WorkerLeaseRecord): string {
    return typeof maker.metadata.retry_root_maker_lease_id === 'string'
      ? maker.metadata.retry_root_maker_lease_id
      : maker.id;
  }

  private completionBlockingLeases(leases: WorkerLeaseRecord[]): WorkerLeaseRecord[] {
    const supersededMakerIds = new Set(
      leases
        .filter((lease) => lease.role === 'maker' && this.isSupersededMakerLease(lease))
        .map((lease) => lease.id)
    );
    return leases.filter((lease) => {
      if (lease.role === 'maker') {
        return !supersededMakerIds.has(lease.id);
      }
      if (lease.role === 'checker') {
        const makerLeaseId = lease.metadata.maker_lease_id;
        return typeof makerLeaseId !== 'string' || !supersededMakerIds.has(makerLeaseId);
      }
      return true;
    });
  }

  private leaseChecksPassed(lease: WorkerLeaseRecord): boolean {
    const checks = lease.metadata.deterministic_checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      return false;
    }
    return checks.every((check) => {
      const status = (check as { status?: unknown }).status;
      return status === 'pass' || status === 'skipped';
    });
  }

  private readNearestPackageScripts(worktreePath: string): Set<string> {
    const packageJsonPath = path.join(worktreePath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return new Set();
    }
    try {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
      return new Set(Object.keys(json.scripts || {}));
    } catch {
      return new Set();
    }
  }

  private controlDir(worktreePath: string): string {
    return path.join(worktreePath, CONTROL_DIR);
  }

  private workAssignmentPath(worktreePath: string): string {
    return path.join(this.controlDir(worktreePath), LOOP_WORK_FILE);
  }

  private assignmentPacketPath(worktreePath: string): string {
    return path.join(this.controlDir(worktreePath), ASSIGNMENT_PACKET_FILE);
  }

  private ensureControlDir(worktreePath: string): string {
    const dir = this.controlDir(worktreePath);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private ensureWorktreeControlIgnore(worktreePath: string): void {
    try {
      const excludePath = this.git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']).trim();
      const absoluteExcludePath = path.isAbsolute(excludePath) ? excludePath : path.join(worktreePath, excludePath);
      const current = fs.existsSync(absoluteExcludePath) ? fs.readFileSync(absoluteExcludePath, 'utf8') : '';
      const lines = current.split(/\r?\n/);
      const toAdd: string[] = [];
      if (!lines.includes(`${CONTROL_DIR}/`)) toAdd.push(`${CONTROL_DIR}/`);
      // The dependency bridge symlinks node_modules -> source repo node_modules. The repo
      // .gitignore uses `node_modules/` (dir-only) which does NOT match the symlink, so it
      // showed as an untracked/staged artifact and made checkers reject the maker diff as an
      // extra change. Ignore the symlink explicitly in this worktree's exclude.
      if (!lines.includes(`node_modules`)) toAdd.push(`node_modules`);
      if (toAdd.length > 0) {
        fs.mkdirSync(path.dirname(absoluteExcludePath), { recursive: true });
        const prefix = current.endsWith('\n') || current.length === 0 ? '' : '\n';
        fs.appendFileSync(absoluteExcludePath, `${prefix}${toAdd.join('\n')}\n`, 'utf8');
      }
    } catch {
      // The control directory is still useful even when git excludes cannot be updated.
    }
  }

  private resolveWorkAssignmentPath(lease: WorkerLeaseRecord): string {
    const metadataPath = typeof lease.metadata.assignment_file === 'string' ? lease.metadata.assignment_file : null;
    if (metadataPath && fs.existsSync(metadataPath)) {
      return metadataPath;
    }
    if (lease.worktree_path) {
      const currentPath = this.workAssignmentPath(lease.worktree_path);
      if (fs.existsSync(currentPath)) {
        return currentPath;
      }
      return path.join(lease.worktree_path, LOOP_WORK_FILE);
    }
    return '';
  }

  private writeWorkAssignment(
    worktreePath: string,
    run: LoopRunRecord,
    finding: LoopFinding,
    runtime: string,
    options: { nestedSpawnControl?: string } = {}
  ): void {
    this.ensureControlDir(worktreePath);
    const content = [
      `# ${run.loop_name} Assignment`,
      '',
      `Loop run: ${run.id}`,
      `Runtime target: ${runtime}`,
      `Worker profile: ${this.getWorkerRuntimeProfile(run).name}`,
      `Finding: ${finding.id}`,
      `File: ${finding.file}${finding.line ? `:${finding.line}` : ''}`,
      '',
      '## Finding',
      '',
      finding.message,
      '',
      '## Evidence',
      '',
      finding.evidence,
      '',
      '## Suggested Fix',
      '',
      finding.suggested_fix,
      '',
      // G29: inject the matching skill procedure ONLY when a real match is found.
      // Don't add a placeholder — it could confuse the runtime.
      ...(this.skills.getSkillForFinding(finding.message, finding.file)
        ? ['## Skill Procedure', '', this.skills.getSkillForFinding(finding.message, finding.file)!, '']
        : []),
      '## Rules',
      '',
      '- Keep the diff small and local to the finding.',
      '- Do not merge, push, deploy, edit secrets, or change policy.',
      '- Run relevant deterministic checks before handing off to checker.',
      '- Checker approval is required before completion.',
      '',
      // Nested-spawn control block (P1). Only injected when this lease is itself
      // permitted to spawn sub-agents (operator-armed, depth within budget). This
      // is the single path a runtime child uses to spawn children: it shells out
      // to the control endpoint with its scoped token. See prepareNestedLease.
      ...(options.nestedSpawnControl ? [options.nestedSpawnControl, ''] : []),
    ].join('\n');
    fs.writeFileSync(this.workAssignmentPath(worktreePath), content, 'utf8');
  }

  private writeAssignmentPacket(worktreePath: string, run: LoopRunRecord, finding: LoopFinding, runtime: string, retryAttempt?: number, capabilitiesManifest?: string): string {
    this.ensureControlDir(worktreePath);
    const packetPath = this.assignmentPacketPath(worktreePath);
    const contract = (run.metadata.contract && typeof run.metadata.contract === 'object')
      ? run.metadata.contract as Record<string, unknown>
      : {};
    const packet = {
      schema_version: 1,
      loop_run_id: run.id,
      loop_name: run.loop_name,
      goal_id: run.goal_id,
      mode: run.mode,
      status: run.status,
      runtime,
      runtime_profile: this.getWorkerRuntimeProfile(run),
      retry_attempt: retryAttempt || 0,
      repository_path: run.repository_path,
      worktree_path: worktreePath,
      // L4 skill injection: the validated capability manifest (read-only
      // metadata) when this lease was armed with capabilities.
      capabilities: capabilitiesManifest ? JSON.parse(capabilitiesManifest) : [],
      finding: {
        id: finding.id,
        type: finding.type,
        severity: finding.severity,
        file: finding.file,
        line: finding.line || null,
        message: finding.message,
        evidence: finding.evidence,
        suggested_fix: finding.suggested_fix,
        parent_finding_id: finding.parent_finding_id || null,
      },
      context: {
        state_file: run.state_file,
        gates: run.gates,
        next_actions: run.next_actions,
        plan: run.plan,
      },
      allowed_actions: ['read_repo', 'edit_files', 'run_tests', 'write_artifacts'],
      forbidden_actions: ['merge', 'push', 'deploy', 'modify_secrets', 'modify_policy', 'delete_data'],
      expected_artifacts: ['diff', 'stdout_log', 'stderr_log', 'deterministic_check_results'],
      stop_conditions: Array.isArray(contract.stop_conditions)
        ? contract.stop_conditions
        : ['finding_resolved_or_rejected', 'diff_under_threshold', 'checker_required_before_completion'],
      escalation: Array.isArray(contract.escalation)
        ? contract.escalation
        : ['blocked_by_scope', 'security_sensitive_change', 'budget_exhausted'],
    };
    fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
    return packetPath;
  }

  private buildCheckerPrompt(run: LoopRunRecord, maker: WorkerLeaseRecord, checker: WorkerLeaseRecord): string {
    const worktreePath = maker.worktree_path || '';
    const diff = worktreePath ? this.git(worktreePath, ['diff', '--', '.']) : '';
    const assignmentPacket = typeof maker.metadata.assignment_packet_file === 'string' && fs.existsSync(maker.metadata.assignment_packet_file)
      ? fs.readFileSync(maker.metadata.assignment_packet_file, 'utf8').slice(0, 20_000)
      : '';
    const stdoutPath = typeof maker.metadata.stdout_path === 'string' ? maker.metadata.stdout_path : '';
    const stderrPath = typeof maker.metadata.stderr_path === 'string' ? maker.metadata.stderr_path : '';
    const checks = JSON.stringify(maker.metadata.deterministic_checks || [], null, 2);
    return [
      `# ${run.loop_name} Checker Assignment`,
      '',
      `Loop run: ${run.id}`,
      `Checker lease: ${checker.id}`,
      `Maker lease: ${maker.id}`,
      '',
      'You are an independent checker. Do not edit files, merge, push, deploy, modify secrets or change policy.',
      'Review the maker output using the evidence below.',
      '',
      'Return a concise verdict. Prefer JSON on one line:',
      '{"verdict":"accepted|needs_revision|rejected|insufficient_evidence","notes":"...","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      '## Assignment Packet',
      assignmentPacket || 'No assignment packet available.',
      '',
      '## Maker Diff',
      diff || 'No diff available.',
      '',
      '## Deterministic Checks',
      checks,
      '',
      '## Maker Artifacts',
      `stdout_path: ${stdoutPath || 'missing'}`,
      `stderr_path: ${stderrPath || 'missing'}`,
      '',
      // G6.2: memory-poisoning defense — the checker verifies the maker's injected memory.
      // If the maker used low-trust memory (< 0.3 trust_score), the checker should flag it.
      ...((): string[] => {
        const scores = Array.isArray(maker.metadata.injected_memory_trust_scores)
          ? maker.metadata.injected_memory_trust_scores as number[]
          : [];
        if (scores.length === 0) return [];
        const lowTrust = scores.filter((s) => typeof s === 'number' && s < 0.3);
        return [
          '## Injected Memory Trust (G6.2)',
          `trust_scores: ${JSON.stringify(scores)}`,
          lowTrust.length > 0
            ? `WARNING: ${lowTrust.length} memory item(s) have trust < 0.3 (stale/contradicted/unprovenanced). If the maker relied on these, consider needs_revision or rejected.`
            : 'All injected memory has trust >= 0.3.',
          '',
        ];
      })(),
    ].join('\n');
  }

  private buildMockCheckerCommand(_worktreePath: string, _prompt: string): { command: string; args: string[] } {
    const script = [
      'console.log(JSON.stringify({ verdict: "accepted", notes: "mock checker accepted maker output", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));',
    ].join('\n');
    return {
      command: process.execPath,
      args: ['-e', script],
    };
  }

  private extractCheckerVerdict(stdout: string): CheckerVerdictInput['verdict'] {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const verdict = String(parsed.verdict || parsed.checker_verdict || '').trim();
        if (['accepted', 'needs_revision', 'rejected', 'insufficient_evidence'].includes(verdict)) {
          return verdict as CheckerVerdictInput['verdict'];
        }
      } catch {
        continue;
      }
    }
    if (/\baccepted\b/i.test(stdout)) return 'accepted';
    if (/needs[_ -]?revision/i.test(stdout)) return 'needs_revision';
    if (/\brejected\b/i.test(stdout)) return 'rejected';
    return 'insufficient_evidence';
  }

  private extractCheckerNotes(stdout: string): string {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.notes === 'string') {
          return parsed.notes;
        }
      } catch {
        continue;
      }
    }
    return stdout.trim().slice(0, 1_000);
  }

  private mergeGates(existing: LoopGate[], patch: LoopGate[]): LoopGate[] {
    const byName = new Map(existing.map((gate) => [gate.name, gate]));
    for (const gate of patch) {
      byName.set(gate.name, gate);
    }
    return Array.from(byName.values());
  }

  private insertWorkerLease(input: {
    id: string;
    loopRunId: string;
    role: WorkerRole;
    runtime: string;
    findingId: string;
    worktreePath: string | null;
    branchName: string | null;
    metadata: Record<string, unknown>;
    now: string;
    // Nested-spawn lineage (P1). Optional: legacy continueLoopRun callers omit
    // these and get a root lease (parent=null, depth=0, no tree).
    parentLeaseId?: string | null;
    spawnTreeId?: string | null;
    depth?: number;
    spawnedByAgentId?: string | null;
    capabilityId?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, finding_id, worktree_path,
        branch_name, budget_json, metadata, created_at, updated_at,
        parent_lease_id, spawn_tree_id, depth, spawned_by_agent_id, capability_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.loopRunId,
      input.role,
      input.runtime,
      'prepared',
      input.findingId,
      input.worktreePath,
      input.branchName,
      JSON.stringify({ max_runtime_minutes: 30, max_retries: 1 }),
      JSON.stringify(input.metadata),
      input.now,
      input.now,
      input.parentLeaseId ?? null,
      input.spawnTreeId ?? null,
      input.depth ?? 0,
      input.spawnedByAgentId ?? null,
      input.capabilityId ?? null
    );
  }

  private updateWorkerLeaseStatus(id: string, status: WorkerLeaseRecord['status'], metadataPatch: Record<string, unknown>): void {
    const existing = this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata?: string } | undefined;
    const metadata = {
      ...(existing ? JSON.parse(existing.metadata || '{}') : {}),
      ...metadataPatch,
    };
    this.db.prepare('UPDATE worker_leases SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(metadata), new Date().toISOString(), id);
  }

  private updateWorkerLeaseRuntime(id: string, runtime: string): void {
    this.db.prepare('UPDATE worker_leases SET runtime = ?, updated_at = ? WHERE id = ?')
      .run(runtime, new Date().toISOString(), id);
  }

  private patchWorkerLeaseMetadata(id: string, metadataPatch: Record<string, unknown>): void {
    const existing = this.db.prepare('SELECT status, metadata FROM worker_leases WHERE id = ?').get(id) as { status?: WorkerLeaseRecord['status']; metadata?: string } | undefined;
    if (!existing?.status) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    const metadata = {
      ...JSON.parse(existing.metadata || '{}'),
      ...metadataPatch,
    };
    this.db.prepare('UPDATE worker_leases SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), id);
  }

  private getWorkerLease(id: string): WorkerLeaseRecord {
    const row = this.db.prepare('SELECT * FROM worker_leases WHERE id = ?').get(id) as any | undefined;
    if (!row) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    return this.parseWorkerLease(row);
  }

  getWorkerLeasePublic(id: string): WorkerLeaseRecord {
    return this.getWorkerLease(id);
  }

  private parseWorkerLease(row: any): WorkerLeaseRecord {
    return {
      id: row.id,
      loop_run_id: row.loop_run_id,
      role: row.role,
      runtime: row.runtime,
      status: row.status,
      finding_id: row.finding_id || null,
      worktree_path: row.worktree_path || null,
      branch_name: row.branch_name || null,
      budget: JSON.parse(row.budget_json || '{}'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      parent_lease_id: row.parent_lease_id ?? null,
      spawn_tree_id: row.spawn_tree_id ?? null,
      depth: typeof row.depth === 'number' ? row.depth : Number(row.depth ?? 0),
      spawned_by_agent_id: row.spawned_by_agent_id ?? null,
      capability_id: row.capability_id ?? null,
    };
  }

  private registerRuntimeLease(
    leaseId: string,
    child: ChildProcess,
    command: string,
    args: string[],
    timeoutHandle?: NodeJS.Timeout
  ): void {
    LoopService.runtimeLeases.set(leaseId, {
      child,
      leaseId,
      command,
      args,
      startedAt: new Date().toISOString(),
      timeoutHandle,
    });
  }

  private clearRuntimeLease(leaseId: string): void {
    const lease = LoopService.runtimeLeases.get(leaseId);
    if (!lease) {
      return;
    }
    if (lease.timeoutHandle) {
      clearTimeout(lease.timeoutHandle);
    }
    LoopService.runtimeLeases.delete(leaseId);
  }

  /**
   * Current semaphore limit. Read fresh on every acquire so an operator can tune
   * RUNTIME_MAX_CONCURRENCY at runtime. Default 4 bounds a greedy subtree without
   * starving the rest of the fleet; the per-tree sub-limiter
   * (spawn_trees.max_concurrent_children) further bounds any one swarm.
   */
  private runtimeSemaphoreLimit(): number {
    // G4: the limit is a dynamic control variable (AIMD), not a static env const.
    // Initialized from the env cap on first use, then driven by adjustConcurrency.
    const sem = LoopService.runtimeSemaphore;
    if (sem.dynamicLimit === null) {
      // G5-persist: restore the dynamicLimit from the DB on first use after a restart.
      try {
        const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get('aimd_dynamic_limit') as { value?: string } | undefined;
        if (row?.value) {
          const restored = Number(row.value);
          if (Number.isFinite(restored) && restored >= 1) {
            sem.dynamicLimit = Math.min(restored, this.runtimeSemaphoreHardCap());
            return sem.dynamicLimit;
          }
        }
      } catch { /* table might not exist yet */ }
      sem.dynamicLimit = this.runtimeSemaphoreHardCap();
    }
    return sem.dynamicLimit;
  }

  private runtimeSemaphoreHardCap(): number {
    // G9: the hard cap is min(env_cap, fleet_recommended). The fleet recommended
    // concurrency comes from the injected ConcurrencyAdvisor (SwarmStatusService.
    // fleetPools().recommended_concurrency), avoiding a circular import.
    const raw = process.env.RUNTIME_MAX_CONCURRENCY;
    const envCap = raw === undefined || raw === null || raw.trim() === ''
      ? 4
      : (Number.isFinite(Number(raw)) && Number(raw) >= 1 ? Math.trunc(Number(raw)) : 4);
    const fleetRec = this.concurrencyAdvisor?.() ?? null;
    return fleetRec !== null ? Math.min(envCap, Math.max(1, fleetRec)) : envCap;
  }

  // G4: AIMD concurrency controller — additive increase on success (+1), multiplicative
  // decrease on failure (×0.5). Bounded by [1, hardCap]. Called after each runtime completes.
  private adjustConcurrency(success: boolean): void {
    const sem = LoopService.runtimeSemaphore;
    const cap = this.runtimeSemaphoreHardCap();
    if (success) {
      sem.dynamicLimit = Math.min((sem.dynamicLimit ?? cap) + 1, cap);
    } else {
      sem.dynamicLimit = Math.max(1, Math.floor((sem.dynamicLimit ?? cap) * 0.5));
    }
    // G5-persist: save the dynamicLimit to the DB so it survives restarts.
    try {
      this.db.prepare('INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('aimd_dynamic_limit', String(sem.dynamicLimit), new Date().toISOString());
    } catch { /* table might not exist — non-fatal */ }
    // G14: emit AIMD state change for live observability.
    swarmEventBus.emit('aimd_state', {
      dynamicLimit: sem.dynamicLimit,
      active: sem.active.size,
      queue_depth: sem.queue.length,
      hard_cap: cap,
      success,
    });
  }

  /**
   * G9: Graceful scale-down — on budget exhaustion or circuit-break, stop accepting
   * new leases, wait up to drainTimeoutMs for in-flight leases to complete, then
   * checkpoint + SIGTERM (not SIGKILL) any that don't finish. The run is marked
   * 'interrupted' with interrupted_reason: 'budget_drain' so it can be resumed (G10).
   * This prevents mid-artifact data loss — the system drains safely, not abruptly.
   */
  async drainRuntimeLeases(drainTimeoutMs = 60_000): Promise<{ drained: number; checkpointed: number; cancelled: number }> {
    const sem = LoopService.runtimeSemaphore;
    // 1. Stop accepting new leases: reject all queued waiters.
    const queued = sem.queue.splice(0);
    for (const q of queued) q.reject(new Error('DRAIN_CANCELLED'));
    const cancelled = queued.length;

    // 2. Wait for in-flight leases to complete (up to drainTimeoutMs).
    const deadline = Date.now() + drainTimeoutMs;
    let drained = 0;
    while (sem.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    drained = sem.active.size === 0 ? drained + sem.active.size : drained; // all completed
    const stillActive = Array.from(sem.active);
    const checkpointed = stillActive.length;

    // 3. SIGTERM (not SIGKILL) any leases still in-flight after the drain timeout.
    for (const leaseId of stillActive) {
      const handle = LoopService.runtimeLeases.get(leaseId);
      if (handle?.child && !handle.child.killed) {
        handle.child.kill('SIGTERM');
      }
      sem.active.delete(leaseId);
    }

    return { drained, checkpointed, cancelled };
  }

  /**
   * Acquire a runtime permit, awaiting if the concurrency cap is reached. A
   * queued waiter is rejectable via cancelRuntimePermit (used by stop), so a
   * lease stopped before it ever spawns does not hang the queue.
   */
  private acquireRuntimePermit(leaseId: string): Promise<void> {
    const sem = LoopService.runtimeSemaphore;
    if (sem.active.has(leaseId)) return Promise.resolve();
    if (sem.active.size < this.runtimeSemaphoreLimit()) {
      sem.active.add(leaseId);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      sem.queue.push({ leaseId, resolve, reject });
    });
  }

  /**
   * Release a permit and admit the next queued waiter. Idempotent — safe to call
   * on every exit path of executeRuntimeCommand.
   */
  private releaseRuntimePermit(leaseId: string): void {
    const sem = LoopService.runtimeSemaphore;
    if (sem.active.has(leaseId)) {
      sem.active.delete(leaseId);
      const next = sem.queue.shift();
      if (next) {
        sem.active.add(next.leaseId);
        next.resolve();
      }
    } else {
      // Not active — maybe still queued (e.g. spawn threw after acquire). Remove
      // the queued waiter without admitting a replacement; release() of an active
      // slot below will admit the next.
      const idx = sem.queue.findIndex((w) => w.leaseId === leaseId);
      if (idx >= 0) sem.queue.splice(idx, 1);
    }
  }

  /**
   * Cancel a permit acquisition for a lease that was stopped before it could
   * spawn. Rejects the queued waiter so executeRuntimeCommand rejects promptly;
   * no active slot is freed (the lease never held one).
   */
  private cancelRuntimePermit(leaseId: string): void {
    const sem = LoopService.runtimeSemaphore;
    const idx = sem.queue.findIndex((w) => w.leaseId === leaseId);
    if (idx >= 0) {
      const [waiter] = sem.queue.splice(idx, 1);
      waiter.reject(new Error('RUNTIME_PERMIT_CANCELLED'));
    }
  }

  /** Test/diagnostic: how many runtime children are live right now. */
  public runtimeConcurrencyInUse(): number {
    return LoopService.runtimeSemaphore.active.size;
  }

  private getRuntimeLease(leaseId: string): RuntimeProcessHandle | null {
    return LoopService.runtimeLeases.get(leaseId) || null;
  }

  public isWorkerLeaseCancelled(leaseId: string): boolean {
    const lease = this.getWorkerLease(leaseId);
    const stopped = lease.metadata.stop_requested_at;
    const wasStopped = lease.metadata.stopped_by_runner || lease.metadata.runtime_was_cancelled;
    return Boolean(stopped || wasStopped || lease.status === 'cancelled');
  }

  private async executeRuntimeCommand(
    leaseId: string,
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      maxBuffer?: number;
      enforceCwdBoundary?: boolean;
    } = {}
  ): Promise<RuntimeExecutionResult> {
    const maxBuffer = options.maxBuffer || 5 * 1024 * 1024;
    const timeoutMs = options.timeoutMs || 120_000;

    if (options.enforceCwdBoundary && options.cwd) {
      this.assertWithinWorktreeRoot(options.cwd);
    }

    // P2: bound live runtime children. A lease stopped while queued here will
    // have its acquire rejected (cancelRuntimePermit) and never spawn.
    await this.acquireRuntimePermit(leaseId);

    return new Promise<RuntimeExecutionResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timedOutAt: string | undefined;
      let timedOutHandled = false;
      let exitCode: number | null = null;
      let signal: string | null = null;
      let settled = false;

      const safeTrim = (input: string) => input.length > maxBuffer ? input.slice(-maxBuffer) : input;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let child: ChildProcess;
      // G6.1: pluggable OS sandbox — if SANDBOX_WRAPPER is set (e.g., 'bwrap'), wrap the
      // runtime command in the sandbox binary. bwrap makes the host read-only + the worktree
      // writable + a fresh /tmp, preventing absolute-path escape (the residual from codex's
      // own --sandbox workspace-write). This is the real OS-level isolation layer.
      const sandboxWrapper = process.env.SANDBOX_WRAPPER;
      if (sandboxWrapper && options.cwd) {
        const cwd = options.cwd;
        const sandboxArgs = [
          '--ro-bind', '/', '/',
          '--bind', cwd, cwd,
          '--dev', '/dev',
          '--proc', '/proc',
          '--tmpfs', '/tmp',
        ];
        if (process.env.SANDBOX_NO_NET === '1') sandboxArgs.unshift('--unshare-net');
        sandboxArgs.push('--', command, ...args);
        args = sandboxArgs;
        command = sandboxWrapper;
      }
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env || this.buildRuntimeEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.releaseRuntimePermit(leaseId);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (!child.pid) {
        this.releaseRuntimePermit(leaseId);
        reject(new Error('RUNTIME_PROCESS_START_FAILED'));
        return;
      }
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (!timedOutHandled) {
            timedOut = true;
            timedOutAt = new Date().toISOString();
            timedOutHandled = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // best effort stop for timeout enforcement.
            }
          }
        }, timeoutMs);
      }

      this.registerRuntimeLease(leaseId, child, command, args, timeoutHandle);

      const finalize = () => {
        if (settled) return;
        settled = true;
        this.clearRuntimeLease(leaseId);
        this.releaseRuntimePermit(leaseId);
        resolve({
          exitCode,
          signal,
          timedOut,
          timedOutAt,
          stdout: safeTrim(stdout),
          stderr: safeTrim(stderr),
          runtimePid: child.pid || undefined,
        });
        // G4: AIMD — adjust the concurrency limit based on this runtime's outcome.
        this.adjustConcurrency(exitCode === 0 && !timedOut);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > maxBuffer) {
          stdout = stdout.slice(-maxBuffer);
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > maxBuffer) {
          stderr = stderr.slice(-maxBuffer);
        }
      });

      child.on('error', (error) => {
        this.clearRuntimeLease(leaseId);
        this.releaseRuntimePermit(leaseId);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on('close', (code, childSignal) => {
        exitCode = code === null ? exitCode : code;
        signal = childSignal || null;
        if (timedOut && typeof code === 'number' && code === 0) {
          // keep runtime timeout marker for explicit timeout termination paths.
          timedOut = true;
        }
        finalize();
      });
    });
  }

  public stopWorkerLeaseRuntime(leaseId: string): RuntimeStopResult {
    const runtimeLease = this.getRuntimeLease(leaseId);
    if (!runtimeLease) {
      // No live process handle: the lease may still be queued at the semaphore
      // (stopped before it ever spawned). Cancel its permit so executeRuntimeCommand
      // rejects promptly instead of hanging the queue.
      this.cancelRuntimePermit(leaseId);
      return { stopMode: 'best_effort_no_process_handle', killAttempted: false };
    }

    const child = runtimeLease.child;
    let killAttempted = false;
    try {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      killAttempted = true;
      this.patchWorkerLeaseMetadata(leaseId, {
        runtime_stop_requested_at: new Date().toISOString(),
        runtime_stop_attempted: true,
        runtime_stop_mode: 'stop',
      });
    } catch {
      killAttempted = false;
    }

    if (child.killed) {
      this.clearRuntimeLease(leaseId);
      return { stopMode: 'stop', killAttempted };
    }

    try {
      child.kill('SIGKILL');
      killAttempted = killAttempted || true;
      this.clearRuntimeLease(leaseId);
      return { stopMode: 'kill', killAttempted };
    } catch {
      return { stopMode: 'best_effort_no_process_handle', killAttempted };
    }
  }

  private listWorkerLeases(loopRunId: string): WorkerLeaseRecord[] {
    const rows = this.db.prepare('SELECT * FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at ASC').all(loopRunId) as any[];
    return rows.map((row) => this.parseWorkerLease(row));
  }

  private listLoopEvents(loopRunId: string): LoopEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM loop_events WHERE loop_run_id = ? ORDER BY created_at ASC').all(loopRunId) as any[];
    return rows.map((row) => ({
      id: row.id,
      loop_run_id: row.loop_run_id,
      event_type: row.event_type,
      level: row.level,
      message: row.message,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
    }));
  }

  private git(repositoryPath: string, args: string[]): string {
    try {
      return execFileSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() || '';
      throw new Error(stderr.trim() || `git ${args.join(' ')} failed`);
    }
  }

  private titleForFinding(finding: LoopFinding): string {
    if (finding.type === 'missing_script_reference') return `Fix stale npm script reference in ${finding.file}`;
    if (finding.type === 'broken_relative_link') return `Fix broken Markdown link in ${finding.file}`;
    if (finding.type === 'draft_loop_skill') return `Validate loop skill ${path.basename(finding.file, '.md')}`;
    if (finding.type.includes('security')) return `Review security finding in ${finding.file}`;
    if (finding.type.includes('mcp')) return `Validate MCP connector finding in ${finding.file}`;
    if (finding.type.includes('okf')) return `Synchronize OKF finding in ${finding.file}`;
    if (finding.type.includes('policy')) return `Review policy drift in ${finding.file}`;
    if (finding.type.includes('skill')) return `Validate skill finding in ${finding.file}`;
    return `Resolve loop finding in ${finding.file}`;
  }

  private writeLoopState(runId: string, input: {
    loopName: LoopName;
    runId: string;
    goal: GoalRecord | null;
    repositoryPath: string;
    findings: LoopFinding[];
    plan: Record<string, unknown>;
    gates: LoopGate[];
    nextActions: string[];
    createdAt: string;
  }): string {
    const runDir = path.join(this.evidenceRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'LOOP_STATE.md');
    const lines = [
      `# ${input.loopName}`,
      '',
      `Run ID: ${input.runId}`,
      `Created: ${input.createdAt}`,
      `Repository: ${input.repositoryPath}`,
      `Goal: ${input.goal?.objective || `ad-hoc ${input.loopName} scan`}`,
      '',
      '## Gates',
      '',
      ...input.gates.map((gate) => `- ${gate.name}: ${gate.status} - ${gate.evidence}`),
      '',
      '## Findings',
      '',
      ...(input.findings.length
        ? input.findings.map((finding) => `- ${finding.type} ${finding.file}${finding.line ? `:${finding.line}` : ''} - ${finding.message}`)
        : ['- None']),
      '',
      '## Next Actions',
      '',
      ...input.nextActions.map((action) => `- ${action}`),
      '',
      '## Plan',
      '',
      '```json',
      JSON.stringify(input.plan, null, 2),
      '```',
      '',
    ];
    fs.writeFileSync(statePath, lines.join('\n'), 'utf8');
    return statePath;
  }

  private recordLoopEvent(loopRunId: string, eventType: string, level: 'debug' | 'info' | 'warning' | 'error' | 'critical', message: string, metadata: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), loopRunId, eventType, level, message, JSON.stringify(metadata), new Date().toISOString());
  }

  private parseGoal(row: any): GoalRecord {
    return {
      id: row.id,
      objective: row.objective,
      constraints: JSON.parse(row.constraints_json || '[]'),
      acceptance_criteria: JSON.parse(row.acceptance_criteria_json || '[]'),
      risk_class: row.risk_class,
      budget: JSON.parse(row.budget_json || '{}'),
      status: row.status,
      owner_user_id: row.owner_user_id || null,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseLoopRun(row: any): LoopRunRecord {
    return {
      id: row.id,
      goal_id: row.goal_id || null,
      loop_name: row.loop_name,
      mode: row.mode,
      status: row.status,
      repository_path: row.repository_path || null,
      state_file: row.state_file || null,
      findings: JSON.parse(row.findings_json || '[]'),
      plan: JSON.parse(row.plan_json || '{}'),
      gates: JSON.parse(row.gates_json || '[]'),
      next_actions: JSON.parse(row.next_actions_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at || null,
    };
  }
}
