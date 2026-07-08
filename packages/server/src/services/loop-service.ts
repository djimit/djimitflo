import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Database } from 'better-sqlite3';
import { AgentAssuranceService } from './agent-assurance-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { mintSpawnToken, resolveSpawnTokenSecret } from './spawn-token';
import { swarmEventBus } from './swarm-event-bus';
import { LoopBudgetService } from './loop-budget-service';
import { WorktreeManager } from './worktree-manager';
import { GoalService, type GoalRecord, type GoalCreateInput, type GoalUpdateInput, type DecomposedLoopCandidate } from './goal-service';
import { LoopWorkerExecutorService, type ExecuteWorkerResult } from './loop-worker-executor-service';
import { RuntimeCommandService } from './runtime-command-service';
import { LoopLifecycleService } from './loop-lifecycle-service';
import { LoopDiscoveryService } from './loop-discovery-service';
import { LoopVerificationService } from './loop-verification-service';
export type { LoopFinding } from './loop-discovery-service';

type RiskClass = 'low' | 'medium' | 'high' | 'critical';
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

export type { GoalRecord, GoalCreateInput, GoalUpdateInput, DecomposedLoopCandidate } from './goal-service';

export type { LoopFinding } from './loop-discovery-service';

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

interface CheckerVerdictInput {
  lease_id?: string;
  maker_lease_id?: string;
  verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence';
  notes?: string;
}

interface RunChecksInput {
  lease_id?: string;
  timeout_ms?: number;
  scripts?: string[];
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
  child: ChildProcess;
  leaseId: string;
  command: string;
  args: string[];
  startedAt: string;
  timeoutHandle?: NodeJS.Timeout;
}

