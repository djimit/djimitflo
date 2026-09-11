/**
 * Execution engine - orchestrates task execution, event persistence, and WebSocket broadcasting
 */

import type { Database } from 'better-sqlite3';
import {
  ApprovalRequestType,
  AuditEventType,
  ExecutionEventCreateInput,
  ExecutionEventType,
  LogLevel,
  Task,
  TaskStatus,
  WebSocketEventType,
} from '@djimitflo/shared';
import {
  TaskExecutor,
  ExecutionSession,
  ExecutorKind,
  ExecutionFailureError,
  type ExecutionFailure,
  type ExecutionResult,
} from './types';
import { MockExecutor } from './executors/mock-executor';
import { OpenCodeExecutor } from './executors/opencode-executor';
import { CodexExecutor } from './executors/codex-executor';
import { ClaudeExecutor } from './executors/claude-executor';
import { HermesExecutor } from './executors/hermes-executor';
import { GeminiExecutor } from './executors/gemini-executor';
import { EditorExecutor } from './executors/editor-executor';
import { PiExecutor } from './executors/pi-executor';
import { DeepAgentExecutor } from './executors/deep-agent-executor';
import { DockerSandboxExecutor, DEFAULT_SANDBOX_CONFIG } from './executors/docker-sandbox-executor';
import { CircuitBreakerService } from '../services/circuit-breaker-service';
import { FallbackChainService, ExecutionMode } from '../services/fallback-chain-service';
import { ExecutionModePolicyService } from '../services/execution-mode-policy-service';
import { WebSocketService } from '../services/websocket-service';
import { createHash, randomUUID } from 'crypto';
import { CommandRiskClassifier } from '../services/command-risk-classifier';
import { PolicyDecisionService } from '../services/policy-decision-service';
import { ToolBroker } from '../services/tool-broker';
import { ApprovalService } from '../services/approval-service';
import { GovernanceGateService } from '../services/governance-gate-service';
import { AuditService } from '../services/audit-service';
import { EvidenceService } from '../services/evidence-service';
import { DiffCaptureService } from '../services/diff-capture';
import { MemorySyncService } from '../services/memory-sync-service';
import { ReasoningBankService } from '../services/reasoning-bank-service';
import { RuntimeLeaseRegistry } from '../services/loop-recovery-service';
import { TrajectoryStore } from '../services/trajectory-store';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { SkillLoaderService, type SkillDefinition } from '../services/skill-loader-service';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { canonicalJson, DeepAgentContractIssuer } from '../services/deep-agent-contract-issuer';
import { DennisAgentService } from '../services/dennis-agent-service';
import { EvidenceType, EvidenceSeverity } from '@djimitflo/shared';
import { createError } from '../middleware/error-handler';

export interface ExecuteTaskResult {
  status: 'started' | 'awaiting_approval' | 'denied';
  approvalId?: string;
  reason?: string;
  completion?: Promise<ExecutionResult>;
}

/**
 * Permission bypass is an operator-armed exception, never a task-controlled flag.
 * Keep this guard at the final executor boundary so direct task execution cannot
 * accidentally enable an unsandboxed CLI even when metadata requests it.
 */
export function resolveExecutorSkipPermissions(requested: unknown): boolean {
  return requested === true && process.env.RUNTIME_ALLOW_SKIP_PERMISSIONS === 'true';
}

const RETRYABLE_PROVIDER_ERROR = /(timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|429|5\d\d|rate limit|temporar|unavailable|process exited|exit code)/i;

export class ExecutionEngine {
  private db: Database;
  private wsService: WebSocketService;
  private executors: Map<ExecutorKind, TaskExecutor>;
  private activeSessions: Map<string, ExecutionSession>; // taskId -> session
  private pendingExecutions = new Set<string>();
  private diffContexts: Map<string, { repositoryId: string; repositoryPath: string; preSnapshotId: string | null }>; // taskId -> diff context
  private riskClassifier: CommandRiskClassifier;
  private policyDecisionService: PolicyDecisionService;
  private auditService: AuditService;
  private approvalService: ApprovalService;
  private evidenceService: EvidenceService;
  private governanceGate: GovernanceGateService;
  private diffCaptureService: DiffCaptureService;
  private memorySyncService?: MemorySyncService;
  private reasoningBankService?: ReasoningBankService;
  private trajectoryStore?: TrajectoryStore;
  private metaOrchestration?: MetaOrchestrationService;
  private circuitBreaker: CircuitBreakerService;
  private fallbackChain: FallbackChainService;
  private executionModePolicy: ExecutionModePolicyService;
  private skillEvolution: SkillEvolutionEngine;
  private skillLoader: SkillLoaderService;
  private toolBroker: ToolBroker;
  private runtimeGovernance: RuntimeGovernanceService;
  private deepAgentIssuer?: DeepAgentContractIssuer;

  setMemorySyncService(service: MemorySyncService): void {
    this.memorySyncService = service;
  }

  setReasoningBankService(service: ReasoningBankService): void {
    this.reasoningBankService = service;
  }

  setTrajectoryStore(store: TrajectoryStore): void {
    this.trajectoryStore = store;
  }

  setMetaOrchestration(service: MetaOrchestrationService): void {
    this.metaOrchestration = service;
  }

  getToolBroker(): ToolBroker {
    return this.toolBroker;
  }

  constructor(
    db: Database,
    wsService?: WebSocketService,
    skillsDir?: string,
    runtimeGovernance = new RuntimeGovernanceService(db),
  ) {
    this.db = db;
    this.wsService = wsService || ({
      broadcastTaskEvent: () => {},
      broadcastTaskEventById: () => {},
    } as unknown as WebSocketService);
    this.executors = new Map();
    this.circuitBreaker = new CircuitBreakerService();
    this.fallbackChain = new FallbackChainService();
    this.executionModePolicy = new ExecutionModePolicyService();
    this.skillEvolution = new SkillEvolutionEngine(db);
    this.skillLoader = new SkillLoaderService(db, skillsDir);
    this.activeSessions = new Map();
    this.diffContexts = new Map();
    this.riskClassifier = new CommandRiskClassifier();
    this.policyDecisionService = new PolicyDecisionService(db);
    this.toolBroker = new ToolBroker(db);
    this.auditService = new AuditService(db);
    this.approvalService = new ApprovalService(db, this.wsService, this.auditService);
    this.evidenceService = new EvidenceService(db);
    this.governanceGate = new GovernanceGateService(db);
    this.diffCaptureService = new DiffCaptureService(db);
    this.runtimeGovernance = runtimeGovernance;
    
    // Register default executors
    this.registerExecutor(new MockExecutor());
    this.registerExecutor(new OpenCodeExecutor());
    this.registerExecutor(new CodexExecutor());
    this.registerExecutor(new ClaudeExecutor());
    this.registerExecutor(new HermesExecutor());
    this.registerExecutor(new GeminiExecutor());
    this.registerExecutor(new EditorExecutor());
    this.registerExecutor(new PiExecutor());
    if (process.env.DJIMIT_DEEP_ENABLED === 'true') {
      this.deepAgentIssuer = new DeepAgentContractIssuer();
      this.registerExecutor(new DeepAgentExecutor());
    }
  }
  
  /**
   * Register an executor implementation
   */
  registerExecutor(executor: TaskExecutor): void {
    this.executors.set(executor.kind, executor);
    console.log(`📦 Registered executor: ${executor.kind}`);
  }
  
  /**
   * Get executor by kind
   */
  getExecutor(kind: ExecutorKind): TaskExecutor | undefined {
    return this.executors.get(kind);
  }

