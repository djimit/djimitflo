import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { AgentAssuranceService, type CheckpointRecord, type TraceSpanRecord } from './agent-assurance-service';

type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type GoalStatus = 'created' | 'decomposed' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
type LoopRunStatus = 'created' | 'planning' | 'running' | 'verifying' | 'blocked' | 'completed' | 'failed' | 'escalated' | 'cancelled';
type GateStatus = 'pass' | 'fail' | 'skipped';
type WorkerRole = 'planner' | 'maker' | 'checker' | 'security_checker' | 'memory_curator' | 'governance_guard';
type LoopName =
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
}

interface ContinueLoopInput {
  finding_ids?: string[];
  max_assignments?: number;
  max_maker_workers?: number;
  runtime?: 'codex' | 'opencode' | 'manual' | 'mock';
}

interface RetryLoopInput {
  maker_lease_id?: string;
  runtime?: 'codex' | 'opencode' | 'manual' | 'mock';
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

const LOOP_NAME = 'doc-drift-and-small-fix-loop';
const DEFAULT_MAX_FINDINGS = 50;
const MAX_MARKDOWN_FILE_BYTES = 250_000;
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
  private db: Database;
  private evidenceRoot: string;
  private assurance: AgentAssuranceService;

  constructor(db: Database, evidenceRoot = path.resolve(process.cwd(), 'agent-evidence', 'agentic-control-loop-fleet')) {
    this.db = db;
    this.evidenceRoot = evidenceRoot;
    this.assurance = new AgentAssuranceService(db);
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
        risk_class: contract.risk_class,
        contract,
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

    const runtime = input.runtime || 'manual';
    this.assertRuntimeAvailable(runtime);

    const budget = this.getMakerLeaseBudget(run, input);
    const currentMakerLeases = alreadyLeased.filter((lease) => lease.role === 'maker').length;
    if (currentMakerLeases >= budget.maxMakerWorkers || selectedFindings.length > budget.maxMakerWorkers - currentMakerLeases) {
      throw new Error('LOOP_WORKER_BUDGET_EXHAUSTED');
    }

    const now = new Date().toISOString();
    const leases: WorkerLeaseRecord[] = [];

    for (const finding of selectedFindings) {
      const branchName = this.branchNameFor(run.id, finding.id);
      const worktreePath = this.createWorktree(run.repository_path, run.id, finding.id, branchName);
      this.writeWorkAssignment(worktreePath, run, finding, runtime);
      const assignmentPacketFile = this.writeAssignmentPacket(worktreePath, run, finding, runtime);

      const makerLeaseId = randomUUID();
      this.insertWorkerLease({
        id: makerLeaseId,
        loopRunId: run.id,
        role: 'maker',
        runtime,
        findingId: finding.id,
        worktreePath,
        branchName,
        metadata: {
          assignment_file: path.join(worktreePath, 'LOOP_WORK.md'),
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
      runtime,
      budget,
    });

    leases.push(...this.listWorkerLeases(run.id));
    return { run: this.getLoopRun(run.id), leases };
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
    this.writeWorkAssignment(worktreePath, run, finding, runtime);
    const assignmentPacketFile = this.writeAssignmentPacket(worktreePath, run, finding, runtime, retryAttempt);

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
        assignment_file: path.join(worktreePath, 'LOOP_WORK.md'),
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
        status: activeMakerLeases.every((lease) => lease.worktree_path && fs.existsSync(path.join(lease.worktree_path, 'LOOP_WORK.md'))) ? 'pass' : 'fail',
        evidence: 'Every maker worktree must contain LOOP_WORK.md.',
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

    const status: LoopRunStatus = gates.some((gate) => gate.status === 'fail') ? 'blocked' : 'verifying';
    this.db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, updated_at = ?
      WHERE id = ?
    `).run(status, JSON.stringify(gates), new Date().toISOString(), run.id);

    this.recordLoopEvent(run.id, 'loop_verified', status === 'blocked' ? 'warning' : 'info', `Verification gates ${status === 'blocked' ? 'blocked' : 'passed'} for prepared work.`, {
      gates,
    });

    return { run: this.getLoopRun(run.id), gates, leases };
  }

  completeLoopRun(id: string): { run: LoopRunRecord; gates: LoopGate[] } {
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

      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, next_actions_json = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run('completed', JSON.stringify(['Loop completed; ready for human review before merge']), now, now, id);

      this.recordLoopEvent(id, 'loop_completed', 'info', 'Loop run completed after verification gates passed.', {
        gates: verified.gates,
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
      ? this.getLoopRun(run.id)
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
      ? this.getLoopRun(run.id)
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
        env: process.env,
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

  executeMaker(id: string, input: ExecuteMakerInput = {}): { run: LoopRunRecord; lease: WorkerLeaseRecord; gates: LoopGate[]; stdout_path: string; stderr_path: string } {
    const run = this.getLoopRun(id);
    this.assertWallClockBudgetAvailable(run);
    const leases = this.listWorkerLeases(run.id);
    const makerLease = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'maker' && lease.status === 'prepared');

    if (!makerLease) {
      throw new Error('MAKER_LEASE_NOT_FOUND');
    }
    if (makerLease.role !== 'maker') {
      throw new Error('LEASE_NOT_MAKER');
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

    this.updateWorkerLeaseStatus(makerLease.id, 'running', { started_at: new Date().toISOString() });

    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const prompt = fs.readFileSync(path.join(makerLease.worktree_path, 'LOOP_WORK.md'), 'utf8');
    const { command, args } = this.buildRuntimeCommand(makerLease.runtime, makerLease.worktree_path, prompt);
    const result = spawnSync(command, args, {
      cwd: makerLease.worktree_path,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
      maxBuffer: 5 * 1024 * 1024,
    });

    const outputDir = path.join(this.evidenceRoot, run.id, 'worker-output', makerLease.id);
    fs.mkdirSync(outputDir, { recursive: true });
    const stdoutPath = path.join(outputDir, 'stdout.log');
    const stderrPath = path.join(outputDir, 'stderr.log');
    fs.writeFileSync(stdoutPath, result.stdout || '', 'utf8');
    fs.writeFileSync(stderrPath, result.stderr || result.error?.message || '', 'utf8');

    const diff = this.git(makerLease.worktree_path, ['diff', '--', '.']);
    const diffLines = diff ? diff.split(/\r?\n/).filter(Boolean).length : 0;
    const diffMaxLines = Math.max(1, Math.min(input.diff_max_lines || 200, 2_000));
    const exitStatus = typeof result.status === 'number' ? result.status : null;
    const timedOut = Boolean(result.error && ((result.error as any).code === 'ETIMEDOUT' || result.error.message.includes('ETIMEDOUT')));
    const runtimeUsage = this.extractRuntimeUsage(result.stdout || '');
    const tokenBudget = this.evaluateTokenBudget(run, runtimeUsage, makerLease.id);

    const gates: LoopGate[] = [
      {
        name: 'maker_runtime_exit_zero',
        status: exitStatus === 0 && !timedOut ? 'pass' : 'fail',
        evidence: `runtime=${makerLease.runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}`,
      },
      {
        name: 'diff_under_threshold',
        status: diffLines <= diffMaxLines ? 'pass' : 'fail',
        evidence: `${diffLines} changed diff line(s), threshold ${diffMaxLines}.`,
      },
      tokenBudget.gate,
      {
        name: 'no_automatic_merge',
        status: 'pass',
        evidence: 'Maker execution did not merge, push, or deploy.',
      },
    ];

    const failed = gates.some((gate) => gate.status === 'fail');
    const metadataPatch: Record<string, unknown> = {
      completed_at: new Date().toISOString(),
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      diff_lines: diffLines,
      diff_max_lines: diffMaxLines,
      exit_status: exitStatus,
      timed_out: timedOut,
      runtime_adapter: makerLease.runtime,
    };
    if (runtimeUsage) {
      metadataPatch.runtime_usage = runtimeUsage;
    } else {
      metadataPatch.runtime_usage = { usage_source: 'unknown' };
    }

    this.updateWorkerLeaseStatus(makerLease.id, failed ? 'failed' : 'completed', {
      ...metadataPatch,
    });

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

    this.recordLoopEvent(run.id, 'maker_executed', failed ? 'warning' : 'info', `Maker lease ${makerLease.id} ${failed ? 'failed gates' : 'completed'}.`, {
      lease_id: makerLease.id,
      gates,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' },
    });

    if (tokenBudget.exhausted) {
      this.recordLoopEvent(run.id, 'loop_budget_exhausted', 'warning', 'Token budget exhausted by maker runtime usage.', {
        budget_type: 'tokens',
        lease_id: makerLease.id,
        runtime_usage: runtimeUsage,
        token_budget: tokenBudget.budget,
      });
    }

    return {
      run: failed ? this.escalateIfFailureThresholdExceeded(run.id, 'maker_execution_failed') : this.getLoopRun(run.id),
      lease: this.listWorkerLeases(run.id).find((lease) => lease.id === makerLease.id)!,
      gates,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    };
  }

  executeWorker(id: string, input: ExecuteMakerInput = {}): ExecuteWorkerResult {
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

    const execution = this.executeMaker(id, input);
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
          manual: this.probeRuntime('manual'),
          mock: this.probeRuntime('mock'),
          codex: this.probeRuntime('codex'),
          opencode: this.probeRuntime('opencode'),
        },
      })),
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

  private getTokenBudget(run: LoopRunRecord): { maxTokens?: number; maxTokensPerWorker?: number; source: 'goal' | 'none' } {
    if (!run.goal_id) {
      return { source: 'none' };
    }
    const goal = this.getGoal(run.goal_id);
    const maxTokens = Number(goal.budget.max_tokens);
    const maxTokensPerWorker = Number(goal.budget.max_tokens_per_worker);
    return {
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined,
      maxTokensPerWorker: Number.isFinite(maxTokensPerWorker) && maxTokensPerWorker > 0 ? Math.floor(maxTokensPerWorker) : undefined,
      source: 'goal',
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

  private evaluateTokenBudget(run: LoopRunRecord, runtimeUsage: RuntimeUsage | null, currentLeaseId: string): { gate: LoopGate; exhausted: boolean; budget: Record<string, unknown> } {
    const budget = this.getTokenBudget(run);
    if (!budget.maxTokens && !budget.maxTokensPerWorker) {
      return {
        gate: { name: 'token_budget', status: 'skipped', evidence: 'No token budget configured for this goal.' },
        exhausted: false,
        budget,
      };
    }
    if (!runtimeUsage) {
      return {
        gate: { name: 'token_budget', status: 'skipped', evidence: 'Runtime did not report token usage; no estimate was used.' },
        exhausted: false,
        budget,
      };
    }

    const usedBeforeCurrent = this.sumRuntimeTokens(this.listWorkerLeases(run.id).filter((lease) => lease.id !== currentLeaseId));
    const totalAfterCurrent = usedBeforeCurrent + runtimeUsage.total_tokens;
    const perWorkerExceeded = Boolean(budget.maxTokensPerWorker && runtimeUsage.total_tokens > budget.maxTokensPerWorker);
    const totalExceeded = Boolean(budget.maxTokens && totalAfterCurrent > budget.maxTokens);
    const exhausted = perWorkerExceeded || totalExceeded;

    return {
      gate: {
        name: 'token_budget',
        status: exhausted ? 'fail' : 'pass',
        evidence: `runtime_usage=${runtimeUsage.total_tokens}, total_after_current=${totalAfterCurrent}, max_tokens=${budget.maxTokens ?? 'unset'}, max_tokens_per_worker=${budget.maxTokensPerWorker ?? 'unset'}.`,
      },
      exhausted,
      budget: {
        ...budget,
        used_before_current: usedBeforeCurrent,
        total_after_current: totalAfterCurrent,
      },
    };
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
        const usage = parsed.usage || parsed.response?.usage || parsed.token_usage;
        const normalized = this.normalizeRuntimeUsage(usage);
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
    const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens);
    const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens);
    const explicitTotal = Number(usage.total_tokens);
    const calculatedTotal = (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0);
    const totalTokens = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : calculatedTotal;
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
      return null;
    }
    return {
      ...(Number.isFinite(promptTokens) && promptTokens >= 0 ? { prompt_tokens: promptTokens } : {}),
      ...(Number.isFinite(completionTokens) && completionTokens >= 0 ? { completion_tokens: completionTokens } : {}),
      total_tokens: totalTokens,
      usage_source: 'runtime_stdout',
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
    return `agent/loop/${runId.slice(0, 8)}-${findingId.slice(0, 8)}${suffix}`;
  }

  private createWorktree(repositoryPath: string, runId: string, findingId: string, branchName: string): string {
    this.git(repositoryPath, ['rev-parse', '--show-toplevel']);
    const worktreeRoot = process.env.LOOP_WORKTREE_ROOT || path.resolve(repositoryPath, '..', '.djimitflo-loop-worktrees');
    const worktreePath = path.join(worktreeRoot, runId, findingId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    if (fs.existsSync(worktreePath)) {
      return worktreePath;
    }
    try {
      this.git(repositoryPath, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    } catch (error) {
      throw new Error(`WORKTREE_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    return worktreePath;
  }

  private buildRuntimeCommand(runtime: string, worktreePath: string, prompt: string): { command: string; args: string[] } {
    if (runtime === 'mock') {
      const script = [
        'const dir = process.argv[1];',
        'console.log("mock worker completed");',
        'console.log(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));',
      ].join('\n');
      return {
        command: process.execPath,
        args: ['-e', script, worktreePath],
      };
    }
    if (runtime === 'codex') {
      return {
        command: process.env.CODEX_BIN_PATH || 'codex',
        args: ['exec', '--format', 'json', '--dir', worktreePath, prompt],
      };
    }
    if (runtime === 'opencode') {
      return {
        command: process.env.OPENCODE_BIN_PATH || 'opencode',
        args: ['run', '--format', 'json', '--dir', worktreePath, prompt],
      };
    }
    throw new Error('MAKER_RUNTIME_UNSUPPORTED');
  }

  private assertRuntimeAvailable(runtime: string): void {
    const probe = this.probeRuntime(runtime);
    if (!probe.available) {
      throw new Error('RUNTIME_UNAVAILABLE');
    }
  }

  private probeRuntime(runtime: string): { available: boolean; command: string | null; version?: string; reason?: string } {
    if (runtime === 'manual') {
      return { available: true, command: null, version: 'manual' };
    }
    if (runtime === 'mock') {
      return { available: true, command: process.execPath, version: 'mock-runtime' };
    }
    if (runtime !== 'codex' && runtime !== 'opencode') {
      return { available: false, command: null, reason: 'unsupported runtime' };
    }
    const command = runtime === 'codex'
      ? process.env.CODEX_BIN_PATH || 'codex'
      : process.env.OPENCODE_BIN_PATH || 'opencode';
    const timeoutMs = Math.max(100, Math.min(Number(process.env.LOOP_RUNTIME_PROBE_TIMEOUT_MS || 1_000), 5_000));
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    if (result.error) {
      return { available: false, command, reason: result.error.message };
    }
    if (result.status !== 0) {
      return { available: false, command, reason: result.stderr || `exit ${result.status}` };
    }
    return {
      available: true,
      command,
      version: (result.stdout || result.stderr || '').trim() || 'unknown',
    };
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

  private writeWorkAssignment(worktreePath: string, run: LoopRunRecord, finding: LoopFinding, runtime: string): void {
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
    ].join('\n');
    fs.writeFileSync(path.join(worktreePath, 'LOOP_WORK.md'), content, 'utf8');
  }

  private writeAssignmentPacket(worktreePath: string, run: LoopRunRecord, finding: LoopFinding, runtime: string, retryAttempt?: number): string {
    const packetPath = path.join(worktreePath, 'ASSIGNMENT_PACKET.json');
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
      retry_attempt: retryAttempt || 0,
      repository_path: run.repository_path,
      worktree_path: worktreePath,
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
  }): void {
    this.db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, finding_id, worktree_path,
        branch_name, budget_json, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.now
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

  private listWorkerLeases(loopRunId: string): WorkerLeaseRecord[] {
    const rows = this.db.prepare('SELECT * FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at ASC').all(loopRunId) as any[];
    return rows.map((row) => ({
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
    }));
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
