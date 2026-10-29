import { mutationCheckEnv } from './test-gap-source-service';
import { assertionStrengthCheck } from './test-assertion-strength';
import { withoutHiddenChecks } from './fail-before-pass-after';
import { deadCodeCheckEnv } from './dead-code-source-service';
import { findingFixCheck, findingFixCheckEnv } from './finding-fix-source';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { LOOP_CATALOG } from '@djimitflo/shared';
import { createError } from '../middleware/error-handler';

import type { Database } from 'better-sqlite3';
import type { ExecutionEngine } from '../execution/execution-engine';
import { AgentAssuranceService } from './agent-assurance-service';
import { SwarmIntelligenceService, type SwarmCapabilityRecord } from './swarm-intelligence-service';
import { mintSpawnToken, resolveSpawnTokenSecret } from './spawn-token';
import { swarmEventBus } from './swarm-event-bus';
import { LoopBudgetService, type EfficiencyMetric } from './loop-budget-service';
import { WorktreeManager } from './worktree-manager';
import { GoalService } from './goal-service';
import { LoopWorkerExecutorService } from './loop-worker-executor-service';
import { RuntimeCommandService } from './runtime-command-service';
import { LoopLifecycleService } from './loop-lifecycle-service';
import { LoopDiscoveryService } from './loop-discovery-service';
import { LoopVerificationService } from './loop-verification-service';
import type { ExecuteWorkerResult } from './loop-worker-executor-service';
import { LoopEventService } from './loop-event-service';
import { LoopRunQueryService } from './loop-run-query-service';
import { WorkerLeaseRepo } from './loop-worker-lease-repo';
import { LoopRecoveryService, RuntimeLeaseRegistry } from './loop-recovery-service';
import { LoopPersistenceService } from './loop-persistence-service';
import { ExperienceRetrievalService } from './experience-retrieval-service';
import { SelfImprovementService } from './self-improvement-service';
import { MAKER_TEMPLATE_RULES_STE, steRulesFor } from './ste-001';
import { extraRepoByPath, extraRepoChecks } from './repo-registry';
import { assignmentContext, assignmentContextMarkdown, type AssignmentContext } from './assignment-context';
import { firstJsonObject } from './model-json';
import { isHighRiskPath } from './diff-capture';
import { recordPolicyViolation } from './policy-violations';
import type {
  LoopName,
  WorkerRole,
  LoopGate,
  LoopRunRecord,
  WorkerLeaseRecord,
  ContinueLoopInput,
  RetryLoopInput,
  SplitLoopInput,
  RuntimeContract,
  RuntimeUsage,
  RuntimeExecutionResult,
  RuntimeStopResult,
  RuntimeProcessHandle,
  RuntimeManifestAction,
  StartDocDriftLoopInput,
  CheckerVerdictInput,
  VerdictActor,
} from './loop-types';
import { isSupersededMaker } from './loop-types';
import type { LoopFinding } from './loop-discovery-service';
import type { GoalRecord, GoalCreateInput, GoalUpdateInput, DecomposedLoopCandidate } from './goal-service';
import { captureReadSet, freshnessMode, type ReadSet } from './evidence-freshness';
import { provisionWarmDeps, type WarmDepsResult } from './maker-warm-deps';
import { checksFailureHint } from './lease-failure';

export type {
  LoopName,
  WorkerRole,
  LoopGate,
  LoopRunRecord,
  WorkerLeaseRecord,
  ContinueLoopInput,
  RetryLoopInput,
  SplitLoopInput,
  RuntimeContract,
  RuntimeUsage,
  RuntimeExecutionResult,
  RuntimeStopResult,
  RuntimeProcessHandle,
  RuntimeManifestAction,
  StartDocDriftLoopInput,
  GoalRecord,
  GoalCreateInput,
  GoalUpdateInput,
  DecomposedLoopCandidate,
  LoopFinding,
};

type RiskClass = 'low' | 'medium' | 'high' | 'critical';

interface LoopContract {
  name: LoopName;
  title: string;
  description: string;
  mode: 'closed';
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  trigger: string[];
  context_sources: string[];
  actions_allowed: string[];
  actions_forbidden: string[];
  verification: string[];
  state: string[];
  escalation: string[];
  stop_conditions: string[];
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

interface ExecuteMakerInput {
  lease_id?: string;
  timeout_ms?: number;
  diff_max_lines?: number;
  skip_permissions?: boolean;
}

interface ExecuteCheckerInput extends ExecuteMakerInput {
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock';
}

interface RunChecksInput {
  lease_id?: string;
  timeout_ms?: number;
  scripts?: string[];
}

const LOOP_NAME = 'doc-drift-and-small-fix-loop';
const DEFAULT_MAX_FINDINGS = 50;
const LOOP_RUNTIME_MANIFEST_POLICY_VERSION = 'loop-runtime-bridge-v1';

const MONOREPO_ROOT = process.cwd().includes('/packages/server')
  ? path.resolve(process.cwd(), '../..')
  : process.cwd();

/**
 * Where worker stdout/stderr evidence lives. Verification checks it exists, so it must outlive the container: prod
 * 2026-09-24 wrote it to the image's /app/.data and lost it on every deploy. Default = next to the database (DB_PATH is on
 * the persistent volume in prod); LOOP_EVIDENCE_ROOT overrides; the repo's .data only when neither is set (local dev).
 */
export function resolveEvidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOOP_EVIDENCE_ROOT) return path.resolve(env.LOOP_EVIDENCE_ROOT);
  if (env.DB_PATH && path.isAbsolute(env.DB_PATH)) return path.join(path.dirname(env.DB_PATH), 'agent-evidence', 'agentic-control-loop-fleet');
  return path.join(MONOREPO_ROOT, '.data', 'agent-evidence', 'agentic-control-loop-fleet');
}
const DEFAULT_EVIDENCE_ROOT = resolveEvidenceRoot();

const CONTROL_DIR = '.djimitflo';
const LOOP_WORK_FILE = 'LOOP_WORK.md';
const ASSIGNMENT_PACKET_FILE = 'ASSIGNMENT_PACKET.json';
const ASSIGNMENT_CONTEXT_FILE = 'ASSIGNMENT_CONTEXT.json';
/** The sensitive-content rule of highRiskReason (finding file + text); also applied to a maker's changed file paths. */
const SENSITIVE_CONTENT = /(auth|oauth|oidc|secret|token|password|credential|infra|terraform|docker|deploy|production|policy|ci\/cd|github actions)/;

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

/**
 * LoopService — facade for the loop subsystem.
 *
 * Sub-services:
 *   - LoopLifecycleService: continue/retry/split loop runs
 *   - LoopWorkerExecutorService: maker/checker worker execution
 *   - LoopVerificationService: gates and certification
 *   - LoopDiscoveryService: finding discovery
 *   - LoopBudgetService: token/wall-clock budgets
 *   - WorktreeManager: git worktree lifecycle
 *   - RuntimeCommandService: runtime process management
 *   - GoalService: goal CRUD
 *   - AgentAssuranceService: agent governance
 *   - SwarmIntelligenceService: task decomposition
 *
 * Decomposition status (Slice 2):
 *   ✅ loop-types.ts extracted (shared types, ~220 regeln)
 *   ✅ Dormant capability detection added
 *   ⏳ LoopEventService — planned (Fase 1, Dag 3)
 *   ⏳ LoopRunRepo — planned (Fase 1, Dag 4-5)
 *
 * Public API: 60 methods → target < 20.
 * Line count: ~2445 → target < 500 (facade only).
 */

/** Y2: the fixed part of every maker assignment; its hash is the 'template' gene of a run's genome (maker-genome.ts). */
export const MAKER_TEMPLATE_RULES = [
  '## Rules',
  '',
  '- Keep the diff small and local to the finding.',
  '- Do not merge, push, deploy, edit secrets, or change policy.',
  '- Install dependencies with `npm ci --legacy-peer-deps` if node_modules is missing; never edit package.json. Lockfile changes are reverted automatically before review.',
  '- Run relevant deterministic checks before handing off to checker.',
  '- Checker approval is required before completion.',
];

/** STE-001: arm 1 gets the Simplified Technical English rules; everyone else (and STE_001_MODE off) today's rules. */
export const makerTemplateRules = (ste?: { arm: 0 | 1 }, checkScripts?: string[]): string[] =>
  (ste?.arm === 1 ? (checkScripts ? steRulesFor(checkScripts) : MAKER_TEMPLATE_RULES_STE) : MAKER_TEMPLATE_RULES);
/**
 * The maker's LOOP_WORK.md text (writeWorkAssignment writes it; a remote maker gets it flattened to one line).
 * TG-001 renders the same text for a frozen task and, for its CONTROLLED arm, leaves out parts that should not matter for
 * solving the task: `ids` (loop run / runtime / finding id lines), `advisory` (past-experience block), `policy` (the fixed
 * maker rules template). Production always renders with nothing omitted.
 */
