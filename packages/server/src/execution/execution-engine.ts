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
import { TaskExecutor, ExecutionSession, ExecutorKind } from './types';
import { MockExecutor } from './executors/mock-executor';
import { OpenCodeExecutor } from './executors/opencode-executor';
import { CodexExecutor } from './executors/codex-executor';
import { ClaudeExecutor } from './executors/claude-executor';
import { GeminiExecutor } from './executors/gemini-executor';
import { EditorExecutor } from './executors/editor-executor';
import { PiExecutor } from './executors/pi-executor';
import { DockerSandboxExecutor, DEFAULT_SANDBOX_CONFIG } from './executors/docker-sandbox-executor';
import { CircuitBreakerService } from '../services/circuit-breaker-service';
import { FallbackChainService, ExecutionMode } from '../services/fallback-chain-service';
import { ExecutionModePolicyService } from '../services/execution-mode-policy-service';
import { WebSocketService } from '../services/websocket-service';
import { randomUUID } from 'crypto';
import { CommandRiskClassifier } from '../services/command-risk-classifier';
import { PolicyDecisionService } from '../services/policy-decision-service';
import { ApprovalService } from '../services/approval-service';
import { AuditService } from '../services/audit-service';
import { EvidenceService } from '../services/evidence-service';
import { DiffCaptureService } from '../services/diff-capture';
import { MemorySyncService } from '../services/memory-sync-service';
import { ReasoningBankService } from '../services/reasoning-bank-service';
import { TrajectoryStore } from '../services/trajectory-store';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { EvidenceType, EvidenceSeverity } from '@djimitflo/shared';

export interface ExecuteTaskResult {
  status: 'started' | 'awaiting_approval' | 'denied';
  approvalId?: string;
  reason?: string;
}

export class ExecutionEngine {
  private db: Database;
  private wsService: WebSocketService;
  private executors: Map<ExecutorKind, TaskExecutor>;
  private activeSessions: Map<string, ExecutionSession>; // taskId -> session
  private diffContexts: Map<string, { repositoryId: string; repositoryPath: string; preSnapshotId: string | null }>; // taskId -> diff context
  private riskClassifier: CommandRiskClassifier;
  private policyDecisionService: PolicyDecisionService;
  private auditService: AuditService;
  private approvalService: ApprovalService;
  private evidenceService: EvidenceService;
  private diffCaptureService: DiffCaptureService;
  private memorySyncService?: MemorySyncService;
  private reasoningBankService?: ReasoningBankService;
  private trajectoryStore?: TrajectoryStore;
  private metaOrchestration?: MetaOrchestrationService;
  private circuitBreaker: CircuitBreakerService;
  private fallbackChain: FallbackChainService;
  private executionModePolicy: ExecutionModePolicyService;

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