  /**
   * Startup-only reconciliation under the existing single-server-per-DB model.
   * Lost JS ownership is NOT proof an external CLI/container has stopped.
   * Never replay work, kill unknown PIDs, or clear an uncertain recovery hold.
   */
  recoverInterruptedTasks(): { failedMockTasks: number; heldTasks: number } {
    const result = { failedMockTasks: 0, heldTasks: 0 };
    const tasks = this.db.prepare("SELECT id, metadata FROM tasks WHERE status = 'running'").all() as Array<{ id: string; metadata: string }>;
    for (const task of tasks) {
      if (this.activeSessions.has(task.id) || this.pendingExecutions.has(task.id)) continue;
      let metadata: Record<string, any>;
      try {
        metadata = JSON.parse(task.metadata || '{}');
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
      } catch { metadata = { execution_recovery_invalid_metadata: true }; }
      const stamp = metadata.execution_recovery_attempt;
      // Correlate the protected stamp with the latest engine-authored admission.
      // Requested model/runtime metadata and legacy uncorrelated logs are not proof.
      const admitted = this.db.prepare(`SELECT id, metadata FROM execution_events WHERE task_id = ?
        AND json_valid(metadata) AND json_extract(metadata, '$.source') = 'execution-engine'
        AND json_extract(metadata, '$.phase') = 'admitted' ORDER BY rowid DESC LIMIT 1`).get(task.id) as { id: string; metadata: string } | undefined;
      const actual = admitted ? JSON.parse(admitted.metadata) : null;
      const safeMock = Boolean(stamp && typeof stamp === 'object' && admitted && actual
        && stamp.event_id === admitted.id && typeof stamp.attempt_id === 'string' && stamp.attempt_id === actual.attempt_id
        && stamp.executorKind === 'mock' && actual.executorKind === 'mock'
        && stamp.inProcess === true && actual.inProcess === true && stamp.sandboxed === false && actual.sandboxed === false);
      const now = new Date().toISOString();
      const status = safeMock ? TaskStatus.FAILED : TaskStatus.PAUSED;
      const reason = safeMock
        ? 'Server ownership was lost; the confirmed in-process mock cannot survive server exit.'
        : 'Server ownership was lost. External execution outcome is unknown; operator reconciliation is required before redispatch.';
      const nextMetadata = { ...metadata, execution_recovery_hold: !safeMock,
        execution_recovery_reason: 'server_restart', execution_recovery_reconciled_at: now,
        execution_recovery_outcome: safeMock ? 'interrupted_in_process' : 'unknown' };
      this.db.transaction(() => {
        this.db.prepare('UPDATE tasks SET status = ?, metadata = ?, failed_at = ?, updated_at = ? WHERE id = ?')
          .run(status, JSON.stringify(nextMetadata), safeMock ? now : null, now, task.id);
        const eventId = this.persistEvent({ task_id: task.id,
          event_type: safeMock ? ExecutionEventType.TASK_FAILED : ExecutionEventType.TASK_PAUSED,
          level: LogLevel.WARNING, message: reason, metadata: { source: 'startup-recovery', outcome: nextMetadata.execution_recovery_outcome } });
        this.auditService.record({ event_type: safeMock ? AuditEventType.TASK_EXECUTED : AuditEventType.EXECUTION_PAUSED,
          action: 'execution_reconciled_after_restart', task_id: task.id, resource_type: 'task', resource_id: task.id,
          execution_event_id: eventId, before: { status: 'running' }, after: { status }, metadata: { outcome: nextMetadata.execution_recovery_outcome, automatic_replay: false } });
        this.evidenceService.captureEvidence({ task_id: task.id, execution_event_id: eventId,
          evidence_type: EvidenceType.EXECUTION_SUMMARY, severity: EvidenceSeverity.WARNING,
          title: 'Execution ownership lost at server restart', summary: reason,
          details: { outcome: nextMetadata.execution_recovery_outcome, automaticReplay: false, externalProcessTerminationConfirmed: false }, source: 'system' });
      })();
      this.wsService.broadcastTaskEvent(this.getTask(task.id), { type: WebSocketEventType.TASK_UPDATED,
        payload: { task: this.getTask(task.id) }, timestamp: now });
      if (safeMock) result.failedMockTasks++; else result.heldTasks++;
    }
    return result;
  }
  
  /**
   * Execute a task
   */
  async executeTask(taskId: string, executorKind: ExecutorKind = 'opencode', dispatcherId?: string): Promise<ExecuteTaskResult> {
    // Check if task is already running
    if (this.activeSessions.has(taskId) || this.pendingExecutions.has(taskId)) {
      throw new Error('Task is already running');
    }
    
    // Load task from database
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!task) {
      throw new Error('Task not found');
    }
    if (task.status === TaskStatus.RUNNING) {
      throw createError(409, 'TASK_RUNNING: Durable running state must be reconciled before redispatch', 'TASK_RUNNING');
    }
    
    // Parse JSON fields
    const parsedTask: Task = {
      ...task,
      tags: JSON.parse(task.tags || '[]'),
      metadata: JSON.parse(task.metadata || '{}'),
    };

    if (parsedTask.metadata.execution_recovery_hold === true) {
      throw createError(409, 'EXECUTION_RECOVERY_REQUIRED: External execution outcome must be reconciled before redispatch', 'EXECUTION_RECOVERY_REQUIRED');
    }

    if (parsedTask.metadata.deep_agent_assurance_hold === true) {
      throw new Error('DEEP_AGENT_ASSURANCE_HOLD: Independent EVE-V assurance is required before redispatch.');
    }

    const latestApproval = this.approvalService.getLatestPendingForTask(taskId, { executionOnly: true });
    if (latestApproval) {
      throw new Error('Task is awaiting approval');
    }

    if (parsedTask.agent_id && !this.runtimeGovernance.isAllowed(parsedTask.agent_id)) {
      const reason = `Agent ${parsedTask.agent_id} is blocked by runtime governance`;
      this.updateTaskStatus(taskId, TaskStatus.CANCELLED);
      this.persistEvent({
        task_id: taskId,
        event_type: ExecutionEventType.ERROR,
        message: reason,
        level: LogLevel.ERROR,
        metadata: { agentId: parsedTask.agent_id, source: 'runtime-governance' },
      });
      return { status: 'denied', reason };
    }

    this.assertTaskLoopNotPaused(parsedTask);
    this.assertAssignedAgentAvailable(parsedTask);

    const attributionBlockReason = this.blockInvalidSkillAttribution(parsedTask);
    if (attributionBlockReason) {
      return { status: 'denied', reason: attributionBlockReason };
    }
    
    // Get executor
    const executor = this.executors.get(executorKind);
    if (!executor) {
      throw new Error(`Executor not found: ${executorKind}`);
    }

    if (executorKind !== 'deep-agent' && !executor.canExecute(parsedTask)) {
      throw new Error(`Executor ${executorKind} cannot execute this task`);
    }

    const assessment = this.riskClassifier.assessTask(parsedTask, executorKind, process.cwd());
    let evaluation = this.policyDecisionService.evaluate(assessment);
    this.persistRiskAssessment(taskId, assessment, `${parsedTask.title}: ${parsedTask.description}`);