export type AssignmentOmit = 'ids' | 'advisory' | 'policy';
export function renderWorkAssignment(run: { id: string; loop_name: string }, finding: LoopFinding, runtime: string, advisoryText: string,
  extra: AssignmentContext, options: { nestedSpawnControl?: string; omit?: AssignmentOmit[]; checkScripts?: string[] } = {}): string {
  const omit = new Set(options.omit ?? []);
  return [
    `# ${finding.metadata?.objective_mode ? 'Objective' : run.loop_name} Assignment`,
    '',
    ...(omit.has('ids') ? [] : [`Loop run: ${run.id}`, `Runtime target: ${runtime}`, `Finding: ${finding.id}`]),
    `File: ${finding.file}${finding.line ? `:${finding.line}` : ''}`,
    ...(finding.metadata?.objective_mode && !finding.file.startsWith('(') ? [objectiveScopeLine(finding.file)] : []),
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
    ...(omit.has('advisory') ? [] : ['## Advisory Past Experience', '', advisoryText || 'No matching observed episodes were retrieved.', '']),
    ...assignmentContextMarkdown(extra),
    ...(omit.has('policy') ? [] : makerTemplateRules(extra.ste, options.checkScripts)),
    '',
    // Nested-spawn control block (P1). Only injected when this lease is itself
    // permitted to spawn sub-agents (operator-armed, depth within budget). This
    // is the single path a runtime child uses to spawn children: it shells out
    // to the control endpoint with its scoped token. See prepareNestedLease.
    ...(options.nestedSpawnControl ? [options.nestedSpawnControl, ''] : []),
  ].join('\n');
}

/** The objective-assignment scope line (exported for the STE prompt lint). */
export const objectiveScopeLine = (file: string): string => `Change only this file: ${file}. Do not edit README.md, CONTRIBUTING.md or any other file.`;

/** The fixed instruction lines of every checker / security-checker assignment (exported for the STE prompt lint). */
/** The checker prompt carries at most this many characters of the assignment packet (buildCheckerPrompt). */
export const CHECKER_PACKET_MAX_CHARS = 20_000;

export const CHECKER_INSTRUCTIONS = {
  common: [
    'You are an independent checker. Do not edit files, merge, push, deploy, modify secrets or change policy.',
    'Work only inside your own worktree (the maker\'s changes are already in it); do not read the maker\'s worktree.',
    // prod 09-10 (run 5b91e689): reviewers spent 20–24 of ~30 tool calls on npm ci / a native better-sqlite3 build the
    // container cannot do / apt-get / re-running Stryker, and every step re-sends the whole context: 29 steps × ~36k ≈
    // 1.03M > OPENCODE_MAX_RUN_TOKENS. The check logs sit outside the worktree (opencode denies reading them), so their
    // output is inlined below instead.
    'Do not install dependencies (no npm ci / npm install / npm install-scripts / apt-get / node-gyp), do not build, and do not re-run mutation testing (Stryker, test:mutation*), the full test suite, lint or type-check: the deterministic checks below already ran on exactly this diff and their output is included (the log paths are outside your worktree and not readable). Judge from the diff, the source and those results; if they are missing or contradict the diff, say so in your verdict instead of re-running them.',
  ],
  security: 'You are the separate security checker. Review high-risk paths, related sibling paths, the original failure or exploit, and preserved governance invariants. Do not relax gates. Your verdict is not human approval or permission to merge.',
  checker: 'Your technical verdict is not human approval or permission to merge.',
  tail: ['Review the maker output using the evidence below.', '', 'Return a concise verdict. Prefer JSON on one line:'],
};

const VALID_CHECKER_VERDICTS: string[] = ['accepted', 'needs_revision', 'rejected', 'insufficient_evidence'];

/**
 * P0-4: the attestation recorded on a manual verdict. With an authenticated actor the reviewer IS that user (the body's
 * reviewer string is ignored) and it is the only way to record reviewer_type 'human'. Without an actor (in-process machine
 * callers such as the PR-review webhook) the body attestation is kept as-is, but can never claim 'human' or a user id.
 */
function recordedAttestation(input: CheckerVerdictInput, actor?: VerdictActor): Record<string, unknown> | undefined {
  const reason = input.manual_attestation?.reason;
  if (actor?.id) {
    // P0-4 decision 2: for the authenticated reviewer the request notes are the reason when none is sent (trimmed, 1-2000 chars)
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    const fallback = notes.length > 0 && notes.length <= 2000 ? notes : '';
    return { reviewer: actor.email || actor.id, reviewer_user_id: actor.id, reviewer_type: 'human', reason: reason || fallback };
  }
  if (!input.manual_attestation) return undefined;
  const { reviewer, reviewer_type } = input.manual_attestation;
  return { reviewer, reason, ...(reviewer_type === 'heuristic' ? { reviewer_type } : {}) };
}

export class LoopService {

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
  private events: LoopEventService;
  private queries: LoopRunQueryService;
  private workerLeases: WorkerLeaseRepo;
  private recovery: LoopRecoveryService;
  private persistence: LoopPersistenceService;
  private experience: ExperienceRetrievalService;
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

  constructor(db: Database, evidenceRoot = DEFAULT_EVIDENCE_ROOT, executionEngine?: ExecutionEngine) {
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
    this.events = new LoopEventService(db);
    this.queries = new LoopRunQueryService(db);
    this.workerLeases = new WorkerLeaseRepo(db);
    this.recovery = new LoopRecoveryService(db);
    this.persistence = new LoopPersistenceService(evidenceRoot);
    this.experience = new ExperienceRetrievalService(db);
    this.workerExecutor = new LoopWorkerExecutorService(db, this, executionEngine);
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
  recoverInterruptedRuns(): { interruptedRuns: number; failedLeases: number; settledRuns: number; prunedWorktrees: number } {
    const result = this.recovery.recoverInterruptedRuns();
    const prunedWorktrees = this.pruneOrphanedWorktrees();
    return { ...result, prunedWorktrees };
  }

  resumeInterruptedRun(runId: string, maxResumeAttempts = 3): {
    resumed: boolean;
    boundedFail: boolean;
    resumeAttempt: number;
    requeuedFindings: string[];
    skippedFindings: string[];
  } {
    return this.recovery.resumeInterruptedRun(runId, maxResumeAttempts);
  }

  resumeInterruptedRuns(): { resumed: number; boundedFailed: number; details: Array<{ runId: string; resumed: boolean }> } {
    return this.recovery.resumeInterruptedRuns();
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

  /**
   * Dispatches to a real maker/checker cycle driven by a goal's own
   * objective, instead of a fixed scanner. Built after production evidence
   * showed 10/10 self-improvement goals dispatched via
   * startDocDriftAndSmallFixLoop() produced the byte-identical canned
   * "no findings" result regardless of their actual objective — the
   * scanner never looked at goal content at all. See createObjectiveFinding().
   */
  startObjectiveLoop(input: StartDocDriftLoopInput = {}): LoopRunRecord {
    return this.startLoop({ ...input, loop_name: LOOP_NAME, objective_mode: true });
  }

  startLoop(input: StartDocDriftLoopInput = {}): LoopRunRecord {
    const contract = this.getLoopContract(input.loop_name || LOOP_NAME);
    const goal = input.goal_id ? this.getGoal(input.goal_id) : null;
    if (input.objective_mode && !goal) {
      throw createError(400, 'objective_mode requires a valid goal_id', 'OBJECTIVE_MODE_REQUIRES_GOAL');
    }
    if (goal?.metadata.operator_paused === true) throw createError(409, 'LOOP_OPERATOR_PAUSED', 'LOOP_OPERATOR_PAUSED');
    if (goal) this.goals.assertDependenciesSatisfied(goal.id, goal.metadata);
    const repositoryPath = this.resolveRepositoryPath(input.repository_path || process.cwd());
    const runRiskClass: RiskClass = (goal?.risk_class === 'high' || goal?.risk_class === 'critical' || goal?.risk_class === 'medium' || goal?.risk_class === 'low')
      ? goal.risk_class
      : contract.risk_class;
    const maxFindings = Math.max(1, Math.min(input.max_findings || DEFAULT_MAX_FINDINGS, 200));
    const runId = randomUUID();
    const now = new Date().toISOString();

    const findings = input.target_finding
      ? [this.createTargetFinding(repositoryPath, input.target_finding)]
      : input.objective_mode
        ? [this.createObjectiveFinding(goal!)]
        : this.discoverLoopFindings(contract.name, repositoryPath, maxFindings);
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
    const runStatus = findings.length > 0 ? 'planning' : 'completed';
    const outcome = findings.length > 0 ? 'plan_ready' : 'no_change_required';
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
      runStatus,
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
        outcome,
        risk_class: runRiskClass,
        contract,
        sovereign: input.sovereign === true,
        // Durable record of which finding path produced this run — added
        // after 10/10 self-improvement goals produced identical doc-drift
        // no-ops with no way to distinguish "really nothing to fix" from
        // "was never asked to look at anything real."
        objective_mode: input.objective_mode === true,
      }),
      now,
      now,
      findings.length > 0 ? null : now
    );

