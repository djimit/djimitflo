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
import { GeminiExecutor } from './executors/gemini-executor';
import { EditorExecutor } from './executors/editor-executor';
import { PiExecutor } from './executors/pi-executor';
import { DeepAgentExecutor } from './executors/deep-agent-executor';
import { DockerSandboxExecutor, DEFAULT_SANDBOX_CONFIG } from './executors/docker-sandbox-executor';
import { CircuitBreakerService } from '../services/circuit-breaker-service';
import { FallbackChainService, ExecutionMode } from '../services/fallback-chain-service';
import { ExecutionModePolicyService } from '../services/execution-mode-policy-service';
import { WebSocketService } from '../services/websocket-service';
import { randomUUID } from 'crypto';
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
import { TrajectoryStore } from '../services/trajectory-store';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { SkillLoaderService, type SkillDefinition } from '../services/skill-loader-service';
import { runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';
import { RuntimeGovernanceService } from '../services/runtime-governance-service';
import { DeepAgentContractIssuer } from '../services/deep-agent-contract-issuer';
import { DennisAgentService } from '../services/dennis-agent-service';
import { EvidenceType, EvidenceSeverity } from '@djimitflo/shared';

export interface ExecuteTaskResult {
  status: 'started' | 'awaiting_approval' | 'denied';
  approvalId?: string;
  reason?: string;
  completion?: Promise<ExecutionResult>;
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
    
    // Parse JSON fields
    const parsedTask: Task = {
      ...task,
      tags: JSON.parse(task.tags || '[]'),
      metadata: JSON.parse(task.metadata || '{}'),
    };

    const latestApproval = this.approvalService.getLatestPendingForTask(taskId);
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
        metadata: { executorKind },
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
      title: `Task execution started (${evaluation.decision})`,
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
      if (executorKind === 'deep-agent') {
        if (!this.deepAgentIssuer) throw new Error('Deep Agent Federation issuer is unavailable');
        parsedTask.metadata.deep_agent_contract = this.deepAgentIssuer.issue(parsedTask, dispatcherId || '');
        this.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.deep_agent_contract', json(?)) WHERE id = ?")
          .run(JSON.stringify(parsedTask.metadata.deep_agent_contract), taskId);
        if (!executor.canExecute(parsedTask)) throw new Error('Executor deep-agent cannot execute this task');
      }
      const workingDirectory = (parsedTask.metadata as Record<string, unknown> | undefined)?.workingDirectory as string | undefined;
      const mode = (parsedTask.metadata?.executionMode as ExecutionMode) || 'standard';
      const maxRetries = this.executionModePolicy.getConfig(mode).maxRetries;
      const session = await this.startExecutionAttempt(parsedTask, executorKind, mode, 0, maxRetries, workingDirectory);
      return { status: 'started', completion: session.result };
    } catch (error) {
      runtimeConcurrencySemaphore.release(`execution:${taskId}`);
      this.updateTaskStatus(taskId, TaskStatus.FAILED, {
        failed_at: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async startExecutionAttempt(
    task: Task,
    executorKind: ExecutorKind,
    mode: ExecutionMode,
    attempt: number,
    maxRetries: number,
    workingDirectory?: string,
  ): Promise<ExecutionSession> {
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
      const session = await activeExecutor.start(task, {
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(executionMetadata.environment ? { environment: executionMetadata.environment as Record<string, string> } : {}),
        ...(executionMetadata.timeoutMs ? { timeout: Number(executionMetadata.timeoutMs) } : {}),
        ...(executionMetadata.skipPermissions === true ? { skipPermissions: true } : {}),
      });
      this.activeSessions.set(task.id, session);
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
    if (session.status === 'cancelled') return;
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
    this.activeSessions.delete(task.id);
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
    else this.handleExecutionError(task.id, new ExecutionFailureError(failure));
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
    
    await session.cancel();
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
    this.wsService.broadcastTaskEventById(taskId, {
      type: WebSocketEventType.EXECUTION_EVENT,
      payload: {
        event: {
          id: eventId,
          ...event,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
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
    this.activeSessions.delete(taskId);
    runtimeConcurrencySemaphore.release(`execution:${taskId}`);
    this.db.prepare("UPDATE tasks SET metadata = json_set(COALESCE(metadata, '{}'), '$.executionResult', json(?)) WHERE id = ?")
      .run(JSON.stringify(result), taskId);

    if (session.executorKind === 'deep-agent' && result.status === 'completed') {
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
    
    // Capture post-execution diff if task has a repository
    this.capturePostExecutionDiff(taskId);

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
  private handleExecutionError(taskId: string, error: Error): void {
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
    
    this.db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...values, taskId);
    
    this.wsService.broadcastTaskEvent(this.getTask(taskId), {
      type: WebSocketEventType.TASK_UPDATED,
      payload: { task: this.getTask(taskId) },
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

  private hasApprovedStart(taskId: string, executorKind: ExecutorKind): boolean {
    const approval = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ? AND status = 'approved'
        AND json_valid(COALESCE(metadata, '{}')) = 1
        AND json_extract(COALESCE(metadata, '{}'), '$.executorKind') = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(taskId, executorKind) as any;
    return Boolean(approval);
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