    // Governance gate: benchmark evidence can only TIGHTEN the policy decision.
    const gateVerdict = this.governanceGate.assess(parsedTask, executorKind);
    if (gateVerdict.action === 'require_approval' && evaluation.decision === 'allow') {
      evaluation = { ...evaluation, decision: 'require_approval', explanation: gateVerdict.reason };
      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.POLICY_DECISION,
        severity: EvidenceSeverity.WARNING,
        title: 'Governance gate tightened execution to require approval',
        summary: gateVerdict.reason,
        details: {
          agentKey: gateVerdict.agentKey,
          score: gateVerdict.score,
          floor: gateVerdict.floor,
          trend: gateVerdict.trend,
          retirement_candidate: gateVerdict.flagRetirement,
          executorKind,
        },
        source: 'governance-gate',
      });
    }

    if (evaluation.decision === 'deny') {
      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.POLICY_DECISION,
        severity: EvidenceSeverity.CRITICAL,
        title: 'Execution denied by policy',
        summary: evaluation.explanation,
        details: { assessment, matchingPolicies: evaluation.matchingPolicies.map((p) => p.id), decision: 'deny' },
        source: 'policy',
      });
      this.updateTaskStatus(taskId, TaskStatus.CANCELLED);
      this.persistEvent({
        task_id: taskId,
        event_type: ExecutionEventType.ERROR,
        message: `Execution denied by policy. ${evaluation.explanation}`,
        level: LogLevel.ERROR,
        metadata: { assessment, matchingPolicies: evaluation.matchingPolicies.map((policy) => policy.id) },
      });
      this.auditService.record({
        event_type: AuditEventType.EXECUTION_DENIED,
        action: 'execution_denied_by_policy',
        resource_type: 'task',
        resource_id: taskId,
        task_id: taskId,
        risk_level: assessment.risk_level,
        metadata: { explanation: evaluation.explanation },
      });
      this.wsService.broadcastTaskEvent(this.getTask(taskId), {
        type: WebSocketEventType.EXECUTION_DENIED_BY_POLICY,
        payload: { task: this.getTask(taskId) },
        timestamp: new Date().toISOString(),
      });
      return { status: 'denied', reason: evaluation.explanation };
    }

    if (evaluation.decision === 'require_approval' && !this.hasApprovedStart(taskId, executorKind)) {
      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.RISK_ASSESSMENT,
        severity: EvidenceSeverity.WARNING,
        title: 'Execution requires approval',
        summary: evaluation.explanation,
        details: { assessment, matchingPolicies: evaluation.matchingPolicies.map((p) => p.id), decision: 'require_approval' },
        source: 'policy',
      });
      const approval = this.approvalService.createApproval({
        task: parsedTask,
        assessment,
        requestType: ApprovalRequestType.HIGH_RISK_ACTION,
        title: 'Approval required before task execution',
        description: evaluation.explanation,
        policyId: evaluation.matchingPolicies[0]?.id,
        metadata: { executorKind, executionInputHash: this.executionInputHash(parsedTask, executorKind) },
        requestedBy: dispatcherId,
      });
      this.updateTaskStatus(taskId, TaskStatus.AWAITING_APPROVAL);
      this.persistEvent({
        task_id: taskId,
        event_type: ExecutionEventType.APPROVAL_REQUESTED,
        message: evaluation.explanation,
        level: LogLevel.WARNING,
        approval_id: approval.id,
        metadata: { assessment, policyId: evaluation.matchingPolicies[0]?.id || null },
      });
      this.wsService.broadcastTaskEventById(parsedTask.id, {
        type: WebSocketEventType.EXECUTION_PAUSED_FOR_APPROVAL,
        payload: { approval },
        timestamp: new Date().toISOString(),
      });
      this.auditService.record({
        event_type: AuditEventType.EXECUTION_PAUSED,
        action: 'execution_paused_for_approval',
        resource_type: 'task',
        resource_id: taskId,
        task_id: taskId,
        risk_level: assessment.risk_level,
        metadata: { approvalId: approval.id },
      });
      return { status: 'awaiting_approval', approvalId: approval.id, reason: evaluation.explanation };
    }
    
    // Update task status to queued
    this.updateTaskStatus(taskId, TaskStatus.QUEUED);

    this.evidenceService.captureEvidence({
      task_id: taskId,
      evidence_type: EvidenceType.EXECUTION_SUMMARY,
      severity: EvidenceSeverity.INFO,
      title: `Execution admitted to queue (${evaluation.decision})`,
      summary: `Risk: ${assessment.risk_level}. Policy decision: ${evaluation.decision}. Executor: ${executorKind}.`,
      details: { riskLevel: assessment.risk_level, policyDecision: evaluation.decision, executorKind },
      source: 'system',
    });

    // Capture pre-execution git snapshot if task has a repository
    const repositoryId = parsedTask.repository_id || task.repository_id;
    this.capturePreExecutionDiff(taskId, repositoryId);
    
    // Meta-orchestration: predict failure before execution
    if (this.metaOrchestration) {
      const prediction = this.metaOrchestration.predictFailure({
        title: parsedTask.title,
        description: parsedTask.description,
        priority: parsedTask.priority,
        riskLevel: parsedTask.risk_level,
        executionMode: parsedTask.execution_mode,
        tags: parsedTask.tags,
        metadata: parsedTask.metadata as Record<string, unknown>,
      });
      if (prediction.willFail && prediction.confidence > 0.7) {
        this.evidenceService.captureEvidence({
          task_id: taskId,
          evidence_type: EvidenceType.RISK_ASSESSMENT,
          severity: EvidenceSeverity.WARNING,
          title: `Meta-orchestration: predicted failure (${(prediction.confidence * 100).toFixed(0)}% confidence)`,
          summary: prediction.reasons.join('; '),
          details: { prediction },
          source: 'system',
        });
      }
    }

    this.pendingExecutions.add(taskId);
    try {
      await runtimeConcurrencySemaphore.acquire(`execution:${taskId}`);
    } finally {
      this.pendingExecutions.delete(taskId);
    }
    try {
      const currentTask = this.getTask(taskId);
      this.assertTaskLoopNotPaused(currentTask);
      this.assertAssignedAgentAvailable(currentTask);
      if (currentTask.metadata.execution_recovery_hold === true) {
        throw createError(409, 'Task now requires execution recovery', 'EXECUTION_RECOVERY_REQUIRED');
      }
      if (currentTask.metadata.deep_agent_assurance_hold === true) {
        throw createError(409, 'Task now requires independent EVE-V assurance', 'DEEP_AGENT_ASSURANCE_HOLD');
      }
      if (currentTask.status !== TaskStatus.QUEUED) {
        throw createError(409, 'Task state changed while waiting for capacity', 'TASK_EXECUTION_STATE_CHANGED');
      }
      if (this.executionInputHash(parsedTask, executorKind) !== this.executionInputHash(currentTask, executorKind)) {
        throw createError(409, 'TASK_EXECUTION_INPUT_CHANGED: Task changed while waiting for capacity; request execution again', 'TASK_EXECUTION_INPUT_CHANGED');
      }

      // Task bytes alone do not bind mutable policy or governance evidence.
      // Reassess at admission after the asynchronous capacity wait, before any
      // provider starts; a tighter decision requires a new explicit request.
      const currentAssessment = this.riskClassifier.assessTask(currentTask, executorKind, process.cwd());
      let currentEvaluation = this.policyDecisionService.evaluate(currentAssessment);
      const currentGate = this.governanceGate.assess(currentTask, executorKind);
      if (currentGate.action === 'require_approval' && currentEvaluation.decision === 'allow') {
        currentEvaluation = { ...currentEvaluation, decision: 'require_approval', explanation: currentGate.reason };
      }
      this.persistRiskAssessment(taskId, currentAssessment, `${currentTask.title}: ${currentTask.description}`);
      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.POLICY_DECISION,
        severity: currentEvaluation.decision === 'deny' ? EvidenceSeverity.CRITICAL
          : currentEvaluation.decision === 'require_approval' ? EvidenceSeverity.WARNING : EvidenceSeverity.INFO,
        title: 'Execution admission revalidated after capacity wait',
        summary: currentEvaluation.explanation,
        details: { previousDecision: evaluation.decision, decision: currentEvaluation.decision,
          riskLevel: currentAssessment.risk_level, governanceAction: currentGate.action,
          matchingPolicyIds: currentEvaluation.matchingPolicies.map(policy => policy.id), executorKind },
        source: 'queue-admission',
      });
      if (currentEvaluation.decision === 'deny') {
        throw createError(409, 'Execution denied by current policy after capacity wait', 'EXECUTION_POLICY_DENIED');
      }
      if (currentEvaluation.decision === 'require_approval' && !this.hasApprovedStart(taskId, executorKind)) {
        throw createError(409, 'Execution approval is no longer current; request execution again', 'EXECUTION_APPROVAL_STALE');
      }
      if (executorKind === 'deep-agent') {
        if (!this.deepAgentIssuer) throw new Error('Deep Agent Federation issuer is unavailable');
        parsedTask.metadata.deep_agent_contract = this.deepAgentIssuer.issue(parsedTask, dispatcherId || '');
        this.db.prepare("UPDATE tasks SET metadata = json_remove(COALESCE(metadata, '{}'), '$.deep_agent_contract') WHERE id = ?").run(taskId);
        if (!executor.canExecute(parsedTask)) throw new Error('Executor deep-agent cannot execute this task');
      }
      const workingDirectory = (parsedTask.metadata as Record<string, unknown> | undefined)?.workingDirectory as string | undefined;
      const mode = (parsedTask.metadata?.executionMode as ExecutionMode) || 'standard';
      const maxRetries = this.executionModePolicy.getConfig(mode).maxRetries;
      const session = await this.startExecutionAttempt(parsedTask, executorKind, mode, 0, maxRetries, workingDirectory);
      const completion = session.closed ? session.result.then(
        async result => { await session.closed; return result; },
        async error => { await session.closed; throw error; },
      ) : session.result;
      return { status: 'started', completion };
    } catch (error) {
      runtimeConcurrencySemaphore.release(`execution:${taskId}`);
      // Preserve an explicit operator cancellation/pause observed at admission.
      if (![TaskStatus.CANCELLED, TaskStatus.PAUSED].includes(this.getTask(taskId).status)) {
        this.updateTaskStatus(taskId, TaskStatus.FAILED, {
          failed_at: new Date().toISOString(),
        });
      }
      throw error;
    }
  }

  private assertTaskLoopNotPaused(task: Task): void {
    const loopIds = new Set<string>();
    // Resolve server-owned pointers as well: old clients could previously erase
    // the task's editable metadata, but cannot detach its canonical worker.
    const workers = this.db.prepare(`SELECT loop_run_id FROM worker_leases
      WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.execution_task_id') = ?`)
      .all(task.id) as Array<{ loop_run_id: string }>;
    for (const worker of workers) loopIds.add(worker.loop_run_id);
    if (typeof task.metadata.loop_run_id === 'string') loopIds.add(task.metadata.loop_run_id);
    if (typeof task.metadata.lease_id === 'string') {
      const lease = this.db.prepare('SELECT loop_run_id FROM worker_leases WHERE id = ?').get(task.metadata.lease_id) as { loop_run_id: string } | undefined;
      if (lease) loopIds.add(lease.loop_run_id);
    }
    for (const loopId of loopIds) {
      const run = this.db.prepare(`SELECT r.metadata AS run_metadata, g.metadata AS goal_metadata
        FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id WHERE r.id = ?`).get(loopId) as { run_metadata: string; goal_metadata: string | null } | undefined;
      if (!run) continue;
      if (JSON.parse(run.run_metadata || '{}').operator_paused !== true
        && JSON.parse(run.goal_metadata || '{}').operator_paused !== true) continue;
      this.persistEvent({ task_id: task.id, event_type: ExecutionEventType.ERROR, level: LogLevel.ERROR,
        message: 'Loop execution is paused by its operator', metadata: { source: 'loop-dispatch-admission', loopRunId: loopId } });
      throw createError(409, 'LOOP_OPERATOR_PAUSED: Resume the operator-paused goal before dispatch', 'LOOP_OPERATOR_PAUSED');
    }
  }

  private assertAssignedAgentAvailable(task: Task): void {
    if (!task.agent_id) return;
    const agent = this.db.prepare('SELECT status, retired_at FROM agents WHERE id = ?').get(task.agent_id) as { status: string; retired_at: string | null } | undefined;
    const reason = !agent
      ? `Assigned agent ${task.agent_id} no longer exists`
      : agent.retired_at
        ? `Assigned agent ${task.agent_id} is retired`
      : !['idle', 'active'].includes(agent.status)
        ? `Assigned agent ${task.agent_id} cannot dispatch while ${agent.status}`
        : !this.runtimeGovernance.isAllowed(task.agent_id)
          ? `Assigned agent ${task.agent_id} is blocked by runtime governance`
          : null;
    if (!reason) return;
    this.persistEvent({ task_id: task.id, event_type: ExecutionEventType.ERROR,
      level: LogLevel.ERROR, message: reason,
      metadata: { source: 'agent-dispatch-admission', agentId: task.agent_id, agentStatus: agent?.status ?? 'missing' } });
    throw createError(409, reason, 'AGENT_UNAVAILABLE');
  }

  private async startExecutionAttempt(
    task: Task,
    executorKind: ExecutorKind,
    mode: ExecutionMode,
    attempt: number,
    maxRetries: number,
    workingDirectory?: string,
  ): Promise<ExecutionSession> {
    // Capacity waits and fallback attempts are new admission boundaries: an
    // agent can be paused, retired or quarantined after the initial request.
    this.assertTaskLoopNotPaused(task);
    this.assertAssignedAgentAvailable(task);
    const executor = this.executors.get(executorKind);
    if (!executor || !executor.canExecute(task)) {
      throw new Error(`Executor ${executorKind} cannot execute this task`);
    }
    if (!this.circuitBreaker.canExecute(executorKind)) {
      if (executorKind === 'deep-agent') throw new Error('Deep Agent circuit breaker is open; fallback is forbidden');
      const fallback = this.fallbackChain.getNextAvailable(executorKind, mode, this.circuitBreaker);
      if (!fallback || attempt >= maxRetries) throw new Error(`No fallback available for ${executorKind}`);
      return this.startExecutionAttempt(task, fallback, mode, attempt + 1, maxRetries, workingDirectory);
    }
    if (attempt > 0 && !this.fallbackAdmitted(task, executorKind)) {
      throw new Error(`Fallback executor ${executorKind} was not admitted by policy`);
    }

    const sandboxMeta = (task.metadata?.sandbox ?? {}) as Record<string, unknown>;
    if (executorKind === 'deep-agent' && sandboxMeta.enabled === true) {
      throw new Error('Deep Agent sandboxing is controlled by the sovereign runtime');
    }
    const activeExecutor = sandboxMeta.enabled === true
      ? new DockerSandboxExecutor(executor, {
          ...DEFAULT_SANDBOX_CONFIG,
          image: (sandboxMeta.image as string) || DEFAULT_SANDBOX_CONFIG.image,
          cpuLimit: (sandboxMeta.cpuLimit as string) || DEFAULT_SANDBOX_CONFIG.cpuLimit,
          memoryLimit: (sandboxMeta.memoryLimit as string) || DEFAULT_SANDBOX_CONFIG.memoryLimit,
          networkMode: (sandboxMeta.networkMode as 'none' | 'bridge' | 'host') || DEFAULT_SANDBOX_CONFIG.networkMode,
          bindMounts: (sandboxMeta.bindMounts as Array<{ host: string; container: string; mode: 'ro' | 'rw' }>) || DEFAULT_SANDBOX_CONFIG.bindMounts,
        })
      : executor;

    try {
      const executionMetadata = task.metadata as Record<string, unknown>;
      if (executionMetadata.model !== undefined && (typeof executionMetadata.model !== 'string' || !executionMetadata.model.trim() || executionMetadata.model.length > 200)) {
        throw new Error('INVALID_EXECUTION_MODEL');
      }
      const reasoningEffort = executionMetadata.reasoningEffort;
      if (reasoningEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(reasoningEffort))) {
        throw new Error('INVALID_REASONING_EFFORT');
      }
      const codexSandbox = executionMetadata.codexSandbox;
      if (codexSandbox !== undefined && !['read-only', 'workspace-write'].includes(String(codexSandbox))) {
        throw new Error('INVALID_CODEX_SANDBOX');
      }
      // Record the actual attempt before any external start, including fallback
      // and sandbox selection. This is provenance, not durable process ownership.
      const admission = { source: 'execution-engine', phase: 'admitted', attempt_id: randomUUID(),
        executorKind: activeExecutor.kind, inProcess: activeExecutor instanceof MockExecutor,
        sandboxed: sandboxMeta.enabled === true };
      this.db.transaction(() => {
        const eventId = this.persistEvent({ task_id: task.id, event_type: ExecutionEventType.LOG,
          level: LogLevel.INFO, message: 'Execution attempt admitted; process start not yet confirmed', metadata: admission });
        this.db.prepare(`UPDATE tasks SET status = 'running', metadata = json_set(COALESCE(metadata, '{}'),
          '$.execution_recovery_attempt', json(?)), updated_at = ? WHERE id = ?`)
          .run(JSON.stringify({ ...admission, event_id: eventId }), new Date().toISOString(), task.id);
      })();
      const session = await activeExecutor.start(task, {
        ...(executionMetadata.model ? { model: String(executionMetadata.model) } : {}),
        ...(reasoningEffort ? { reasoningEffort: reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
        ...(codexSandbox ? { codexSandbox: codexSandbox as 'read-only' | 'workspace-write' } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(executionMetadata.environment ? { environment: executionMetadata.environment as Record<string, string> } : {}),
        ...(executionMetadata.timeoutMs ? { timeout: Number(executionMetadata.timeoutMs) } : {}),
        ...(resolveExecutorSkipPermissions(executionMetadata.skipPermissions) ? { skipPermissions: true } : {}),
      });
      this.activeSessions.set(task.id, session);
      const leaseId = task.metadata.lease_id;
      if (typeof leaseId === 'string') {
        const lease = this.db.prepare("SELECT id FROM worker_leases WHERE id = ? AND json_extract(metadata, '$.execution_task_id') = ?").get(leaseId, task.id);
        if (lease) {
          const unregister = RuntimeLeaseRegistry.register(leaseId, async () => {
            if (this.activeSessions.get(task.id) === session) await this.cancelTask(task.id);
          });
          const cleanup = async () => { if (session.closed) await session.closed; unregister(); };
          void session.result.then(cleanup, cleanup);
        }
      }
      this.updateTaskStatus(task.id, TaskStatus.RUNNING, {
        started_at: session.startedAt.toISOString(),
      });
      this.persistEvent({
        task_id: task.id,
        event_type: 'log' as any,
        message: `Execution attempt ${attempt + 1} started with ${executorKind}`,
        level: 'info' as any,
        metadata: { attempt: attempt + 1, executorKind, maxRetries },
      });
      this.processEventStream(session).catch((error) => {
        console.error(`Error processing event stream for task ${task.id}:`, error);
      });
      session.result.then((result) => {
        void this.handleAttemptResult(task, session, result, mode, attempt, maxRetries, workingDirectory);
      }).catch((error: unknown) => {
        void this.handleAttemptFailure(
          task,
          session,
          this.normalizeFailure(error, true, session.executorKind),
          mode,
          attempt,
          maxRetries,
          workingDirectory,
        );
      });
      return session;
    } catch (error) {
      this.circuitBreaker.recordFailure(executorKind);
      const failure = this.normalizeFailure(error, false, executorKind);
      const fallback = this.nextRetryExecutor(executorKind, mode, attempt, maxRetries, failure);
      if (!fallback) throw new ExecutionFailureError(failure);
      this.persistFallbackEvent(task.id, executorKind, fallback, attempt + 2, failure);
      return this.startExecutionAttempt(task, fallback, mode, attempt + 1, maxRetries, workingDirectory);
    }
  }

  private async handleAttemptResult(
    task: Task,
    session: ExecutionSession,
    result: ExecutionResult,
    mode: ExecutionMode,
    attempt: number,
    maxRetries: number,
    workingDirectory?: string,
  ): Promise<void> {
    if (session.closed) await session.closed;
    if (session.status === 'cancelled' || this.activeSessions.get(task.id) !== session) return;
    if (result.status === 'completed') {
      this.circuitBreaker.recordSuccess(session.executorKind);
      if (this.trajectoryStore) {
        this.trajectoryStore.recordStep({
          runId: task.id,
          actionType: 'execute',
          capabilityId: task.execution_mode || null,
          runtime: session.executorKind,
          outcome: 'success',
          metadata: { title: task.title, attempt: attempt + 1 },
        });
      }
      this.handleExecutionComplete(task.id, session, result);
      return;
    }
    const failure = result.failure || {
      code: 'EXECUTION_FAILED',
      message: result.error || result.message,
      retryable: false,
      sideEffectsPossible: true,
      failureDomain: session.executorKind,
    };
    if (result.status === 'failed') {
      await this.handleAttemptFailure(task, session, failure, mode, attempt, maxRetries, workingDirectory, result);
      return;
    }
    this.handleExecutionComplete(task.id, session, result);
  }

  private async handleAttemptFailure(
    task: Task,
    session: ExecutionSession,
    failure: ExecutionFailure,
    mode: ExecutionMode,
    attempt: number,
    maxRetries: number,
    workingDirectory?: string,
    failedResult?: ExecutionResult,
  ): Promise<void> {
    if (session.closed) await session.closed;
    if (session.status === 'cancelled' || this.activeSessions.get(task.id) !== session) return;
    this.circuitBreaker.recordFailure(session.executorKind);
    const fallback = this.nextRetryExecutor(session.executorKind, mode, attempt, maxRetries, failure);
    if (fallback) {
      this.persistFallbackEvent(task.id, session.executorKind, fallback, attempt + 2, failure);
      try {
        await this.startExecutionAttempt(task, fallback, mode, attempt + 1, maxRetries, workingDirectory);
        return;
      } catch (fallbackError) {
        failure = this.normalizeFailure(fallbackError, false, fallback);
      }
    }
    if (failedResult) this.handleExecutionComplete(task.id, session, failedResult);
    else this.handleExecutionError(task.id, new ExecutionFailureError(failure), session);
  }

  private nextRetryExecutor(
    current: ExecutorKind,
    mode: ExecutionMode,
    attempt: number,
    maxRetries: number,
    failure: ExecutionFailure,
  ): ExecutorKind | null {
    if (current === 'deep-agent') return null;
    if (attempt >= maxRetries || !failure.retryable || failure.sideEffectsPossible) {
      return null;
    }
    return this.fallbackChain.getNextAvailable(current, mode, this.circuitBreaker);
  }

  private normalizeFailure(
    error: unknown,
    sideEffectsPossible: boolean,
    failureDomain: string,
  ): ExecutionFailure {
    if (error instanceof ExecutionFailureError) return error.failure;
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 'EXECUTOR_ERROR',
      message,
      retryable: !sideEffectsPossible && RETRYABLE_PROVIDER_ERROR.test(message),
      sideEffectsPossible,
      failureDomain,
    };
  }

  private fallbackAdmitted(task: Task, executorKind: ExecutorKind): boolean {
    const assessment = this.riskClassifier.assessTask(task, executorKind, process.cwd());
    const evaluation = this.policyDecisionService.evaluate(assessment);
    this.persistRiskAssessment(task.id, assessment, `${task.title}: ${task.description}`);
    if (evaluation.decision === 'deny') return false;
    return evaluation.decision !== 'require_approval' || this.hasApprovedStart(task.id, executorKind);
  }

  private persistFallbackEvent(taskId: string, from: ExecutorKind, to: ExecutorKind, attempt: number, failure: ExecutionFailure): void {
    this.persistEvent({
      task_id: taskId,
      event_type: 'log' as any,
      message: `Retrying with fallback executor ${to}`,
      level: 'warning' as any,
      metadata: {
        attempt,
        from,
        to,
        reason: failure.message,
        failureCode: failure.code,
        failureDomain: failure.failureDomain,
        retryable: failure.retryable,
        sideEffectsPossible: failure.sideEffectsPossible,
      },
    });
  }

  async handleApprovalDecision(approvalId: string, approved: boolean, decidedBy?: string, reason?: string): Promise<ExecuteTaskResult | null> {
    const approval = this.approvalService.decideApproval(approvalId, approved, decidedBy || 'system', reason);
    if (approval.metadata?.manual_action === true) {
      this.evidenceService.captureEvidence({
        task_id: approval.task_id, approval_id: approvalId,
        evidence_type: EvidenceType.APPROVAL_DECISION,
        severity: approved ? EvidenceSeverity.INFO : EvidenceSeverity.WARNING,
        title: approved ? 'Action approved' : 'Action denied',
        summary: reason || 'Manual action reviewed; execution is not implied.', source: 'approval',
      });
      return null;
    }
    if (!approved) {
      if (approval.metadata?.dennis_action === 'materialize_dry_run') {
        new DennisAgentService(this.db).finalizeDeniedDryRun(approvalId, decidedBy);
      }
      this.evidenceService.captureEvidence({
        task_id: approval.task_id,
        approval_id: approvalId,
        evidence_type: EvidenceType.APPROVAL_DECISION,
        severity: EvidenceSeverity.WARNING,
        title: 'Approval denied',
        summary: reason || 'Approval denied',
        source: 'approval',
      });
      this.updateTaskStatus(approval.task_id, TaskStatus.CANCELLED);
      this.persistEvent({
        task_id: approval.task_id,
        event_type: ExecutionEventType.APPROVAL_DENIED,
        message: reason || 'Approval denied',
        level: LogLevel.WARNING,
        approval_id: approvalId,
      });
      return { status: 'denied', reason: reason || 'Approval denied' };
    }

    if (approval.metadata?.dennis_action === 'materialize_dry_run') {
      new DennisAgentService(this.db).materializeApprovedDryRun(approvalId, decidedBy);
      return null;
    }

    this.evidenceService.captureEvidence({
      task_id: approval.task_id,
      approval_id: approvalId,
      evidence_type: EvidenceType.APPROVAL_DECISION,
      severity: EvidenceSeverity.INFO,
      title: 'Approval granted',
      summary: 'Approval granted. Resuming execution.',
      source: 'approval',
    });
    this.persistEvent({
      task_id: approval.task_id,
      event_type: ExecutionEventType.APPROVAL_GRANTED,
      message: 'Approval granted. Resuming execution.',
      level: LogLevel.INFO,
      approval_id: approvalId,
    });
    this.wsService.broadcastTaskEventById(approval.task_id, {
      type: WebSocketEventType.EXECUTION_RESUMED_AFTER_APPROVAL,
      payload: { approval },
      timestamp: new Date().toISOString(),
    });
    this.auditService.record({
      event_type: AuditEventType.EXECUTION_RESUMED,
      action: 'execution_resumed_after_approval',
      resource_type: 'task',
      resource_id: approval.task_id,
      task_id: approval.task_id,
      risk_level: approval.risk_level,
      metadata: { approvalId },
    });
    const executorKind = (approval.metadata?.executorKind as ExecutorKind | undefined) || 'opencode';
    return this.executeTask(approval.task_id, executorKind, decidedBy);
  }
  
  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<void> {
    const session = this.activeSessions.get(taskId);
    if (!session) {
      throw new Error('Task is not running');
    }
    
    session.status = 'cancelled';
    await session.cancel();
    if (session.closed) await session.closed;
    if (this.activeSessions.get(taskId) !== session) return;
    this.activeSessions.delete(taskId);
    runtimeConcurrencySemaphore.release(`execution:${taskId}`);
    this.diffContexts.delete(taskId);
    
    // Update task status
    this.updateTaskStatus(taskId, TaskStatus.CANCELLED);
    
    // Broadcast cancellation event
    this.wsService.broadcastTaskEvent(this.getTask(taskId), {
      type: WebSocketEventType.TASK_CANCELLED,
      payload: { task: this.getTask(taskId) },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Get active session for a task
   */
  getSession(taskId: string): ExecutionSession | undefined {
    return this.activeSessions.get(taskId);
  }
  
  /**
   * Check if task is running
   */
  isTaskRunning(taskId: string): boolean {
    return this.activeSessions.has(taskId);
  }
  
  /**
   * Process event stream from execution session
   */
  private async processEventStream(session: ExecutionSession): Promise<void> {
    const streamTimeoutMs = Number(process.env.EXECUTION_EVENT_STREAM_TIMEOUT_MS || "300000");
    try {
      const streamDeadline = Date.now() + streamTimeoutMs;
      for await (const event of session.events) {
        if (Date.now() > streamDeadline) {
          const truncatedEvent: ExecutionEventCreateInput = {
            task_id: session.taskId,
            event_type: ExecutionEventType.STREAM_TRUNCATED,
            message: `Execution event stream truncated after ${streamTimeoutMs}ms`,
            level: LogLevel.WARNING,
            metadata: { stream_timeout_ms: streamTimeoutMs, executor_kind: session.executorKind },
          };
          const truncatedEventId = this.persistEvent(truncatedEvent);
          this.broadcastExecutionEvent(session.taskId, truncatedEventId, truncatedEvent);
          break;
        }
        // Persist event to database
        const eventId = this.persistEvent(event);
        
        // Broadcast via WebSocket
        this.broadcastExecutionEvent(session.taskId, eventId, event);
      }
    } catch (error) {
      console.error(`Error in event stream for task ${session.taskId}:`, error);
      throw error;
    }
  }
  
  /**
   * Persist execution event to database
   */
  private persistEvent(event: ExecutionEventCreateInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    
    this.db.prepare(`
      INSERT INTO execution_events (
        id, task_id, event_type, timestamp, message, level,
        tool_name, tool_input, tool_output, tool_error,
        approval_id, artifact_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.task_id,
      event.event_type,
      now, // Use current timestamp
      event.message,
      event.level || 'info',
      event.tool_name || null,
      event.tool_input ? JSON.stringify(event.tool_input) : null,
      event.tool_output ? JSON.stringify(event.tool_output) : null,
      event.tool_error || null,
      event.approval_id || null,
      event.artifact_id || null,
      JSON.stringify(event.metadata || {}),
      now,
      now
    );
    
    return id;
  }
  
  /**
   * Broadcast execution event via WebSocket
   */
  private broadcastExecutionEvent(
    taskId: string,
    eventId: string,
    event: ExecutionEventCreateInput
  ): void {
    // The input deliberately has no timestamp. Use the persisted event's
    // canonical times so WebSocket and REST consumers receive the same record.
    const timestamps = this.db.prepare(`
      SELECT timestamp, created_at, updated_at FROM execution_events WHERE id = ? AND task_id = ?
    `).get(eventId, taskId) as { timestamp: string; created_at: string; updated_at: string };
    this.wsService.broadcastTaskEventById(taskId, {
      type: WebSocketEventType.EXECUTION_EVENT,
      payload: {
        event: {
          id: eventId,
          ...event,
          ...timestamps,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Handle execution completion
   */
  private handleExecutionComplete(
    taskId: string,
    session: ExecutionSession,
    result: any
  ): void {
    if (this.activeSessions.get(taskId) !== session) return;
    this.activeSessions.delete(taskId);
    runtimeConcurrencySemaphore.release(`execution:${taskId}`);
    this.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.executionResult', json(?)) WHERE id = ?")
      .run(JSON.stringify(result), taskId);

    // Capture repository changes before any terminal status or assurance hold.
    this.capturePostExecutionDiff(taskId);

    if (session.executorKind === 'deep-agent' && result.status === 'completed') {
      this.db.prepare(`
        UPDATE tasks SET metadata = json_set(
          COALESCE(metadata, '{}'),
          '$.deep_agent_assurance_hold', json('true'),
          '$.deep_agent_assurance_reason', 'EVE_V_ADAPTER_REQUIRED'
        ) WHERE id = ?
      `).run(taskId);
      this.updateTaskStatus(taskId, TaskStatus.AWAITING_APPROVAL);
      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.POLICY_DECISION,
        severity: EvidenceSeverity.WARNING,
        title: 'Deep Agent completion held for independent assurance',
        summary: 'Executor success is not promotion authority; the authenticated EVE-V adapter is not installed.',
        details: { executorKind: session.executorKind },
        source: 'system',
      });
      this.persistEvent({
        task_id: taskId,
        event_type: ExecutionEventType.LOG,
        message: 'Deep Agent execution completed but authoritative task completion is on HOLD.',
        level: LogLevel.WARNING,
        metadata: { executor: session.executorKind, reason: 'EVE_V_ADAPTER_REQUIRED' },
      });
      return;
    }
    
    const completedAt = new Date().toISOString();
    const executionTimeMs = Date.now() - session.startedAt.getTime();
    
    if (result.status === 'completed') {
      this.updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        completed_at: completedAt,
        execution_time_ms: executionTimeMs,
        token_usage: result.metrics?.tokenUsage || null,
      });

      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.EXECUTION_SUMMARY,
        severity: EvidenceSeverity.INFO,
        title: 'Task completed successfully',
        summary: `Completed in ${executionTimeMs}ms${result.metrics?.tokenUsage ? `, ${result.metrics.tokenUsage} tokens` : ''}.`,
        details: { durationMs: executionTimeMs, tokenUsage: result.metrics?.tokenUsage },
        source: 'executor',
      });
      
      this.wsService.broadcastTaskEvent(this.getTask(taskId), {
        type: WebSocketEventType.TASK_COMPLETED,
        payload: { task: this.getTask(taskId) },
        timestamp: new Date().toISOString(),
      });

      // Trigger memory sync (OKF + UAMS + Qdrant) after successful completion
      if (this.memorySyncService) {
        this.memorySyncService.onTaskCompleted(taskId).catch((err: any) => {
          console.warn(`Memory sync failed for task ${taskId}:`, err?.message || err);
        });
      }
      // Trigger reasoning bank (OKF memory + Qdrant reasoning collection)
      if (this.reasoningBankService) {
        this.reasoningBankService.recordReasoning(taskId).catch((err: any) => {
          console.warn(`Reasoning bank failed for task ${taskId}:`, err?.message || err);
        });
      }
      this.recordSkillOutcome(taskId, session, true, executionTimeMs, result.metrics?.tokenUsage || 0);
    } else if (result.status === 'failed') {
      this.updateTaskStatus(taskId, TaskStatus.FAILED, {
        failed_at: completedAt,
        execution_time_ms: executionTimeMs,
      });

      this.evidenceService.captureEvidence({
        task_id: taskId,
        evidence_type: EvidenceType.ERROR,
        severity: EvidenceSeverity.ERROR,
        title: 'Task execution failed',
        summary: `Failed after ${executionTimeMs}ms.`,
        details: { durationMs: executionTimeMs },
        source: 'executor',
      });

      this.wsService.broadcastTaskEvent(this.getTask(taskId), {
        type: WebSocketEventType.TASK_FAILED,
        payload: { task: this.getTask(taskId) },
        timestamp: new Date().toISOString(),
      });
      this.recordSkillOutcome(taskId, session, false, executionTimeMs, result.metrics?.tokenUsage || 0);
    }

    // Meta-orchestration: record outcome for learning
    if (this.metaOrchestration) {
      const task = this.getTask(taskId);
      this.metaOrchestration.recordOutcome({
        taskId,
        taskType: task?.execution_mode || 'coding',
        title: task?.title || '',
        description: task?.description || '',
        provider: 'litellm',
        model: session.executorKind || 'mock',
        runtime: session.executorKind || 'mock',
        success: result.status === 'completed',
        durationMs: executionTimeMs,
        costDollars: result.metrics?.costDollars || 0,
        tags: task?.tags || [],
        metadata: { riskLevel: task?.risk_level },
      });
    }
  }
  
  /**
   * Handle execution error
   */
  private handleExecutionError(taskId: string, error: Error, session?: ExecutionSession): void {
    if (session && this.activeSessions.get(taskId) !== session) return;
    this.activeSessions.delete(taskId);
    runtimeConcurrencySemaphore.release(`execution:${taskId}`);

    // Capture post-execution diff even on error (changes may have been made)
    this.capturePostExecutionDiff(taskId);

    this.updateTaskStatus(taskId, TaskStatus.FAILED, {
      failed_at: new Date().toISOString(),
    });
    
    // Persist error event
    this.persistEvent({
      task_id: taskId,
      event_type: 'error' as any,
      message: `Execution error: ${error.message}`,
      level: 'error' as any,
      metadata: { error: error.stack },
    });
    
    this.wsService.broadcastTaskEvent(this.getTask(taskId), {
      type: WebSocketEventType.TASK_FAILED,
      payload: { task: this.getTask(taskId) },
      timestamp: new Date().toISOString(),
    });

    const task = this.getTask(taskId);
    const startedAt = task.started_at ? new Date(task.started_at).getTime() : Date.now();
    this.recordSkillOutcome(taskId, undefined, false, Math.max(0, Date.now() - startedAt), task.token_usage || 0);
  }
  
  /**
   * Check if a task is compliant with its execution mode policy.
   */
  checkTaskCompliance(taskId: string): {
    compliant: boolean;
    missingEvidence: string[];
    missingGates: string[];
    reasons: string[];
  } {
    const task = this.getTask(taskId);
    if (!task) {
      return { compliant: false, missingEvidence: [], missingGates: [], reasons: ['Task not found'] };
    }

    const metadata = (task.metadata || {}) as Record<string, unknown>;
    const mode = (metadata.executionMode as any) || 'standard';

    // Collect actual evidence from database
    const evidenceRows = this.db.prepare(
      'SELECT evidence_type FROM execution_evidence WHERE task_id = ?'
    ).all(taskId) as Array<{ evidence_type: string }>;
    const evidence = evidenceRows.map((e) => e.evidence_type);

    // Check which gates passed
    const approvalRows = this.db.prepare(
      'SELECT status FROM approvals WHERE task_id = ? AND status = ?'
    ).all(taskId, 'approved') as Array<{ status: string }>;
    const hasHumanApproval = approvalRows.length > 0;

    // Check security gate (CodeGuardian scan present)
    const hasSecurityScan = evidence.includes('repository_scan');
    const hasTaskReview = evidence.includes('diff_summary');
    const hasComplianceGate = evidence.includes('approval_decision');

    const gatesPassed: string[] = [];
    if (hasTaskReview) gatesPassed.push('task_review');
    if (hasSecurityScan) gatesPassed.push('security_gate');
    if (hasComplianceGate) gatesPassed.push('compliance_gate');

    const sandboxUsed = (metadata.sandbox as Record<string, unknown>)?.enabled === true;

    const result = this.executionModePolicy.shouldBlockMerge(
      mode as any,
      evidence as any[],
      gatesPassed,
      hasHumanApproval,
      sandboxUsed,
    );

    return {
      compliant: !result.blocked,
      missingEvidence: result.reasons.filter((r: string) => r.includes('evidence')),
      missingGates: result.reasons.filter((r: string) => r.includes('gate')),
      reasons: result.reasons,
    };
  }

  /**
   * Update task status in database
   */
  private updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    additionalFields?: Record<string, any>
  ): void {
    const updates: Record<string, any> = {
      status,
      updated_at: new Date().toISOString(),
      ...additionalFields,
    };
    
    const setClauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    
    const task = this.db.transaction(() => {
      const previous = this.getTask(taskId);
      this.db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...values, taskId);
      const current = this.getTask(taskId);
      if (previous.status !== current.status && (current.status === TaskStatus.COMPLETED || current.status === TaskStatus.FAILED)) {
        const completed = current.status === TaskStatus.COMPLETED;
        this.auditService.record({
          event_type: completed ? AuditEventType.TASK_EXECUTED : AuditEventType.EXECUTION_FAILED,
          action: completed ? 'execution_completed' : 'execution_failed',
          user_id: 'system', // Engine transition, not an inferred human approval.
          agent_id: current.agent_id || undefined,
          task_id: taskId,
          resource_type: 'task',
          resource_id: taskId,
          risk_level: current.risk_level,
          before: { status: previous.status, completed_at: previous.completed_at, failed_at: previous.failed_at },
          after: { status: current.status, completed_at: current.completed_at, failed_at: current.failed_at },
          metadata: { source: 'execution-engine', execution_time_ms: current.execution_time_ms },
        });
      }
      return current;
    })();
    
    this.wsService.broadcastTaskEvent(task, {
      type: WebSocketEventType.TASK_UPDATED,
      payload: { task },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Get task from database
   */
  private getTask(taskId: string): Task {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    return {
      ...task,
      tags: JSON.parse(task.tags || '[]'),
      metadata: JSON.parse(task.metadata || '{}'),
    };
  }

  private recordSkillOutcome(
    taskId: string,
    session: ExecutionSession | undefined,
    success: boolean,
    durationMs: number,
    tokensUsed: number,
  ): void {
    const task = this.getTask(taskId);
    const explicitSkillId = typeof task.metadata?.skillId === 'string'
      ? task.metadata.skillId.trim()
      : '';
    let skill: SkillDefinition | null = explicitSkillId
      ? this.skillLoader.getSkill(explicitSkillId)
      : null;

    if (!explicitSkillId && task.agent_id) {
      const assigned = this.skillLoader.getAgentSkills(task.agent_id);
      if (assigned.length === 1) skill = assigned[0];
      if (assigned.length > 1) {
        this.evidenceService.captureEvidence({
          task_id: taskId,
          evidence_type: EvidenceType.EXECUTION_SUMMARY,
          severity: EvidenceSeverity.WARNING,
          title: 'Skill outcome attribution skipped',
          summary: 'Multiple skills are assigned to the agent; set task metadata.skillId to attribute this outcome.',
          details: {
            assignedSkillIds: assigned.map((candidate) => candidate.id),
            success,
            tokensUsed,
            durationMs,
          },
          source: 'system',
          metadata: { reason: 'ambiguous_skill_attribution' },
        });
      }
    }
    if (!skill) return;

    const evidenceRefs = (this.db.prepare(
      'SELECT id FROM execution_evidence WHERE task_id = ? ORDER BY captured_at ASC',
    ).all(taskId) as Array<{ id: string }>).map((row) => row.id);

    this.skillEvolution.recordOutcome(skill.id, {
      taskId,
      agentId: task.agent_id || undefined,
      skillVersion: skill.version,
      skillContentHash: skill.contentHash,
      model: session?.executorKind || String(task.metadata?.model || 'unknown'),
      success,
      tokensUsed,
      durationMs,
      domain: task.execution_mode || 'coding',
      evidenceRefs,
    });
  }

  private blockInvalidSkillAttribution(task: Task): string | null {
    const explicitSkillId = typeof task.metadata?.skillId === 'string'
      ? task.metadata.skillId.trim()
      : '';

    if (explicitSkillId) {
      const skill = this.skillLoader.getSkill(explicitSkillId);
      if (!skill) {
        return this.blockSkillAttribution(task, `Task metadata.skillId is not an admitted skill: ${explicitSkillId}.`, [], 'invalid_skill_attribution');
      }
      if (task.agent_id) {
        const assigned = this.skillLoader.getAgentSkills(task.agent_id);
        if (!assigned.some((candidate) => candidate.id === explicitSkillId)) {
          return this.blockSkillAttribution(
            task,
            `Task metadata.skillId is not assigned to agent ${task.agent_id}: ${explicitSkillId}.`,
            assigned.map((candidate) => candidate.id),
            'unassigned_skill_attribution',
          );
        }
      }
      return null;
    }

    if (!task.agent_id) return null;

    const assigned = this.skillLoader.getAgentSkills(task.agent_id);
    if (assigned.length <= 1) return null;

    const reason = 'Multiple skills are assigned to the agent; set task metadata.skillId before execution.';
    return this.blockSkillAttribution(task, reason, assigned.map((skill) => skill.id), 'ambiguous_skill_attribution');
  }

  private blockSkillAttribution(task: Task, reason: string, assignedSkillIds: string[], code: string): string {
    this.evidenceService.captureEvidence({
      task_id: task.id,
      evidence_type: EvidenceType.POLICY_DECISION,
      severity: EvidenceSeverity.ERROR,
      title: 'Execution blocked: invalid skill attribution',
      summary: reason,
      details: { assignedSkillIds },
      source: 'policy',
      metadata: { reason: code },
    });
    this.updateTaskStatus(task.id, TaskStatus.CANCELLED);
    this.persistEvent({
      task_id: task.id,
      event_type: ExecutionEventType.ERROR,
      message: reason,
      level: LogLevel.ERROR,
      metadata: { reason: code },
    });
    return reason;
  }

  private persistRiskAssessment(taskId: string, assessment: any, subject: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO risk_assessments (
        id, task_id, execution_event_id, action_type, subject, risk_level,
        recommended_decision, matched_rules, explanation, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      null,
      assessment.action_type,
      subject,
      assessment.risk_level,
      assessment.recommended_decision,
      JSON.stringify(assessment.matched_rules),
      assessment.explanation,
      JSON.stringify(assessment.metadata || {}),
      now,
      now
    );
    this.wsService.broadcastTaskEventById(taskId, {
      type: WebSocketEventType.RISK_DETECTED,
      payload: { assessment, task_id: taskId },
      timestamp: now,
    });
    return id;
  }

  private executionInputHash(task: Task, executorKind: ExecutorKind): string {
    const metadata = { ...task.metadata };
    // Runtime output/recovery stamps are not new execution instructions.
    for (const key of Object.keys(metadata)) {
      if (key === 'executionResult' || key === 'deep_agent_contract' || key.startsWith('execution_recovery_')) delete metadata[key];
    }
    return createHash('sha256').update(canonicalJson({
      executorKind, taskId: task.id, title: task.title, description: task.description,
      priority: task.priority, risk: task.risk_level, mode: task.execution_mode,
      agentId: task.agent_id ?? null, parentTaskId: task.parent_task_id ?? null,
      repositoryId: task.repository_id ?? null, instructionProfileId: task.instruction_profile_id ?? null,
      tags: task.tags, metadata,
    })).digest('hex');
  }

  private hasApprovedStart(taskId: string, executorKind: ExecutorKind): boolean {
    const approval = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ?
        AND json_valid(COALESCE(metadata, '{}')) = 1
        AND json_extract(COALESCE(metadata, '{}'), '$.executorKind') = ?
        AND COALESCE(json_type(metadata, '$.manual_action'), 'null') != 'true'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId, executorKind) as any;
    if (!approval || approval.status !== 'approved' || !approval.expires_at
      || !(Date.parse(approval.expires_at) > Date.now())) return false;
    // Historical unbound approvals stay evidence, not reusable execution grants.
    return JSON.parse(approval.metadata).executionInputHash === this.executionInputHash(this.getTask(taskId), executorKind);
  }

  private capturePreExecutionDiff(taskId: string, repositoryId: string | null | undefined): void {
    if (!repositoryId) return;

    const repo = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId) as any;
    if (!repo || !repo.path) return;

    try {
      const preSnapshot = this.diffCaptureService.capturePreExecutionSnapshot(repo.path, repositoryId, taskId);
      this.diffContexts.set(taskId, {
        repositoryId,
        repositoryPath: repo.path,
        preSnapshotId: preSnapshot?.id ?? null,
      });

      this.auditService.record({
        event_type: AuditEventType.REPOSITORY_SCANNED,
        action: 'pre_execution_snapshot_captured',
        resource_type: 'repository',
        resource_id: repositoryId,
        task_id: taskId,
        metadata: { preSnapshotId: preSnapshot?.id ?? null, isClean: preSnapshot?.isClean },
      });
    } catch (error) {
      console.error('Failed to capture pre-execution snapshot for task:', taskId, error);
    }
  }

  private capturePostExecutionDiff(taskId: string): void {
    const ctx = this.diffContexts.get(taskId);
    if (!ctx) return;

    this.diffContexts.delete(taskId);

    try {
      const result = this.diffCaptureService.capturePostExecutionDiff(
        ctx.repositoryPath,
        ctx.repositoryId,
        taskId,
        ctx.preSnapshotId,
      );

      if (result.files.length > 0) {
        this.auditService.record({
          event_type: AuditEventType.DIFF_CAPTURED,
          action: 'post_execution_diff_captured',
          resource_type: 'repository',
          resource_id: ctx.repositoryId,
          task_id: taskId,
          metadata: {
            filesChanged: result.files.length,
            totalAdditions: result.summary.totalAdditions,
            totalDeletions: result.summary.totalDeletions,
            redactedSecrets: result.summary.redactedSecrets,
            truncated: result.summary.truncated,
          },
        });
      }

      if (result.summary.redactedSecrets > 0) {
        this.auditService.record({
          event_type: AuditEventType.SECRET_REDACTED,
          action: 'secrets_redacted_in_diff',
          resource_type: 'task',
          resource_id: taskId,
          task_id: taskId,
          metadata: { count: result.summary.redactedSecrets },
        });
      }
    } catch (error) {
      console.error(`Failed to capture post-execution diff for task ${taskId}:`, error);
    }
  }
}