    this.recordLoopEvent(runId, findings.length > 0 ? 'loop_planned' : 'loop_completed', 'info', findings.length > 0
      ? `${contract.name} produced ${findings.length} finding(s) for review.`
      : `${contract.name} completed with no changes required.`, {
      loop_name: contract.name,
      finding_count: findings.length,
      state_file: stateFile,
      outcome,
    });

    if (goal) {
      this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
        .run('running', now, goal.id);
      if (findings.length === 0 && this.completeGoalIfSettled(goal.id, runId, now)) {
        const improvementId = typeof goal.metadata?.improvement_id === 'string' ? goal.metadata.improvement_id : null;
        if (improvementId) {
          this.db.prepare("UPDATE self_improvements SET status = 'no_change', updated_at = ? WHERE id = ?").run(now, improvementId);
        }
      }
    }

    return this.getLoopRun(runId);
  }

  assertOperatorNotPaused(run: LoopRunRecord): void {
    if (run.metadata.operator_paused === true || (run.goal_id && this.getGoal(run.goal_id).metadata.operator_paused === true)) {
      throw createError(409, 'LOOP_OPERATOR_PAUSED', 'LOOP_OPERATOR_PAUSED');
    }
  }

  getLoopRun(id: string): LoopRunRecord {
    return this.queries.getById(id);
  }

  listLoopRuns(): LoopRunRecord[] {
    return this.queries.list();
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
    } else if (run.status === 'planning' && run.findings.length > 0 && makerLeases.length === 0) {
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

  private findCapabilityForFinding(finding: LoopFinding, capabilities: SwarmCapabilityRecord[]): SwarmCapabilityRecord | undefined {
    if (!finding.type) return undefined;
    return capabilities.find(capability => capability.id === finding.type)
      || capabilities.find(capability => capability.id.includes(finding.type) || finding.type.includes(capability.id));
  }

  /** Advisory per-finding runtime recommendations; never execution authority. */
  planLoopRun(id: string): Array<{ findingId: string; runtime: string; capabilityId: string }> {
    const run = this.getLoopRun(id);
    const findings = run.findings;
    const plan: Array<{ findingId: string; runtime: string; capabilityId: string }> = [];
    // PERFORMANCE: Batch load capabilities once instead of per-finding N+1
    let allCapabilities: SwarmCapabilityRecord[] = [];
    try {
      const riskRank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
      const requiredRisk = riskRank[String(run.metadata.risk_class || 'low')] ?? 3;
      allCapabilities = this.intelligence.listCapabilities().filter(capability => capability.live_route_allowed
        && capability.allowed_actions.includes('spawn_runtime_worker')
        && !capability.forbidden_actions.includes('spawn_runtime_worker')
        && (riskRank[capability.risk_ceiling] ?? -1) >= requiredRisk);
    } catch { /* best-effort */ }

    for (const finding of findings) {
      const runMeta = run.metadata as Record<string, unknown>;
      let selectedRuntime: string;
      let capabilityId = '';

      if (runMeta.sovereign === true || process.env.PI_OFFLINE === '1') {
        selectedRuntime = 'pi';
      } else {
        const capability = this.findCapabilityForFinding(finding, allCapabilities);
        capabilityId = capability?.id || '';
        selectedRuntime = this.selectRuntimeForCapability(capabilityId);
      }

      plan.push({
        findingId: finding.id,
        runtime: selectedRuntime,
        capabilityId,
      });
    }

    return plan;
  }

  private selectRuntimeForCapability(capabilityId: string): string {
    if (!capabilityId) return 'manual';
    const validRuntimes = ['codex', 'opencode', 'pi', 'claude', 'gemini', 'editor'] as const;
    try {
      // Existing per-runtime completion observations can inform a recommendation.
      // Capability-wide tokens/scores cannot identify a runtime or prove its cost.
      const runtimeData = this.intelligence.measureCompetencePerRuntime(capabilityId);
      const entries = Object.entries(runtimeData);
      if (entries.length > 0) {
        let bestRuntime = entries[0][0];
        let bestScore = -1;
        for (const [runtime, data] of entries) {
          if (!validRuntimes.includes(runtime as typeof validRuntimes[number]) || data.n_runs <= 0
            || !Number.isFinite(data.success_rate) || data.success_rate < 0.3) continue;
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

    return 'manual';
  }

  computeDollarCost(runtime: string, totalTokens: number): number | null {
    return this.budget.computeDollarCost(runtime, totalTokens);
  }

  allocateDollarBudget(
    findings: Array<{ finding_id: string; capability_id: string; p50_dollars: number; competence: number }>,
    budget: number,
  ): { allocated: string[]; deferred: string[]; budgetInsufficient: boolean } {
    return this.budget.allocateDollarBudget(findings, budget);
  }

  computeEfficiencyMetric(runId: string): EfficiencyMetric {
    return this.budget.computeEfficiencyMetric(runId);
  }

  adjustConcurrency(increase: boolean): { success: boolean; dynamicLimit: number; active: number; queueDepth: number } {
    return this.budget.adjustConcurrency(increase);
  }

  async stopLoopRun(id: string): Promise<{ run: LoopRunRecord; events: LoopEventRecord[] }> {
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

    for (const lease of this.listWorkerLeases(id).filter(lease => ['prepared', 'running'].includes(lease.status))) {
      this.updateWorkerLeaseStatus(lease.id, 'cancelled', { stopped_by_runner: true, stopped_at: new Date().toISOString(), cancellation_reason: 'operator_stop' });
      if (!await RuntimeLeaseRegistry.stop(lease.id)) this.runtimeCommand.stopWorkerLeaseRuntime(lease.id);
    }
    void this.experience.indexRun(id);

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
  /**
   * After an approval the engine runs the worker asynchronously; executeWorker() only returns its result once that task is
   * terminal (else LOOP_WORKER_EXECUTION_IN_PROGRESS). Prod 2026-09-25: an auto-approved evolve sibling was read back
   * immediately and recorded as a loss while it was still running. Waits until the lease's engine task is terminal.
   */
  async awaitWorkerExecution(leaseId: string, timeoutMs = 660_000, pollMs = 5_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lease = this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata: string } | undefined;
      const taskId = (JSON.parse(lease?.metadata || '{}') as { execution_task_id?: string }).execution_task_id;
      const status = taskId ? (this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined)?.status ?? null : null;
      if (!status || !['running', 'queued', 'awaiting_approval', 'pending'].includes(status) || Date.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Decide a worker's approval through the engine that paused it (a human decision uses the approvals route). */
  decideWorkerApproval(approvalId: string, approved: boolean, decidedBy: string, reason?: string): Promise<unknown> {
    return this.workerExecutor.decideApproval(approvalId, approved, decidedBy, reason);
  }

  verifyLoopRun(id: string): { run: LoopRunRecord; gates: LoopGate[]; leases: WorkerLeaseRecord[] } {
    return this.verification.verifyLoopRun(id);
  }

  certifyLoopRun(id: string): { run: LoopRunRecord; gates: LoopGate[]; certified: boolean } {
    return this.verification.certifyLoopRun(id);
  }

  completeLoopRun(id: string, input: { human_approval_ref?: string } = {}): { run: LoopRunRecord; gates: LoopGate[] } {
    const current = this.getLoopRun(id);
    if (current.status === 'cancelled') throw new Error('LOOP_COMPLETION_CANCELLED');
    if (current.status === 'completed') return { run: current, gates: current.gates };
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
      // E2: missing evidence is not a failed gate, but it still blocks completion
      const unknownGate = verified.gates.find((gate) => gate.status === 'unknown');
      if (unknownGate) throw new Error(`LOOP_COMPLETION_INSUFFICIENT_EVIDENCE:${unknownGate.name}`);

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
      if (current.goal_id) {
        const goal = this.getGoal(current.goal_id);
        const improvementId = typeof goal.metadata?.improvement_id === 'string' ? goal.metadata.improvement_id : null;
        const goalSettled = this.completeGoalIfSettled(current.goal_id, id, now);
        if (improvementId && goalSettled) {
          this.db.prepare("UPDATE self_improvements SET status = 'verified', updated_at = ? WHERE id = ?").run(now, improvementId);
        }
      }

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

      void this.experience.indexRun(id, {
        certified: true,
        lessons: completedLeases
          .filter((lease) => lease.role === 'checker' || lease.role === 'security_checker')
          .flatMap((lease) => {
            const notes = lease.metadata?.notes;
            return typeof notes === 'string' && notes.trim() ? [notes.trim()] : [];
          }),
      });

      return { run: completedRun, gates: verified.gates };
    }

    throw new Error('LOOP_COMPLETION_NO_WORKERS');
  }

  private completeGoalIfSettled(goalId: string, terminalRunId: string, now: string): boolean {
    const remaining = this.db.prepare(`
      SELECT 1 FROM loop_runs
      WHERE goal_id = ? AND id != ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'escalated')
      LIMIT 1
    `).get(goalId, terminalRunId);
    if (remaining) return false;
    const goal = this.getGoal(goalId);
    const run = this.getLoopRun(terminalRunId);
    const metadata = {
      ...goal.metadata,
      execution_source: 'loop_service',
      executor_runtime: run.metadata?.runtime || 'mixed',
      attempt_count: Number(goal.metadata?.attempt_count || 0) + 1,
      completion_source: 'verified_loop_completion',
      acceptance_evidence: [{
        kind: 'loop_run',
        ref: terminalRunId,
        human_approval_ref: run.metadata?.human_approval_ref,
        gates: run.gates.filter((gate) => gate.status === 'pass').map((gate) => gate.name),
      }],
    };
    this.db.prepare("UPDATE goals SET status = 'completed', metadata = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(metadata), now, goalId);
    return true;
  }

  submitCheckerVerdict(id: string, input: CheckerVerdictInput, actor?: VerdictActor): { run: LoopRunRecord; checker: WorkerLeaseRecord } {
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

    const attestation = recordedAttestation(input, actor);
    if (checker.runtime === 'manual' && (!attestation?.reviewer || !attestation?.reason)) {
      throw new Error('MANUAL_VERDICT_ATTESTATION_REQUIRED');
    }

    this.updateWorkerLeaseStatus(checker.id, 'completed', {
      verdict: input.verdict,
      notes: input.notes || '',
      maker_lease_id: makerLeaseId,
      completed_at: new Date().toISOString(),
      ...(attestation ? { manual_review_attestation: attestation } : {}),
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

  submitSecurityVerdict(id: string, input: CheckerVerdictInput, actor?: VerdictActor): { run: LoopRunRecord; security_checker: WorkerLeaseRecord } {
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

    const attestation = recordedAttestation(input, actor);
    if (securityChecker.runtime === 'manual' && (!attestation?.reviewer || !attestation?.reason)) {
      throw new Error('MANUAL_VERDICT_ATTESTATION_REQUIRED');
    }

    this.updateWorkerLeaseStatus(securityChecker.id, 'completed', {
      verdict: input.verdict,
      notes: input.notes || '',
      maker_lease_id: makerLeaseId,
      completed_at: new Date().toISOString(),
      ...(attestation ? { manual_review_attestation: attestation } : {}),
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

    // Each deploy mounts a fresh clone without node_modules, so the worktree manager has nothing to link: checks ran without
    // vitest/eslint (exit 127) unless the maker happened to run `npm ci` itself (prod 2026-09-28: 3 test-gap runs regressed).
    // Install like the gym does when the worktree has a lockfile but no dependencies.
    const installFailure = this.installWorktreeDependencies(makerLease.worktree_path, outputDir, timeoutMs);

    const checks: Array<Record<string, unknown>> = scripts.map((scriptName) => {
      const stdoutPath = path.join(outputDir, `${scriptName}.stdout.log`);
      const stderrPath = path.join(outputDir, `${scriptName}.stderr.log`);
      if (!packageScripts.has(scriptName)) {
        fs.writeFileSync(stdoutPath, '', 'utf8');
        fs.writeFileSync(stderrPath, `script not present: ${scriptName}\n`, 'utf8');
        // B1 (17-10): a configured check the repo does not have is a failed check, never 'skipped' — a repo without the
        // scripts used to pass with nothing executed (vacuous pass).
        return {
          name: scriptName,
          status: 'fail',
          reason: 'missing_script',
          exit_status: null,
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        };
      }

      const result = spawnSync('npm', ['run', scriptName], {
        cwd: makerLease.worktree_path!,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: { ...this.buildRuntimeEnv(), ...mutationCheckEnv(this.db, run.goal_id), ...deadCodeCheckEnv(this.db, run.goal_id), ...findingFixCheckEnv(this.db, run.goal_id) },
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

    if (installFailure) checks.unshift(installFailure);
    // F1 (09-10): deterministic assertion strength of a test-writing maker's changed test files (WEAK_ASSERTION_CHECK_MODE)
    try {
      const strength = assertionStrengthCheck(this.db, run.goal_id, makerLease.worktree_path!, makerLease.metadata?.changed_files, outputDir);
      if (strength) checks.push(strength);
    } catch { /* an evidence check never breaks the scripted checks */ }
    // G2.2 finding-fix lane: Djimitflo's own gate re-scans the target file; it is a gate, so an exception is a failed check
    try {
      const findingFix = findingFixCheck(this.db, run.goal_id, makerLease.worktree_path!, outputDir);
      if (findingFix) checks.push(findingFix);
    } catch (err) {
      if (Object.keys(findingFixCheckEnv(this.db, run.goal_id)).length) checks.push({ name: 'test:finding-fix', status: 'fail', reason: `gate_error: ${err instanceof Error ? err.message : String(err)}`, exit_status: null });
    }
    const failed = checks.some((check) => check.status === 'fail');
    // Batch-8 evidence freshness: fingerprint what the checks READ (configs, lockfile, imports) at the base commit.
    let evidenceReadSet: ReadSet | undefined;
    if (freshnessMode() !== 'off') {
      try {
        const wt = makerLease.worktree_path!;
        const g = (...a: string[]) => spawnSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).stdout ?? '';
        const changed = [...g('diff', '--name-only').split('\n'), ...g('ls-files', '--others', '--exclude-standard').split('\n')]
          .filter((f) => f && !f.split('/').includes('node_modules'));
        evidenceReadSet = captureReadSet(wt, changed);
      } catch { /* freshness is evidence, never a reason to fail the checks */ }
    }
    // prod 2026-10-01..07: 21 doc-drift makers failed here with no reason ('unspecified: caller supplied no reason')
    this.updateWorkerLeaseStatus(makerLease.id, failed ? 'failed' : 'completed', {
      deterministic_checks: checks,
      checks_completed_at: new Date().toISOString(),
      ...(failed ? { failure_reason: `deterministic_checks_failed:${checks.filter((check) => check.status === 'fail').map((check) => `${check.name}${check.reason ? `(${check.reason})` : check.timed_out ? '(timed_out)' : `(exit=${check.exit_status ?? 'signal'})`}`).join(',')}`,
        failure: checksFailureHint(checks) } : {}),
      ...(evidenceReadSet ? { evidence_read_set: evidenceReadSet } : {}),
    });

    // Feed real build/test failures into the self-improvement pipeline.
    // generateFromBuildErrors() existed but was never called anywhere in
    // production — found 2026-09-20 alongside the discovery that every one
    // of 357 self-improvement proposals came from vague reflection text.
    // A real compiler/test error is exactly the concrete, quotable evidence
    // that pipeline's reviewer gate rewards; this is a side effect of a
    // check failure, not the method's purpose, so it's never allowed to
    // affect the actual deterministic-checks result.
    if (failed) {
      try {
        const summaries = checks
          .filter((check) => check.status === 'fail' && check.reason !== 'missing_script') // a missing script is config, not a code error
          .map((check) => {
            const stderrPath = check.stderr_path as string;
            const stderrTail = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').slice(-1000) : '';
            return `${check.name} failed (exit ${check.exit_status}) for run ${run.id}:\n${stderrTail}`.trim();
          });
        new SelfImprovementService(this.db).generateFromBuildErrors(summaries);
      } catch {
        // Never let self-improvement bookkeeping break the actual checks flow.
      }
    }

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
    this.assertOperatorNotPaused(run);
    const leases = this.listWorkerLeases(run.id);
    const lease = input.lease_id
      ? leases.find((candidate) => candidate.id === input.lease_id)
      : leases.find((candidate) => candidate.role === 'maker' && candidate.status === 'prepared');

    if (!lease) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    if (lease.role !== 'maker' && lease.metadata.nested_spawn !== true) {
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

    // OPS-004: the worker span (one per maker lease, closed at settlement) is owned by the shared executeMaker path
    const execution = await this.executeMaker(id, input);

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
      loops: LOOP_CATALOG.map(({ name }) => this.getLoopContract(name)).map((contract) => ({
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

  private createTargetFinding(repositoryPath: string, target: NonNullable<StartDocDriftLoopInput['target_finding']>): LoopFinding {
    const requestedPath = target.file_path.trim();
    if (!requestedPath || path.isAbsolute(requestedPath)) throw createError(400, 'file_path must be a non-empty relative path', 'FIX_FILE_PATH_INVALID');
    const repositoryRealPath = fs.realpathSync(repositoryPath);
    const repositoryPathPrefix = repositoryRealPath.endsWith(path.sep) ? repositoryRealPath : `${repositoryRealPath}${path.sep}`;
    const resolvedPath = path.resolve(repositoryRealPath, requestedPath);
    if (!resolvedPath.startsWith(repositoryPathPrefix)) {
      throw createError(403, 'file_path must remain inside repository_path', 'FIX_FILE_PATH_OUTSIDE_REPOSITORY');
    }
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch {
      throw createError(404, 'file_path was not found in repository_path', 'FIX_FILE_NOT_FOUND');
    }
    if (!realPath.startsWith(repositoryPathPrefix)) {
      throw createError(403, 'file_path must remain inside repository_path', 'FIX_FILE_PATH_OUTSIDE_REPOSITORY');
    }
    if (!fs.statSync(realPath).isFile()) {
      throw createError(404, 'file_path was not found in repository_path', 'FIX_FILE_NOT_FOUND');
    }
    const description = target.description.trim();
    if (!description) throw createError(400, 'description is required', 'FIX_DESCRIPTION_REQUIRED');
    const severity = target.category === 'security' ? 'error' : target.category === 'bug' ? 'warning' : 'info';
    return {
      id: randomUUID(), type: `targeted_${target.category}_fix`, severity, file: path.relative(repositoryRealPath, realPath),
      message: description, evidence: 'Caller supplied a bounded fix request for this repository file.',
      suggested_fix: description, metadata: { targeted: true, category: target.category },
    };
  }

  /**
   * Synthesizes a LoopFinding from a goal's own free-text objective, instead
   * of running a fixed scanner — the real gap behind 10/10 self-improvement
   * goals ending at identical doc-drift no-ops. No real file_path is
   * required: nothing downstream (writeWorkAssignment, LoopWorkerExecutorService)
   * validates or scopes a diff to finding.file, so a descriptive sentinel is safe.
   */
  private createObjectiveFinding(goal: GoalRecord): LoopFinding {
    const objective = goal.objective.trim();
    if (!objective) throw createError(400, 'goal objective is required for objective-mode findings', 'OBJECTIVE_FINDING_EMPTY');

    // Self-improvement goals only carry a short title as `objective` — the
    // rich description/rationale lives in self_improvements, keyed by
    // metadata.improvement_id (see autonomous-goal-generator.ts).
    const improvementId = typeof goal.metadata.improvement_id === 'string' ? goal.metadata.improvement_id : null;
    const improvement = improvementId
      ? this.db.prepare("SELECT description, rationale, type, source, json_extract(grounding_json, '$.artifactPath') AS artifact FROM self_improvements WHERE id = ?").get(improvementId) as
          { description?: string; rationale?: string; type?: string; source?: string | null; artifact?: string | null } | undefined
      : undefined;

    const severity: LoopFinding['severity'] =
      goal.risk_class === 'high' || goal.risk_class === 'critical' ? 'error'
      : goal.risk_class === 'medium' ? 'warning' : 'info';

    // S4b: proposal text from an origin that is not the internal deterministic gap lane (test-gap, mutation, untested exports,
    // dead code, finding-fix) — Commons replies via reflection, refinement, dream state, feedback, anything unknown — is data
    // for the maker, not instructions: one marked external-content block, JSON-encoded so the text cannot close it. The gap
    // lane keeps its text byte for byte (running experiments compare its prompts).
    const external = improvement && improvement.source !== 'gap_analysis' && (improvement.description || improvement.rationale)
      ? [
          `BEGIN_EXTERNAL_CONTENT source=self_improvement:${String(improvement.source ?? 'unknown').replace(/[^\w:-]/g, '_')} trust=untrusted`,
          JSON.stringify({
            ...(improvement.description ? { original_proposal: improvement.description } : {}),
            ...(improvement.rationale ? { rationale: improvement.rationale } : {}),
          }),
          'END_EXTERNAL_CONTENT',
        ].join('\n')
      : null;
    const evidence = [
      `Self-improvement goal ${goal.id} (source=${String(goal.metadata.source ?? 'unknown')}, risk_class=${goal.risk_class}).`,
      external,
      !external && improvement?.description ? `Original proposal: ${improvement.description}` : null,
      !external && improvement?.rationale ? `Rationale: ${improvement.rationale}` : null,
      goal.constraints.length ? `Constraints: ${goal.constraints.join('; ')}` : null,
    ].filter(Boolean).join('\n');

    return {
      id: randomUUID(),
      type: 'self_improvement_objective',
      severity,
      // EV2 (prod 2026-10-03): every oracle goal said 'repository-wide objective' although its proposal names the file;
      // with a 'doc-drift' header that was enough for makers to edit README/CONTRIBUTING instead of the test
      file: improvement?.artifact || '(repository-wide objective; no single target file)',
      message: objective,
      evidence: evidence || 'No additional evidence beyond the goal objective was available.',
      suggested_fix: goal.acceptance_criteria.length
        ? `Satisfy: ${goal.acceptance_criteria.join('; ')}`
        : objective,
      metadata: {
        objective_mode: true,
        goal_id: goal.id,
        source: goal.metadata.source ?? null,
        improvement_id: improvementId,
        // Force the existing high-risk gate (isHighRiskRun/highRiskReason) for
        // security-typed proposals as defense-in-depth, even though such
        // goals are already excluded from objective-mode dispatch by
        // risk_class in objective-loop-gate.ts.
        category: improvement?.type === 'security' ? 'security' : undefined,
      },
    };
  }

  public assertNoFailedGates(run: LoopRunRecord): void {
    if (run.gates.some((gate) => gate.status === 'fail')) {
      throw new Error('LOOP_FAILED_GATES_BLOCK_CONTINUE');
    }
    if (run.gates.some((gate) => gate.status === 'unknown')) {
      throw new Error('LOOP_INSUFFICIENT_EVIDENCE_BLOCKS_CONTINUE');
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

  public getMakerLeaseBudget(run: LoopRunRecord, input: ContinueLoopInput): { maxMakerWorkers: number; source: 'goal' | 'request' | 'meta' | 'default' } {
    const configured = this.budget.getMakerLeaseBudget(run, input.max_maker_workers);
    const tuning = this.metaOrchestration?.getActiveLoopTuning(run.loop_name);
    return configured.source === 'default' && tuning
      ? { maxMakerWorkers: tuning.recommendedConcurrency, source: 'meta' }
      : configured;
  }

  public getRetryBudget(run: LoopRunRecord, maker: WorkerLeaseRecord, input: RetryLoopInput): { maxRetries: number; source: 'goal' | 'request' | 'lease' | 'default' } {
    return this.budget.getRetryBudget(run, maker, input.max_retries);
  }

  private getFailureThreshold(run: LoopRunRecord): { maxFailureCount: number; source: 'goal' | 'default' } {
    return this.budget.getFailureThreshold(run);
  }

  public getTokenBudget(run: LoopRunRecord): { maxTokens?: number; maxTokensPerWorker?: number; maxTokensPerDiffLine?: number; source: 'goal' | 'meta' | 'none' } {
    const configured = this.budget.getTokenBudget(run);
    const tuning = this.metaOrchestration?.getActiveLoopTuning(run.loop_name);
    // a tuning without maxTokens (no measured token history) is no budget, never an invented cap
    return configured.source === 'none' && tuning?.recommendedBudget.maxTokens !== undefined
      ? { maxTokens: tuning.recommendedBudget.maxTokens, source: 'meta' }
      : configured;
  }

  private getWallClockBudget(run: LoopRunRecord): { maxRuntimeMs?: number; source: 'goal' | 'meta' | 'none' } {
    const configured = this.budget.getWallClockBudget(run);
    const tuning = this.metaOrchestration?.getActiveLoopTuning(run.loop_name);
    return configured.source === 'none' && tuning
      ? { maxRuntimeMs: tuning.recommendedBudget.maxRuntimeMs, source: 'meta' }
      : configured;
  }

  public evaluateTokenBudget(run: LoopRunRecord, runtimeUsage: RuntimeUsage | null, currentLeaseId: string, diffLines?: number): { gate: LoopGate; exhausted: boolean; efficiencyExceeded: boolean; budget: Record<string, unknown> } {
    return this.budget.evaluateTokenBudget(run, runtimeUsage, currentLeaseId, diffLines, this.getTokenBudget(run));
  }

  private sumRuntimeTokens(leases: WorkerLeaseRecord[]): number {
    return leases.reduce((sum, lease) => {
      const usage = lease.metadata.runtime_usage as { total_tokens?: unknown } | undefined;
      const total = Number(usage?.total_tokens);
      return Number.isFinite(total) && total > 0 ? sum + total : sum;
    }, 0);
  }

  public extractRuntimeUsage(stdout: string): RuntimeUsage | null {
    // opencode reports tokens per step (`step_finish` events, `part.tokens`), never as one usage object; the first-match
    // loop below therefore always returned null for opencode (prod 2026-09-25: every skill_outcome had tokens_used 0).
    let steps = 0; let input = 0; let output = 0; let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('"step_finish"')) continue;
      try {
        const tokens = JSON.parse(line.trim())?.part?.tokens as { total?: unknown; input?: unknown; output?: unknown } | undefined;
        if (!tokens) continue;
        steps += 1; input += Number(tokens.input) || 0; output += Number(tokens.output) || 0; total += Number(tokens.total) || 0;
      } catch { /* not a JSON event line */ }
    }
    if (steps > 0 && total > 0) return { prompt_tokens: input, completion_tokens: output, total_tokens: total, usage_source: 'runtime_stdout' };
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
    const run = this.budget.escalateIfFailureThresholdExceeded(runId, reason);
    if (run.status === 'escalated') void this.experience.indexRun(runId);
    return run;
  }



  public recordMakerFailure(runId: string, leaseId: string, reason: string, details: string): void {
    try {
      this.updateWorkerLeaseStatus(leaseId, 'failed', {
        verdict: 'insufficient_evidence',
        exit_status: reason,
        failure_reason: details,
        failed_at: new Date().toISOString(),
        failure: { stage: 'prepare' }, // only called before the runtime starts (missing worktree, manual runtime)
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
    if (this.highRiskReason(run)) return true;
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
    if (finding.metadata?.category === 'security') {
      return 'security_finding_category';
    }
    const haystack = [
      finding.file,
      finding.message,
      finding.evidence,
      finding.suggested_fix,
    ].join(' ').toLowerCase();
    if (SENSITIVE_CONTENT.test(haystack)) {
      return 'sensitive_finding_content';
    }
    return null;
  }

  /**
   * §3d P0 #1: the risk the maker's actual diff carries — the first changed path that matches the finding-content rule
   * above or diff-capture's high/critical path list (CI workflows, Dockerfiles, .env, keys, migrations, lockfiles).
   * Effective risk is the max of this and highRiskReason: it can only raise a run to high, never lower it.
   */
  public changedFilesRiskReason(files: unknown): string | null {
    const hit = (Array.isArray(files) ? files.map(String) : []).find((file) => SENSITIVE_CONTENT.test(file.toLowerCase()) || isHighRiskPath(file));
    return hit ? `sensitive_changed_file:${hit}` : null;
  }

  /**
   * §3d P0 #1, grandfathered by evidence presence: only a maker lease that carries `risk_inputs` (written by runMaker since
   * this rule exists) is classified by its changed files; an older lease keeps the text-only risk, so re-verifying a
   * historical run (daemon step 9, Verify, certification, backlog sync) never flips it.
   */
  public leaseChangedFilesRisk(lease: WorkerLeaseRecord): string | null {
    return lease.metadata?.risk_inputs ? this.changedFilesRiskReason(lease.metadata.changed_files) : null;
  }

  /**
   * §3d P0 #1: a completed maker whose changed files are sensitive gets a security checker when its finding text did not
   * already give it one (the lifecycle creates them before the maker runs, from the text alone). Same lease shape as there.
   */
  public ensureChangedFilesSecurityChecker(run: LoopRunRecord, maker: WorkerLeaseRecord, reason: string): string | null {
    const existing = this.listWorkerLeases(run.id).find((lease) => lease.role === 'security_checker' && lease.metadata.maker_lease_id === maker.id);
    if (existing) return null;
    const id = randomUUID();
    this.insertWorkerLease({
      id, loopRunId: run.id, role: 'security_checker', runtime: 'manual', findingId: maker.finding_id ?? '', worktreePath: null, branchName: null,
      metadata: { maker_lease_id: maker.id, requires_security_review: true, high_risk_reason: reason, risk_source: 'changed_files' }, now: new Date().toISOString(),
    });
    this.recordLoopEvent(run.id, 'security_checker_required', 'warning', `Maker ${maker.id} changed a sensitive file (${reason}); a security checker is required.`,
      { maker_lease_id: maker.id, security_checker_lease_id: id, high_risk_reason: reason });
    return id;
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

  public repairWorktree(repositoryPath: string, worktreePath: string, branchName: string): boolean {
    return this.worktree.repairWorktree(repositoryPath, worktreePath, branchName);
  }

  public createWorktree(repositoryPath: string, runId: string, findingId: string, branchName: string, linkDependencies = true): string {
    return this.worktree.createWorktree(repositoryPath, runId, findingId, branchName, linkDependencies);
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
    this.assertOperatorNotPaused(run);
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
    'DJIMITFLO_OPENCODE_MODEL', 'DJIMITFLO_CLAUDE_MODEL', 'DJIMITFLO_GEMINI_MODEL', 'DJIMITFLO_CLINE_MODEL', 'DJIMITFLO_CLINE_THINKING',
    // Nested-spawn control channel (P1): the child runtime uses these to call back
    // into the server to spawn its own sub-agents. The token is scoped + expiring.
    'DJIMITFLO_CONTROL_URL', 'DJIMITFLO_SPAWN_TOKEN',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'OLLAMA_API_KEY', 'LOCALAI_BASE_URL', 'OLLAMA_BASE_URL', 'OLLAMA_HOST',
    'OPENCODE_OLLAMA_API_KEY', 'OPENCODE_OPENAI_API_KEY', 'OPENCODE_ANTHROPIC_API_KEY', 'OPENCODE_DEEPSEEK_API_KEY',
    'OPENCODE_GEMINI_API_KEY', 'OPENCODE_MOONSHOT_API_KEY', 'OPENCODE_NVIDIA_API_KEY', 'OPENCODE_OPENROUTER_API_KEY', 'OPENCODE_REQUESTY_API_KEY',
  ];

  /** The deterministic checks' install command; MAKER-DEPS-001 arm B runs exactly this before the maker. */
  public static readonly WORKTREE_INSTALL_ARGS = ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'] as const;

  /**
   * MAKER-DEPS-001 arm B (docs/research/di-001/MAKER_DEPS_001_PREREG.md): what the deterministic checks install anyway, done
   * before the maker starts — the checks' own `npm ci` (lockfile + node_modules absent) and the @djimitflo/shared build that
   * test:changed runs first (dist absent). Provenance: lockfile sha256, npm version, command, exit + duration. No registry, no
   * script approval; the lockfile's integrity hashes are the only supply-chain control. Never throws.
   */
  public prepareMakerWorktree(runId: string, leaseId: string, worktree: string, opts: { warmDepsRoot?: string } = {}) {
    const started = Date.now();
    const outputDir = path.join(this.evidenceRoot, runId, 'maker-prepare', leaseId);
    const run = (args: readonly string[], timeout: number) => {
      const t0 = Date.now();
      const r = spawnSync('npm', [...args], { cwd: worktree, encoding: 'utf8', timeout, env: this.buildRuntimeEnv(), maxBuffer: 5 * 1024 * 1024 });
      return { exit: r.status ?? null, ms: Date.now() - t0, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
    };
    const out = { command: `npm ${LoopService.WORKTREE_INSTALL_ARGS.join(' ')}`, npm_version: null as string | null, lockfile_sha256: null as string | null,
      installed: false, install_exit: null as number | null, install_ms: 0, install_failed: false,
      shared_built: false, shared_exit: null as number | null, shared_ms: 0, shared_failed: false, duration_ms: 0,
      // MAKER_WARM_DEPS only (never set for MAKER-DEPS-001 arm B): where node_modules came from
      warm_deps: undefined as WarmDepsResult | undefined };
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const lock = path.join(worktree, 'package-lock.json');
      if (fs.existsSync(lock)) out.lockfile_sha256 = createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
      const v = run(['--version'], 30_000); out.npm_version = v.exit === 0 ? v.stdout.trim() || null : null;
      if (out.lockfile_sha256 && !fs.existsSync(path.join(worktree, 'node_modules'))) {
        const install = () => {
          const r = run(LoopService.WORKTREE_INSTALL_ARGS, 600_000);
          out.install_exit = r.exit; out.install_ms = r.ms;
          fs.writeFileSync(path.join(outputDir, 'install.stdout.log'), r.stdout, 'utf8');
          fs.writeFileSync(path.join(outputDir, 'install.stderr.log'), r.stderr, 'utf8');
          return { exit: r.exit };
        };
        if (opts.warmDepsRoot) {
          try {
            out.warm_deps = provisionWarmDeps(worktree, install, { root: opts.warmDepsRoot }) ?? undefined;
          } catch (err) { // cache bookkeeping failed: the normal path, recorded as such
            if (out.install_exit === null) install();
            out.warm_deps = { deps_source: out.install_exit === 0 ? 'fresh' : 'failed', lockfile_sha256: out.lockfile_sha256, cache_hit: false, cache_stored: false,
              cache_error: `provision_error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, paths: [], ms: 0 };
          }
          if (out.warm_deps?.deps_source === 'cache') out.install_exit = 0;
        } else install();
        out.install_failed = out.install_exit !== 0;
        out.installed = !out.install_failed && fs.existsSync(path.join(worktree, 'node_modules'));
      }
      const shared = path.join(worktree, 'packages', 'shared');
      if (!out.install_failed && fs.existsSync(path.join(shared, 'package.json')) && !fs.existsSync(path.join(shared, 'dist', 'index.js'))) {
        const r = run(['run', 'build', '--workspace=@djimitflo/shared'], 300_000);
        out.shared_exit = r.exit; out.shared_ms = r.ms; out.shared_built = r.exit === 0; out.shared_failed = !out.shared_built;
        if (out.shared_failed) fs.writeFileSync(path.join(outputDir, 'shared-build.stderr.log'), r.stderr, 'utf8');
      }
    } catch { if (out.installed) out.shared_failed = true; else out.install_failed = true; }
    out.duration_ms = Date.now() - started;
    return out;
  }

  /** `npm ci` in a worktree that has a lockfile but no node_modules; returns a failed 'install' check, or null. */
  private installWorktreeDependencies(worktree: string, outputDir: string, timeoutMs: number): Record<string, unknown> | null {
    if (!fs.existsSync(path.join(worktree, 'package-lock.json')) || fs.existsSync(path.join(worktree, 'node_modules'))) return null;
    const result = spawnSync('npm', [...LoopService.WORKTREE_INSTALL_ARGS], {
      cwd: worktree, encoding: 'utf8', timeout: Math.max(timeoutMs, 600_000), env: this.buildRuntimeEnv(), maxBuffer: 5 * 1024 * 1024,
    });
    if (result.status === 0) return null;
    const stdoutPath = path.join(outputDir, 'install.stdout.log');
    const stderrPath = path.join(outputDir, 'install.stderr.log');
    fs.writeFileSync(stdoutPath, result.stdout || '', 'utf8');
    fs.writeFileSync(stderrPath, result.stderr || result.error?.message || '', 'utf8');
    return { name: 'install', status: 'fail', exit_status: result.status ?? null, timed_out: Boolean(result.error?.message.includes('ETIMEDOUT')), stdout_path: stdoutPath, stderr_path: stderrPath };
  }

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
    return isSupersededMaker(lease);
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
      if (lease.role === 'checker' || lease.role === 'security_checker') {
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

  private assignmentContextPath(worktreePath: string): string {
    return path.join(this.controlDir(worktreePath), ASSIGNMENT_CONTEXT_FILE);
  }

  private advisoryAssignmentContext(worktreePath: string, run: LoopRunRecord, finding: LoopFinding): {
    text: string; sha256: string; sources: string[]; advisory: true; independently_reviewed: false;
  } {
    const contextPath = this.assignmentContextPath(worktreePath);
    if (fs.existsSync(contextPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as ReturnType<LoopService['advisoryAssignmentContext']>;
        if (existing?.advisory === true && existing?.independently_reviewed === false
          && typeof existing.text === 'string' && typeof existing.sha256 === 'string'
          && createHash('sha256').update(existing.text).digest('hex') === existing.sha256) return existing;
      } catch { /* regenerate a corrupt local control artifact */ }
    }
    const results = this.experience.retrieveLocalRelevantRuns(
      `${run.loop_name} ${finding.message} ${finding.suggested_fix}`,
      3,
    );
    const text = results.length ? this.experience.formatExperienceContext(results) : '';
    const snapshot = {
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
      sources: results.length ? ['experience_retrieval'] : [],
      advisory: true as const,
      independently_reviewed: false as const,
    };
    fs.writeFileSync(contextPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return snapshot;
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
    const advisoryContext = this.advisoryAssignmentContext(worktreePath, run, finding);
    const extra = assignmentContext(this.db, run, worktreePath, `loop-maker:${run.id}`);
    if (extra.examples.length || extra.rules.length || extra.memory_holdout || extra.ace || extra.ste) {
      this.recordLoopEvent(run.id, 'assignment_context', 'info', `Maker assignment includes ${extra.examples.length} proven example(s) and ${extra.rules.length} rule(s)${extra.memory_holdout ? ' (memory holdout: rules withheld)' : ''}${extra.ace ? ` (ACE-001 arm ${extra.ace.arm})` : ''}${extra.ste ? ` (STE-001 arm ${extra.ste.arm})` : ''}.`,
        { examples: extra.examples, rule_ids: extra.rules.map((r) => r.id), ...(extra.memory_holdout ? { memory_holdout: true } : {}), ...(extra.ace ? { ace_001: extra.ace } : {}), ...(extra.ste ? { ste_001: extra.ste } : {}) });
    }
    // multi-repo: an extra repo's maker is told that repo's check scripts (EXTRA_REPOS_ENABLED=on); djimitflo's text is unchanged
    const repo = extraRepoByPath(run.repository_path);
    const content = renderWorkAssignment(run, finding, runtime, advisoryContext.text, extra, { nestedSpawnControl: options.nestedSpawnControl, ...(repo ? { checkScripts: extraRepoChecks(repo.slug) } : {}) });
    fs.writeFileSync(this.workAssignmentPath(worktreePath), content, 'utf8');
  }

  public writeAssignmentPacket(worktreePath: string, run: LoopRunRecord, finding: LoopFinding, runtime: string, retryAttempt?: number, capabilitiesManifest?: string): string {
    this.ensureControlDir(worktreePath);
    const advisoryContext = this.advisoryAssignmentContext(worktreePath, run, finding);
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
      advisory_context: advisoryContext,
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
    const diff = worktreePath ? this.workingTreeDiff(worktreePath) : '';
    const assignmentPacket = this.checkerAssignmentPacket(run, maker, checker).slice(0, CHECKER_PACKET_MAX_CHARS);
    const stdoutPath = typeof maker.metadata.stdout_path === 'string' ? maker.metadata.stdout_path : '';
    const stderrPath = typeof maker.metadata.stderr_path === 'string' ? maker.metadata.stderr_path : '';
    const checks = this.checkResultsForReviewer(maker.metadata.deterministic_checks);
    return [
      `# ${run.loop_name} ${checker.role === 'security_checker' ? 'Security Checker' : 'Checker'} Assignment`,
      '',
      `Loop run: ${run.id}`,
      `Checker lease: ${checker.id}`,
      `Maker lease: ${maker.id}`,
      '',
      ...CHECKER_INSTRUCTIONS.common,
      checker.role === 'security_checker' ? CHECKER_INSTRUCTIONS.security : CHECKER_INSTRUCTIONS.checker,
      ...CHECKER_INSTRUCTIONS.tail,
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

  /**
   * §3d P0 #2: the packet a reviewer reads lives in the maker's worktree (.djimitflo/, outside changed_files), so the maker
   * could rewrite it unseen. It is used only while it still hashes to the sha256 recorded at lease creation; otherwise the
   * reviewer gets the daemon's copy (or, without one, a withheld notice) and the mismatch is recorded as a loop event and a
   * POLICY_VIOLATION_LOG row. A lease from before the sha256 was recorded reads the file as before.
   */
  private checkerAssignmentPacket(run: LoopRunRecord, maker: WorkerLeaseRecord, checker: WorkerLeaseRecord): string {
    const file = typeof maker.metadata.assignment_packet_file === 'string' ? maker.metadata.assignment_packet_file : '';
    const current = file && fs.existsSync(file) ? fs.readFileSync(file) : null;
    const expected = typeof maker.metadata.assignment_packet_sha256 === 'string' ? maker.metadata.assignment_packet_sha256 : null;
    if (!expected) return current ? current.toString('utf8') : '';
    const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');
    if (current && sha256(current) === expected) return current.toString('utf8');
    const copyPath = typeof maker.metadata.assignment_packet_copy === 'string' ? maker.metadata.assignment_packet_copy : '';
    const copy = copyPath && fs.existsSync(copyPath) ? fs.readFileSync(copyPath) : null;
    const restored = copy && sha256(copy) === expected ? copy.toString('utf8') : null;
    const observed = current ? sha256(current) : null;
    const evidenceRef = `loop_run:${run.id}/lease:${maker.id}/assignment_packet`;
    const description = `assignment packet of maker ${maker.id} changed after it was written (expected sha256 ${expected}, found ${observed ?? 'missing'}); reviewer given ${restored ? 'the daemon copy' : 'no packet'}`;
    this.patchWorkerLeaseMetadata(checker.id, { assignment_packet_integrity: restored ? 'restored_from_daemon_copy' : 'withheld', assignment_packet_evidence_ref: evidenceRef });
    this.recordLoopEvent(run.id, 'assignment_packet_tampered', 'warning', description,
      { maker_lease_id: maker.id, checker_lease_id: checker.id, expected_sha256: expected, observed_sha256: observed, restored_from_daemon_copy: Boolean(restored), evidence_ref: evidenceRef });
    recordPolicyViolation(this.db, { kind: 'assignment_packet_tampered', actor: `maker:${maker.runtime}`, severity: 'high', dedupe_key: maker.id,
      run_id: run.id, lease_id: maker.id, evidence_ref: evidenceRef, description });
    return restored ?? `Assignment packet withheld: the maker's copy no longer matches the sha256 recorded before the maker ran (${expected}) and the daemon copy is unavailable.`;
  }

  /** The maker's deterministic checks for a reviewer: name, status, exit and the ANSI-stripped tail of each log (capped). */
  private checkResultsForReviewer(raw: unknown): string {
    // R2: a shadow-experiment check is never shown to a reviewer
    const checks = Array.isArray(raw) ? withoutHiddenChecks(raw as Array<Record<string, unknown>>) : [];
    if (!checks.length) return 'No deterministic checks recorded.';
    const tail = (file: unknown, max: number): string => {
      if (typeof file !== 'string' || !file) return '';
      try {
        const text = fs.readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
        return text.length > max ? `…${text.slice(-max)}` : text;
      } catch { return ''; }
    };
    return checks.map((check) => {
      const failed = check.status !== 'pass' && check.status !== 'skipped';
      const out = tail(check.stdout_path, 1_200);
      const err = failed ? tail(check.stderr_path, 800) : '';
      // E2: exit 127 is a missing tool (environment, cf. makerFailureClass), not evidence about the change under review
      const status = check.mode === 'shadow' && check.shadow_status ? `shadow ${String(check.shadow_status)}`
        : check.exit_status === 127 ? `${String(check.status)} — tool missing (environment failure, not evidence about the change)` : String(check.status ?? 'unknown');
      return [`### ${String(check.name)}: ${status} (exit=${String(check.exit_status ?? 'n/a')}${check.timed_out ? ', timed out' : ''})`,
        out ? `stdout (tail):\n${out}` : 'stdout: (empty or unavailable)', ...(err ? [`stderr (tail):\n${err}`] : [])].join('\n');
    }).join('\n\n');
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
    return this.parsedCheckerVerdict(stdout) ?? 'insufficient_evidence';
  }

  /** Whether stdout carries a known verdict at all — an explicit insufficient_evidence counts, an absent or invalid one does not. */
  public checkerVerdictParsed(stdout: string): boolean {
    return this.parsedCheckerVerdict(stdout) !== undefined;
  }

  private parsedCheckerVerdict(stdout: string): CheckerVerdictInput['verdict'] | undefined {
    const payload = this.extractCheckerPayload(stdout);
    if (payload) {
      const verdict = String(payload.verdict || payload.checker_verdict || '').trim();
      if (VALID_CHECKER_VERDICTS.includes(verdict)) {
        return verdict as CheckerVerdictInput['verdict'];
      }
    }
    const plainVerdict = stdout.trim().toLowerCase();
    if (['accepted', 'needs_revision', 'rejected'].includes(plainVerdict)) return plainVerdict as CheckerVerdictInput['verdict'];
    return undefined;
  }

  public extractCheckerNotes(stdout: string): string {
    const notes = this.extractCheckerPayload(stdout)?.notes;
    if (typeof notes === 'string') return notes;
    // no verdict object: the reviewer's last text part, not the raw opencode/codex event stream (prod 02-10, lease 09272945)
    const texts = this.runtimeTexts(stdout);
    return (texts.length ? texts[texts.length - 1] : stdout).trim().slice(0, 1_000);
  }

  /** The text parts of an opencode/codex JSON event stream (part.text, agent_message items, result/response), in order. */
  private runtimeTexts(stdout: string): string[] {
    const texts: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const part = parsed.part as Record<string, unknown> | undefined;
        const item = parsed.item as Record<string, unknown> | undefined;
        const text = [parsed, part && typeof part === 'object' ? part : undefined, item?.type === 'agent_message' ? item : undefined]
          .flatMap((candidate) => [candidate?.text, candidate?.result, candidate?.response]).find((value) => typeof value === 'string');
        if (typeof text === 'string' && text.trim()) texts.push(text);
      } catch { continue; }
    }
    return texts;
  }

  /**
   * The checker's verdict object. The LAST valid one wins, so an early plan or draft never shadows the final answer.
   * Within a text part every '{' is tried from last to first with the balanced-object scanner (firstJsonObject), also with
   * one repaired closing brace (prod 2026-09-23: a dropped final brace lost an 'accepted' verdict). That finds a verdict
   * embedded in prose or backticks (prod 02-10, lease 09272945: "`{"verdict":"needs_revision",...}`" mid-paragraph →
   * stored as insufficient_evidence with the raw event stream as notes). Only a known verdict value counts, so the echoed
   * format template ("accepted|needs_revision|…") and nested usage objects are skipped. The explicit verdict is never
   * re-interpreted: an insufficient_evidence whose notes approve stays insufficient_evidence (fails checker_verdict).
   */
  private extractCheckerPayload(stdout: string): Record<string, unknown> | undefined {
    const known = (p: Record<string, unknown> | null | undefined): p is Record<string, unknown> =>
      !!p && VALID_CHECKER_VERDICTS.includes(String(p.verdict ?? p.checker_verdict ?? ''));
    const verdictIn = (full: string): Record<string, unknown> | undefined => {
      const text = full.slice(-20_000); // a final answer, not a tool dump: bounds the per-'{' scan
      for (let start = text.lastIndexOf('{'); start >= 0; start = start > 0 ? text.lastIndexOf('{', start - 1) : -1) {
        const slice = text.slice(start);
        const found = [firstJsonObject(slice), firstJsonObject(`${slice}}`)].find(known);
        if (found) return found;
      }
      return undefined;
    };
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{')).reverse();
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const part = parsed.part;
      const item = parsed.item as Record<string, unknown> | undefined;
      const candidates = [parsed, typeof part === 'object' && part ? part as Record<string, unknown> : undefined,
        item?.type === 'agent_message' ? item : undefined];
      const text = candidates.flatMap((candidate) => [candidate?.text, candidate?.result, candidate?.response]).find((value) => typeof value === 'string');
      const fromText = typeof text === 'string' ? verdictIn(text) : undefined;
      if (fromText) return fromText;
      const payload = candidates.find((candidate) => candidate && (
        typeof candidate.verdict === 'string'
        || typeof candidate.checker_verdict === 'string'
        || typeof candidate.notes === 'string'
      ));
      if (payload) return payload;
    }
    return undefined;
  }

  public mergeGates(existing: LoopGate[], patch: LoopGate[]): LoopGate[] {
    const byName = new Map(existing.map((gate) => [gate.name, gate]));
    for (const gate of patch) {
      byName.set(gate.name, gate);
    }
    return Array.from(byName.values());
  }

  public insertWorkerLease(input: Parameters<WorkerLeaseRepo['insert']>[0]): void {
    this.workerLeases.insert(this.withAssignmentPacketProvenance(input));
  }

  /**
   * §3d P0 #2: a lease is created right after its packet is written and before its maker runs, so this is the packet's
   * sha256 as the daemon wrote it, plus a content-addressed daemon copy outside the worktree (checkerAssignmentPacket).
   */
  private withAssignmentPacketProvenance(input: Parameters<WorkerLeaseRepo['insert']>[0]): Parameters<WorkerLeaseRepo['insert']>[0] {
    const file = input.metadata.assignment_packet_file;
    if (typeof file !== 'string' || input.metadata.assignment_packet_sha256 !== undefined || !fs.existsSync(file)) return input;
    try {
      const content = fs.readFileSync(file);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const copy = path.join(this.evidenceRoot, input.loopRunId, 'assignment-packets', `${sha256}.json`);
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, content);
      return { ...input, metadata: { ...input.metadata, assignment_packet_sha256: sha256, assignment_packet_copy: copy } };
    } catch {
      return input; // unreadable packet: the lease is recorded without provenance and the checker reads the file as before
    }
  }

  public updateWorkerLeaseStatus(id: string, status: WorkerLeaseRecord['status'], metadataPatch: Record<string, unknown> = {}): void {
    this.workerLeases.updateStatus(id, status, metadataPatch);
  }

  public updateWorkerLeaseWorktree(id: string, worktreePath: string, branchName: string): void {
    this.workerLeases.updateWorktree(id, worktreePath, branchName);
  }

  public updateWorkerLeaseRuntime(id: string, runtime: string): void {
    this.workerLeases.updateRuntime(id, runtime);
  }

  public patchWorkerLeaseMetadata(id: string, metadataPatch: Record<string, unknown>): void {
    this.workerLeases.patchMetadata(id, metadataPatch);
  }

  public getWorkerLease(id: string): WorkerLeaseRecord {
    return this.workerLeases.getById(id);
  }

  getWorkerLeasePublic(id: string): WorkerLeaseRecord {
    return this.getWorkerLease(id);
  }

  public listWorkerLeases(loopRunId: string): WorkerLeaseRecord[] {
    return this.workerLeases.listByLoopRun(loopRunId);
  }

  public isWorkerLeaseCancelled(leaseId: string): boolean {
    return this.recovery.isWorkerLeaseCancelled(leaseId);
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

  public git(repositoryPath: string, args: string[]): string {
    return this.persistence.git(repositoryPath, args);
  }

  public workingTreeDiff(repositoryPath: string): string {
    return this.persistence.workingTreeDiff(repositoryPath);
  }

  public titleForFinding(finding: LoopFinding): string {
    return this.persistence.titleForFinding(finding);
  }

  public writeLoopState(runId: string, input: Parameters<LoopPersistenceService['writeLoopState']>[1]): string {
    return this.persistence.writeLoopState(runId, input);
  }

  public recordLoopEvent(loopRunId: string, eventType: string, level: 'debug' | 'info' | 'warning' | 'error' | 'critical', message: string, metadata: Record<string, unknown>): void {
    this.events.recordEvent(loopRunId, eventType, level, message, metadata);
  }

  /**
   * List events for a loop run. Delegates to LoopEventService.
   */
  public listLoopEvents(loopRunId: string): import('./loop-types').LoopEventRecord[] {
    return this.events.listEvents(loopRunId);
  }

  /**
   * Aggregate events by type for a loop run.
   */
  public aggregateLoopEvents(loopRunId: string): import('./loop-event-service').EventAggregation[] {
    return this.events.aggregateEvents(loopRunId);
  }

  /**
   * Get the latest event for a loop run.
   */
  public getLatestLoopEvent(loopRunId: string): import('./loop-types').LoopEventRecord | null {
    return this.events.getLatestEvent(loopRunId);
  }

  /**
   * Count events for a loop run.
   */
  public countLoopEvents(loopRunId: string): number {
    return this.events.countEvents(loopRunId);
  }


}