  constructor(db: Database, wsService: WebSocketService) {
    this.db = db;
    this.wsService = wsService;
    this.executors = new Map();
    this.circuitBreaker = new CircuitBreakerService();
    this.fallbackChain = new FallbackChainService();
    this.executionModePolicy = new ExecutionModePolicyService();
    this.activeSessions = new Map();
    this.diffContexts = new Map();
    this.riskClassifier = new CommandRiskClassifier();
    this.policyDecisionService = new PolicyDecisionService(db);
    this.auditService = new AuditService(db);
    this.approvalService = new ApprovalService(db, wsService, this.auditService);
    this.evidenceService = new EvidenceService(db);
    this.diffCaptureService = new DiffCaptureService(db);
    
    // Register default executors
    this.registerExecutor(new MockExecutor());
    this.registerExecutor(new OpenCodeExecutor());
    this.registerExecutor(new CodexExecutor());
    this.registerExecutor(new ClaudeExecutor());
    this.registerExecutor(new GeminiExecutor());
    this.registerExecutor(new EditorExecutor());
    this.registerExecutor(new PiExecutor());
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
  async executeTask(taskId: string, executorKind: ExecutorKind = 'opencode'): Promise<ExecuteTaskResult> {
    // Check if task is already running
    if (this.activeSessions.has(taskId)) {
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
    
    // Get executor
    let executor = this.executors.get(executorKind);
    if (!executor) {
      throw new Error(`Executor not found: ${executorKind}`);
    }
    
    if (!executor.canExecute(parsedTask)) {
      throw new Error(`Executor ${executorKind} cannot execute this task`);
    }

    const assessment = this.riskClassifier.assessTask(parsedTask, executorKind, process.cwd());
    const evaluation = this.policyDecisionService.evaluate(assessment);
    this.persistRiskAssessment(taskId, assessment, `${parsedTask.title}: ${parsedTask.description}`);

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

    if (evaluation.decision === 'require_approval' && !this.hasApprovedStart(taskId)) {
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

    try {
      // Start execution
      // Resolve a working directory from task metadata (operator/loop may pin a worktree);
      // executors fall back to process.cwd() when undefined (unchanged default behavior).
      const workingDirectory = (parsedTask.metadata as Record<string, unknown> | undefined)?.workingDirectory as
        | string
        | undefined;
      // Check circuit breaker before execution
      if (!this.circuitBreaker.canExecute(executorKind)) {
        const fallback = this.fallbackChain.getNextAvailable(
          executorKind,
          (parsedTask.metadata?.executionMode as ExecutionMode) || 'standard',
          this.circuitBreaker,
        );
        if (fallback) {
          this.persistEvent({
            task_id: taskId,
            event_type: 'log' as any,
            message: 'Circuit open for ' + executorKind + ', falling back to ' + fallback,
            level: 'warning' as any,
            metadata: { circuit: 'open', from: executorKind, to: fallback },
          });
          executorKind = fallback;
          executor = this.executors.get(fallback)!;
        } else {
          throw new Error();
        }
      }

      // Wrap executor in Docker sandbox if configured
      const sandboxMeta = (parsedTask.metadata?.sandbox ?? {}) as Record<string, unknown>;
      const sandboxEnabled = sandboxMeta.enabled === true;
      const activeExecutor = sandboxEnabled
        ? new DockerSandboxExecutor(executor, {
            ...DEFAULT_SANDBOX_CONFIG,
            image: (sandboxMeta.image as string) || DEFAULT_SANDBOX_CONFIG.image,
            cpuLimit: (sandboxMeta.cpuLimit as string) || DEFAULT_SANDBOX_CONFIG.cpuLimit,
            memoryLimit: (sandboxMeta.memoryLimit as string) || DEFAULT_SANDBOX_CONFIG.memoryLimit,
            networkMode: (sandboxMeta.networkMode as 'none' | 'bridge' | 'host') || DEFAULT_SANDBOX_CONFIG.networkMode,
            bindMounts: (sandboxMeta.bindMounts as Array<{ host: string; container: string; mode: 'ro' | 'rw' }>) || DEFAULT_SANDBOX_CONFIG.bindMounts,
          })
        : executor;

      const session = await activeExecutor.start(parsedTask, workingDirectory ? { workingDirectory } : undefined);
      this.activeSessions.set(taskId, session);

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess(executorKind);

      // Record trajectory step
      if (this.trajectoryStore) {
        this.trajectoryStore.recordStep({
          runId: taskId,
          actionType: 'execute',
          capabilityId: parsedTask.execution_mode || null,
          runtime: executor.kind,
          outcome: 'success',
          metadata: { title: parsedTask.title },
        });
      }

      // Update task status to running
      this.updateTaskStatus(taskId, TaskStatus.RUNNING, {
        started_at: session.startedAt.toISOString(),
      });

      // Process event stream in background
      this.processEventStream(session).catch((error) => {
        console.error(`Error processing event stream for task ${taskId}:`, error);
        this.handleExecutionError(taskId, error);
      });

      // Wait for result and update task
      session.result.then((result) => {
        this.handleExecutionComplete(taskId, session, result);
      }).catch((error) => {
        this.handleExecutionError(taskId, error);
      });
      return { status: 'started' };
    } catch (error) {
      this.updateTaskStatus(taskId, TaskStatus.FAILED, {
        failed_at: new Date().toISOString(),
      });
      throw error;
    }
  }

  async handleApprovalDecision(approvalId: string, approved: boolean, decidedBy?: string, reason?: string): Promise<ExecuteTaskResult | null> {
    const approval = this.approvalService.decideApproval(approvalId, approved, decidedBy || 'system', reason);
    if (!approved) {
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
    return this.executeTask(approval.task_id, executorKind);
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
    try {
      for await (const event of session.events) {
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

    // Record failure in circuit breaker
    const taskRecord = this.db.prepare("SELECT executor_kind FROM tasks WHERE id = ?").get(taskId) as any;
    if (taskRecord?.executor_kind) {
      this.circuitBreaker.recordFailure(taskRecord.executor_kind as ExecutorKind);
    }

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
    const evidence: any[] = [];
    const gatesPassed: string[] = [];
    const hasHumanApproval = false;
    const sandboxUsed = (metadata.sandbox as Record<string, unknown>)?.enabled === true;

    const result = this.executionModePolicy.shouldBlockMerge(
      mode as any,
      evidence,
      gatesPassed,
      hasHumanApproval,
      sandboxUsed,
    );

    return {
      compliant: !result.blocked,
      missingEvidence: [],
      missingGates: [],
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

  private hasApprovedStart(taskId: string): boolean {
    const approval = this.db.prepare(`
      SELECT * FROM approvals
      WHERE task_id = ? AND status = 'approved'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(taskId) as any;
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
      console.error(`Failed to capture pre-execution snapshot for task ${taskId}:`, error);
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