export type RuntimeManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';

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

  private db: Database;
  public evidenceRoot: string;
  public assurance: AgentAssuranceService;
  private intelligence: SwarmIntelligenceService;
  private budget: LoopBudgetService;
  private worktree: WorktreeManager;
  private goals: GoalService;
  public workerExecutor: LoopWorkerExecutorService;
  public runtimeCommand: RuntimeCommandService;
  public lifecycle: LoopLifecycleService;
  public discovery: LoopDiscoveryService;
  public metaOrchestration?: import('./meta-orchestration-service').MetaOrchestrationService;
  public verification: LoopVerificationService;
  /**
   * Secret used to mint a nested-spawn child's own scoped token (L1). Lazily
   * resolved from the same env chain as NestedSpawnService so a token minted here
   * validates at the spawn endpoint. LoopService only MINTS (never validates) —
   * validation stays in NestedSpawnService.requestSpawn over HTTP. This avoids a
   * LoopService → NestedSpawnService cycle (token logic lives in ./spawn-token).
   */
  private spawnTokenSecret: string | undefined;

  constructor(db: Database, evidenceRoot = DEFAULT_EVIDENCE_ROOT) {
    this.db = db;
    this.evidenceRoot = evidenceRoot;
    this.assurance = new AgentAssuranceService(db);
    this.intelligence = new SwarmIntelligenceService(db);
    this.budget = new LoopBudgetService(db, {
      getGoal: (id) => this.getGoal(id),
      getLoopRun: (id) => this.getLoopRun(id),
      listWorkerLeases: (runId) => this.listWorkerLeases(runId),
      recordLoopEvent: (runId, eventType, severity, message, metadata) => {
        this.recordLoopEvent(runId, eventType, severity as 'debug' | 'info' | 'warning' | 'error' | 'critical', message, metadata);
      },
    });
    this.worktree = new WorktreeManager(db);
    this.goals = new GoalService(db);
    this.workerExecutor = new LoopWorkerExecutorService(db, this);
    this.runtimeCommand = new RuntimeCommandService(db, this);
    this.lifecycle = new LoopLifecycleService(this);
    this.discovery = new LoopDiscoveryService();
    this.verification = new LoopVerificationService(this);
  }

  setMetaOrchestration(service: import('./meta-orchestration-service').MetaOrchestrationService): void {
    this.metaOrchestration = service;
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

  resumeInterruptedRun(runId: string, maxResumeAttempts = 3): {
    resumed: boolean;
    boundedFail: boolean;
    resumeAttempt: number;
    requeuedFindings: string[];
    skippedFindings: string[];
  } {
    const run = this.db.prepare('SELECT id, status, metadata FROM loop_runs WHERE id = ?').get(runId) as { id: string; status: string; metadata: string } | undefined;
    if (!run || run.status !== 'interrupted') {
      throw new Error('LOOP_RUN_NOT_INTERRUPTED');
    }

    const metadata = JSON.parse(run.metadata || '{}') as Record<string, unknown>;
    const resumeAttempts = (metadata.resume_attempts as number ?? 0) + 1;

    if (resumeAttempts > maxResumeAttempts) {
      this.db.prepare('UPDATE loop_runs SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run('failed', runId);
      return { resumed: false, boundedFail: true, resumeAttempt: resumeAttempts, requeuedFindings: [], skippedFindings: [] };
    }

    const runRow = this.db.prepare('SELECT findings_json FROM loop_runs WHERE id = ?').get(runId) as { findings_json: string } | undefined;
    const findings = JSON.parse(runRow?.findings_json || '[]') as Array<{ id: string }>;
    const completedFindings = new Set<string>();
    const leases = this.db.prepare('SELECT finding_id, status FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ finding_id: string | null; status: string }>;
    for (const lease of leases) {
      if (lease.status === 'completed' && lease.finding_id) completedFindings.add(lease.finding_id);
    }

    const requeuedFindings: string[] = [];
    const skippedFindings: string[] = [];

    for (const finding of findings) {
      if (completedFindings.has(finding.id)) {
        skippedFindings.push(finding.id);
      } else {
        requeuedFindings.push(finding.id);
      }
    }

    this.db.prepare('UPDATE loop_runs SET status = ?, metadata = ?, updated_at = datetime(\'now\') WHERE id = ?').run('running', JSON.stringify({ ...metadata, resume_attempts: resumeAttempts }), runId);

    swarmEventBus.emit('recovery', {
      run_id: runId,
      resumed: true,
      requeued_findings: requeuedFindings.length,
    });

    return { resumed: true, boundedFail: false, resumeAttempt: resumeAttempts, requeuedFindings, skippedFindings };
  }

  resumeInterruptedRuns(): { resumed: number; boundedFailed: number; details: Array<{ runId: string; resumed: boolean }> } {
    const interruptedRuns = this.db.prepare('SELECT id FROM loop_runs WHERE status = ?').all('interrupted') as Array<{ id: string }>;
    const details: Array<{ runId: string; resumed: boolean }> = [];
    let resumed = 0;
    let boundedFailed = 0;

    for (const run of interruptedRuns) {
      const result = this.resumeInterruptedRun(run.id);
      details.push({ runId: run.id, resumed: result.resumed });
      if (result.resumed) resumed++;
      else boundedFailed++;
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
    return this.worktree.pruneOrphanedWorktrees(options);
  }

  createGoal(input: GoalCreateInput, ownerUserId?: string): GoalRecord {
    return this.goals.createGoal(input, ownerUserId);
  }

  listGoals(): GoalRecord[] {
    return this.goals.listGoals();
  }

  getGoal(id: string): GoalRecord {
    return this.goals.getGoalById(id);
  }

  updateGoal(id: string, input: GoalUpdateInput): GoalRecord {
    return this.goals.updateGoal(id, input);
  }

  decomposeGoal(id: string): { goal: GoalRecord; candidates: DecomposedLoopCandidate[] } {
    return this.goals.decomposeGoal(id, LOOP_CONTRACTS, LOOP_NAME);
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
        sovereign: input.sovereign === true,
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

  private findCapabilityForFinding(finding: LoopFinding): { id: string } | undefined {
    try {
      const capabilities = this.intelligence.listCapabilities();
      const matching = capabilities.filter(c =>
        c.id.includes(finding.type) || finding.type.includes(c.id)
      );
      return matching[0] || capabilities[0];
    } catch { return undefined; }
  }

  planLoopRun(id: string): Array<{ findingId: string; runtime: string; capabilityId: string }> {
    const run = this.getLoopRun(id);
    const findings = run.findings;
    const plan: Array<{ findingId: string; runtime: string; capabilityId: string }> = [];
    const validRuntimes = ['codex', 'opencode', 'pi', 'claude', 'gemini', 'editor', 'mock'] as const;

    for (const finding of findings) {
      const runMeta = run.metadata as Record<string, unknown>;
      let selectedRuntime: string;
      let capabilityId = '';

      if (runMeta.sovereign === true || process.env.PI_OFFLINE === '1') {
        selectedRuntime = 'pi';
      } else {
        const capability = this.findCapabilityForFinding(finding);
        capabilityId = capability?.id || '';
        selectedRuntime = this.selectRuntimeForCapability(capabilityId, finding);
      }

      if (!validRuntimes.includes(selectedRuntime as typeof validRuntimes[number])) {
        selectedRuntime = 'codex';
      }

      plan.push({
        findingId: finding.id,
        runtime: selectedRuntime,
        capabilityId,
      });
    }

    return plan;
  }

  private selectRuntimeForCapability(capabilityId: string, _finding: LoopFinding): string {
    void _finding;
    const validRuntimes = ['codex', 'opencode', 'pi', 'claude', 'gemini', 'editor', 'mock'] as const;

    try {
      const cap = this.db.prepare('SELECT metadata, cost_model_json FROM swarm_capabilities WHERE id = ?').get(capabilityId) as { metadata: string; cost_model_json: string } | undefined;
      if (cap) {
        const costModel = JSON.parse(cap.cost_model_json || '{}') as { learned?: boolean; p50_tokens?: number };
        if (costModel?.learned && typeof costModel.p50_tokens === 'number' && costModel.p50_tokens < 5000) {
          return 'opencode';
        }
        const metadata = JSON.parse(cap.metadata || '{}') as Record<string, unknown>;
        const competence = metadata.competence as { success_rate?: number } | undefined;
        if (competence?.success_rate !== undefined && competence.success_rate > 0.7) {
          return 'codex';
        }
      }

      const runtimeData = this.intelligence.measureCompetencePerRuntime(capabilityId);
      const entries = Object.entries(runtimeData);
      if (entries.length > 0) {
        let bestRuntime = entries[0][0];
        let bestScore = -1;
        for (const [runtime, data] of entries) {
          if (data.success_rate < 0.3) continue;
          if (data.success_rate > bestScore) {
            bestScore = data.success_rate;
            bestRuntime = runtime;
          }
        }
        if (bestScore > 0 && validRuntimes.includes(bestRuntime as typeof validRuntimes[number])) {
          return bestRuntime;
        }
      }
    } catch { /* fallback */ }

    return 'codex';
  }

  computeDollarCost(runtime: string, totalTokens: number): number {
    return this.budget.computeDollarCost(runtime, totalTokens);
  }

  allocateDollarBudget(
    findings: Array<{ finding_id: string; capability_id: string; p50_dollars: number; competence: number }>,
    budget: number,
  ): { allocated: string[]; deferred: string[]; budgetInsufficient: boolean } {
    return this.budget.allocateDollarBudget(findings, budget);
  }

  computeEfficiencyMetric(runId: string): { verifiedArtifacts: number; dollarsSpent: number; efficiency: number } {
    return this.budget.computeEfficiencyMetric(runId);
  }

  adjustConcurrency(increase: boolean): { success: boolean; dynamicLimit: number; active: number; queueDepth: number } {
    return this.budget.adjustConcurrency(increase);
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
    return this.lifecycle.continueLoopRun(id, input);
  }
  splitLoopFinding(id: string, input: SplitLoopInput = {}): { run: LoopRunRecord; parent: LoopFinding; children: LoopFinding[]; leases: WorkerLeaseRecord[] } {
    return this.lifecycle.splitLoopFinding(id, input);
  }
  retryLoopRun(id: string, input: RetryLoopInput = {}): { run: LoopRunRecord; leases: WorkerLeaseRecord[]; retry_maker: WorkerLeaseRecord; retry_checker: WorkerLeaseRecord } {
    return this.lifecycle.retryLoopRun(id, input);
  }
  verifyLoopRun(id: string): { run: LoopRunRecord; gates: LoopGate[]; leases: WorkerLeaseRecord[] } {
    return this.verification.verifyLoopRun(id);
  }

  certifyLoopRun(id: string): { run: LoopRunRecord; gates: LoopGate[]; certified: boolean } {
    return this.verification.certifyLoopRun(id);
  }

  completeLoopRun(id: string, input: { human_approval_ref?: string } = {}): { run: LoopRunRecord; gates: LoopGate[] } {
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

      if (!input.human_approval_ref) {
        throw new Error('LOOP_HUMAN_APPROVAL_REQUIRED');
      }

      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, next_actions_json = ?, updated_at = ?, completed_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.human_approval_ref', ?)
        WHERE id = ?
      `).run('completed', JSON.stringify(['Loop completed; ready for human review before merge']), now, now, input.human_approval_ref, id);

      this.recordLoopEvent(id, 'loop_completed', 'info', 'Loop run completed after verification gates passed.', {
        gates: verified.gates,
        human_approval_ref: input.human_approval_ref,
      });

      const completedRun = this.getLoopRun(id);
      const completedLeases = this.listWorkerLeases(id);
      const durationMs = completedRun.completed_at && completedRun.created_at
        ? new Date(completedRun.completed_at).getTime() - new Date(completedRun.created_at).getTime()
        : 0;
      const strategy = current.metadata?.strategy as string || 'default';
      const completedCount = completedLeases.filter((l) => l.status === 'completed').length;
      const failedCount = completedLeases.filter((l) => l.status === 'failed').length;

      swarmEventBus.emit('loop_completed', {
        loopRunId: id,
        goalId: current.goal_id,
        goalType: current.loop_name,
        mode: current.mode,
        status: 'completed',
        durationMs,
        strategy,
        totalLeases: completedLeases.length,
        completedLeases: completedCount,
        failedLeases: failedCount,
        startedAt: current.created_at,
        completedAt: completedRun.completed_at,
      });

      // Meta-orchestration: record loop outcome for learning
      if (this.metaOrchestration) {
        this.metaOrchestration.recordOutcome({
          taskId: id,
          taskType: current.loop_name || 'loop',
          title: current.loop_name || 'Loop run',
          description: `Loop with ${completedLeases.length} leases, strategy: ${strategy}`,
          provider: 'litellm',
          model: strategy,
          runtime: 'loop',
          success: true,
          durationMs,
          costDollars: 0,
          tags: ['loop', current.loop_name || 'unknown'],
          metadata: { completed_leases: completedCount, failed_leases: failedCount },
        });
      }

      return { run: completedRun, gates: verified.gates };
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

  async executeMaker(id: string, input: ExecuteMakerInput = {}): Promise<ExecuteWorkerResult> {
    return this.workerExecutor.executeMaker(id, input);
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
    if (lease.role !== 'maker') {
      throw new Error('LEASE_NOT_MAKER');
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
    return this.workerExecutor.executeChecker(id, input);
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

  public assertNoFailedGates(run: LoopRunRecord): void {
    if (run.gates.some((gate) => gate.status === 'fail')) {
      throw new Error('LOOP_FAILED_GATES_BLOCK_CONTINUE');
    }
  }

  public assertLoopNotEscalated(run: LoopRunRecord): void {
    if (run.status === 'escalated') {
      throw new Error('LOOP_ESCALATED_REQUIRES_HUMAN');
    }
  }

  public assertTokenBudgetAvailable(run: LoopRunRecord): void {
    const budget = this.getTokenBudget(run);
    if (!budget.maxTokens) {
      return;
    }
    const used = this.sumRuntimeTokens(this.listWorkerLeases(run.id));
    if (used >= budget.maxTokens) {
      throw new Error('LOOP_TOKEN_BUDGET_EXHAUSTED');
    }
  }

  public assertWallClockBudgetAvailable(run: LoopRunRecord): void {
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

  public isSplitFinding(finding: LoopFinding): boolean {
    return finding.metadata?.status === 'split';
  }

  public getMakerLeaseBudget(run: LoopRunRecord, input: ContinueLoopInput): { maxMakerWorkers: number; source: 'goal' | 'request' | 'default' } {
    return this.budget.getMakerLeaseBudget(run, input.max_maker_workers);
  }

  public getRetryBudget(run: LoopRunRecord, maker: WorkerLeaseRecord, input: RetryLoopInput): { maxRetries: number; source: 'goal' | 'request' | 'lease' | 'default' } {
    return this.budget.getRetryBudget(run, maker, input.max_retries);
  }

  private getFailureThreshold(run: LoopRunRecord): { maxFailureCount: number; source: 'goal' | 'default' } {
    return this.budget.getFailureThreshold(run);
  }

  public getTokenBudget(run: LoopRunRecord): { maxTokens?: number; maxTokensPerWorker?: number; maxTokensPerDiffLine?: number; source: 'goal' | 'none' } {
    return this.budget.getTokenBudget(run);
  }

  private getWallClockBudget(run: LoopRunRecord): { maxRuntimeMs?: number; source: 'goal' | 'none' } {
    return this.budget.getWallClockBudget(run);
  }

  public evaluateTokenBudget(run: LoopRunRecord, runtimeUsage: RuntimeUsage | null, currentLeaseId: string, diffLines?: number): { gate: LoopGate; exhausted: boolean; efficiencyExceeded: boolean; budget: Record<string, unknown> } {
    return this.budget.evaluateTokenBudget(run, runtimeUsage, currentLeaseId, diffLines);
  }

  private sumRuntimeTokens(leases: WorkerLeaseRecord[]): number {
    return leases.reduce((sum, lease) => {
      const usage = lease.metadata.runtime_usage as { total_tokens?: unknown } | undefined;
      const total = Number(usage?.total_tokens);
      return Number.isFinite(total) && total > 0 ? sum + total : sum;
    }, 0);
  }

  public extractRuntimeUsage(stdout: string): RuntimeUsage | null {
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

  public escalateIfFailureThresholdExceeded(runId: string, reason: string): LoopRunRecord {
    return this.budget.escalateIfFailureThresholdExceeded(runId, reason);
  }



  public recordMakerFailure(runId: string, leaseId: string, reason: string, details: string): void {
    try {
      this.updateWorkerLeaseStatus(leaseId, 'failed', {
        verdict: 'insufficient_evidence',
        exit_status: reason,
        failure_reason: details,
        failed_at: new Date().toISOString(),
      });
      this.recordLoopEvent(runId, 'maker_execution_failed', 'warning', `Maker lease ${leaseId} failed: ${reason}`, {
        lease_id: leaseId,
        failure_reason: reason,
        details,
      });
    } catch {
      // Best-effort: don't let recording failures mask the original error
    }
  }

  public isHighRiskRun(run: LoopRunRecord, finding?: LoopFinding): boolean {
    if (run.goal_id) {
      const goal = this.getGoal(run.goal_id);
      if (goal.risk_class === 'high' || goal.risk_class === 'critical') {
        return true;
      }
    }
    const candidates = finding ? [finding] : run.findings;
    return candidates.some((candidate) => Boolean(this.highRiskReason(run, candidate)));
  }

  public highRiskReason(run: LoopRunRecord, finding?: LoopFinding): string | null {
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

  discoverLoopFindings(loopName: LoopName, repositoryPath: string, maxFindings: number): LoopFinding[] {
    return this.discovery.discoverLoopFindings(loopName, repositoryPath, maxFindings);
  }


  public createPlan(loopName: LoopName, findings: LoopFinding[]): Record<string, unknown> {
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

  public branchNameFor(runId: string, findingId: string, retryAttempt?: number): string {
    return this.worktree.branchNameFor(runId, findingId, retryAttempt);
  }

  public createWorktree(repositoryPath: string, runId: string, findingId: string, branchName: string): string {
    return this.worktree.createWorktree(repositoryPath, runId, findingId, branchName);
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
  public resolveSkipPermissions(requested?: boolean): boolean {
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

  public buildRuntimeEnv(): NodeJS.ProcessEnv {
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
  public buildNestedSpawnEnv(lease: WorkerLeaseRecord): NodeJS.ProcessEnv | undefined {
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
  public assertWithinWorktreeRoot(cwd: string): void {
    const resolvedCwd = this.safeRealpath(cwd);
    const candidates: string[] = [];
    const configured = process.env.LOOP_WORKTREE_ROOT;
    if (configured) candidates.push(configured);
    candidates.push(os.tmpdir());
    candidates.push(path.resolve(this.safeRealpath(process.cwd()), '..', '.djimitflo-loop-worktrees'));
    const inside = candidates.some((root) => {
      const resolvedRoot = this.safeRealpath(root);
      return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(resolvedRoot + path.sep);
    });
    if (!inside) {
      throw new Error(`RUNTIME_CWD_OUTSIDE_WORKTREE: ${resolvedCwd}`);
    }
  }

  public buildRuntimeCommand(runtime: string, worktreePath: string, prompt: string, skipPermissions = false): { command: string; args: string[] } {
    return this.runtimeCommand.buildRuntimeCommand(runtime, worktreePath, prompt, skipPermissions);
  }
  public getRuntimeContract(runtime: string): RuntimeContract {
    return this.runtimeCommand.getRuntimeContract(runtime);
  }
  public assertRuntimeAvailable(runtime: string): void {
    const probe = this.getRuntimeContract(runtime);
    if (!probe.available) throw new Error('RUNTIME_UNAVAILABLE');
  }
  public extractRuntimeWarnings(stdout: string, stderr: string): Array<Record<string, unknown>> {
    return this.runtimeCommand.extractRuntimeWarnings(stdout, stderr);
  }
  public runtimeWarningsBlockCompletion(warnings: Array<Record<string, unknown>>, run: LoopRunRecord): boolean {
    return this.runtimeCommand.runtimeWarningsBlockCompletion(warnings, run);
  }

  public runtimeWarningsEvidence(warnings: Array<Record<string, unknown>>, run: LoopRunRecord): string {
    return this.runtimeCommand.runtimeWarningsEvidence(warnings, run);
  }

  public calculateWorkerEfficiency(runtimeUsage: RuntimeUsage | null, diffLines: number): Record<string, unknown> {
    return this.runtimeCommand.calculateWorkerEfficiency(runtimeUsage, diffLines);
  }

  public makeManifestDecisionId(loopRunId: string, leaseId: string | null, action: RuntimeManifestAction): string {
    return `${loopRunId}:${leaseId || 'unknown'}:${action}:${Date.now()}:${randomUUID().slice(0, 10)}`;
  }

  public currentCapacitySnapshot() {
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

  public currentBudgetSnapshot(run: LoopRunRecord, runtimeUsage?: RuntimeUsage | null): Record<string, unknown> {
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

  public recordWorkerManifest(input: {
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

  public isRetryableMakerLease(maker: WorkerLeaseRecord, checkerLeases: WorkerLeaseRecord[]): boolean {
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

  public isSupersededMakerLease(lease: WorkerLeaseRecord): boolean {
    return lease.role === 'maker' && typeof lease.metadata.superseded_by_maker_lease_id === 'string';
  }

  public retryRootFor(maker: WorkerLeaseRecord): string {
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

  public workAssignmentPath(worktreePath: string): string {
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

  public ensureWorktreeControlIgnore(worktreePath: string): void {
    try {
      const excludePath = this.git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']).trim();
      const absoluteExcludePath = path.isAbsolute(excludePath) ? excludePath : path.join(worktreePath, excludePath);
      const current = fs.existsSync(absoluteExcludePath) ? fs.readFileSync(absoluteExcludePath, 'utf8') : '';
      if (!current.split(/\r?\n/).includes(`${CONTROL_DIR}/`)) {
        fs.mkdirSync(path.dirname(absoluteExcludePath), { recursive: true });
        fs.appendFileSync(absoluteExcludePath, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${CONTROL_DIR}/\n`, 'utf8');
      }
    } catch {
      // The control directory is still useful even when git excludes cannot be updated.
    }
  }

  public resolveWorkAssignmentPath(lease: WorkerLeaseRecord): string {
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

  public writeWorkAssignment(
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

  public writeAssignmentPacket(worktreePath: string, run: LoopRunRecord, finding: LoopFinding, runtime: string, retryAttempt?: number, capabilitiesManifest?: string): string {
    this.ensureControlDir(worktreePath);
    const packetPath = this.assignmentPacketPath(worktreePath);
    const contract = (run.metadata.contract && typeof run.metadata.contract === 'object')
      ? run.metadata.contract as Record<string, unknown>
      : {};
    const tokenBudget = run.goal_id ? this.getTokenBudget(run) : { source: 'none' as const };
    const goal = run.goal_id ? this.getGoal(run.goal_id) : null;
    const maxTokensPerDiffLine = goal && Number.isFinite(Number(goal.budget.max_tokens_per_diff_line))
      ? Number(goal.budget.max_tokens_per_diff_line)
      : undefined;
    const packet = {
      schema_version: 1,
      loop_run_id: run.id,
      loop_name: run.loop_name,
      goal_id: run.goal_id,
      mode: run.mode,
      status: run.status,
      runtime,
      retry_attempt: retryAttempt || 0,
      repository_path: run.repository_path,
      worktree_path: worktreePath,
      // L4 skill injection: the validated capability manifest (read-only
      // metadata) when this lease was armed with capabilities.
      capabilities: capabilitiesManifest ? JSON.parse(capabilitiesManifest) : [],
      runtime_profile: {
        name: 'djimitflo-worker',
        token_budget: {
          max_tokens: tokenBudget.maxTokens,
          max_tokens_per_worker: tokenBudget.maxTokensPerWorker,
          max_tokens_per_diff_line: maxTokensPerDiffLine,
          source: tokenBudget.source,
        },
      },
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

  public buildCheckerPrompt(run: LoopRunRecord, maker: WorkerLeaseRecord, checker: WorkerLeaseRecord): string {
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
    ].join('\n');
  }

  public buildMockCheckerCommand(_worktreePath: string, _prompt: string): { command: string; args: string[] } {
    const script = [
      'console.log(JSON.stringify({ verdict: "accepted", notes: "mock checker accepted maker output", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));',
    ].join('\n');
    return {
      command: process.execPath,
      args: ['-e', script],
    };
  }

  public extractCheckerVerdict(stdout: string): CheckerVerdictInput['verdict'] {
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

  public extractCheckerNotes(stdout: string): string {
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

  public mergeGates(existing: LoopGate[], patch: LoopGate[]): LoopGate[] {
    const byName = new Map(existing.map((gate) => [gate.name, gate]));
    for (const gate of patch) {
      byName.set(gate.name, gate);
    }
    return Array.from(byName.values());
  }

  public insertWorkerLease(input: {
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
  }): void {
    this.db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, finding_id, worktree_path,
        branch_name, budget_json, metadata, created_at, updated_at,
        parent_lease_id, spawn_tree_id, depth, spawned_by_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.spawnedByAgentId ?? null
    );
  }

  public updateWorkerLeaseStatus(id: string, status: WorkerLeaseRecord['status'], metadataPatch: Record<string, unknown>): void {
    const existing = this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata?: string } | undefined;
    const metadata = {
      ...(existing ? JSON.parse(existing.metadata || '{}') : {}),
      ...metadataPatch,
    };
    this.db.prepare('UPDATE worker_leases SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(metadata), new Date().toISOString(), id);
  }

  public updateWorkerLeaseRuntime(id: string, runtime: string): void {
    this.db.prepare('UPDATE worker_leases SET runtime = ?, updated_at = ? WHERE id = ?')
      .run(runtime, new Date().toISOString(), id);
  }

  public patchWorkerLeaseMetadata(id: string, metadataPatch: Record<string, unknown>): void {
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

  public getWorkerLease(id: string): WorkerLeaseRecord {
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
    };
  }



  /**
   * Current semaphore limit. Read fresh on every acquire so an operator can tune
   * RUNTIME_MAX_CONCURRENCY at runtime. Default 4 bounds a greedy subtree without
   * starving the rest of the fleet; the per-tree sub-limiter
   * (spawn_trees.max_concurrent_children) further bounds any one swarm.
   */

  /**
   * Acquire a runtime permit, awaiting if the concurrency cap is reached. A
   * queued waiter is rejectable via cancelRuntimePermit (used by stop), so a
   * lease stopped before it ever spawns does not hang the queue.
   */

  /**
   * Release a permit and admit the next queued waiter. Idempotent — safe to call
   * on every exit path of executeRuntimeCommand.
   */

  /**
   * Cancel a permit acquisition for a lease that was stopped before it could
   * spawn. Rejects the queued waiter so executeRuntimeCommand rejects promptly;
   * no active slot is freed (the lease never held one).
   */

  /** Test/diagnostic: how many runtime children are live right now. */
  public runtimeConcurrencyInUse(): number {
    return this.runtimeCommand.runtimeConcurrencyInUse();
  }

  public isWorkerLeaseCancelled(leaseId: string): boolean {
    const lease = this.getWorkerLease(leaseId);
    const stopped = lease.metadata.stop_requested_at;
    const wasStopped = lease.metadata.stopped_by_runner || lease.metadata.runtime_was_cancelled;
    return Boolean(stopped || wasStopped || lease.status === 'cancelled');
  }

  public listWorkerLeases(loopRunId: string): WorkerLeaseRecord[] {
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

  public git(repositoryPath: string, args: string[]): string {
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

  public writeLoopState(runId: string, input: {
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

  public recordLoopEvent(loopRunId: string, eventType: string, level: 'debug' | 'info' | 'warning' | 'error' | 'critical', message: string, metadata: Record<string, unknown>): void {
    // Compress large metadata objects to save storage and tokens
    let metadataStr = JSON.stringify(metadata);
    if (metadataStr.length > 500) {
      try {
        const { ContextCompressionService } = require('./context-compression-service');
        const compressor = new ContextCompressionService(this.db);
        const result = compressor.compress(metadataStr, 'json');
        if (result.ratio < 0.9) {
          metadataStr = JSON.stringify({ _compressed: true, _hash: result.hash, data: result.compressed });
        }
      } catch { /* fallback to uncompressed */ }
    }
    this.db.prepare(`
      INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), loopRunId, eventType, level, message, metadataStr, new Date().toISOString());
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
