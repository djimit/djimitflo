/**
 * LoopLifecycleService — owns loop lifecycle transitions: continue, retry, split.
 *
 * Extracted from LoopService to reduce its footprint. These methods handle
 * worker lease creation, worktree management, and finding decomposition.
 */

import { randomUUID } from 'crypto';
import type {
  LoopService,
  LoopRunRecord,
  WorkerLeaseRecord,
  LoopFinding,
  LoopName,
  ContinueLoopInput,
  RetryLoopInput,
  SplitLoopInput,
} from './loop-service';

export type ContinueResult = { run: LoopRunRecord; leases: WorkerLeaseRecord[] };
export type RetryResult = { run: LoopRunRecord; leases: WorkerLeaseRecord[]; retry_maker: WorkerLeaseRecord; retry_checker: WorkerLeaseRecord };
export type SplitResult = { run: LoopRunRecord; parent: LoopFinding; children: LoopFinding[]; leases: WorkerLeaseRecord[] };

export class LoopLifecycleService {
  constructor(private loopService: LoopService) {}

  continueLoopRun(id: string, input: ContinueLoopInput = {}): ContinueResult {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertLoopNotEscalated(run);
    this.loopService.assertWallClockBudgetAvailable(run);
    this.loopService.assertTokenBudgetAvailable(run);
    this.loopService.assertNoFailedGates(run);
    if (!run.repository_path) throw new Error('LOOP_REPOSITORY_REQUIRED');
    if (run.findings.length === 0) throw new Error('LOOP_NO_FINDINGS_TO_ASSIGN');

    const alreadyLeased = this.loopService.listWorkerLeases(id);
    const leasedFindingIds = new Set(
      alreadyLeased.filter((l) => l.role === 'maker' && l.finding_id).map((l) => l.finding_id as string)
    );
    const selectedFindingIds = new Set(input.finding_ids || []);
    if (selectedFindingIds.size > 0 && run.findings.some((f) => selectedFindingIds.has(f.id) && this.loopService.isSplitFinding(f))) {
      throw new Error('LOOP_FINDING_ALREADY_SPLIT');
    }
    const maxAssignments = Math.max(1, Math.min(input.max_assignments || 1, 5));
    const selectedFindings = run.findings
      .filter((f) => !this.loopService.isSplitFinding(f))
      .filter((f) => selectedFindingIds.size === 0 || selectedFindingIds.has(f.id))
      .filter((f) => !leasedFindingIds.has(f.id))
      .slice(0, maxAssignments);

    if (selectedFindings.length === 0 && alreadyLeased.length > 0) return { run, leases: alreadyLeased };
    if (selectedFindings.length === 0) throw new Error('LOOP_FINDING_NOT_FOUND');

    // Intelligent runtime selection: use meta-orchestration if no explicit runtime requested
    let runtime = input.runtime;
    if (!runtime && this.loopService.metaOrchestration) {
      const routing = this.loopService.metaOrchestration.getRoutingOptimization(run.loop_name || 'coding');
      // Extract runtime from routing recommendation (format: "provider/model")
      const recommendedModel = routing.recommendedModel;
      // Map model names to runtimes
      runtime = 'mock'; // Default to mock for safety
      if (recommendedModel.includes('codex')) runtime = 'codex';
      else if (recommendedModel.includes('opencode')) runtime = 'opencode';
      else if (recommendedModel.includes('claude')) runtime = 'claude';
      else if (recommendedModel.includes('gemini')) runtime = 'gemini';
    }
    runtime = runtime || 'manual';
    this.loopService.assertRuntimeAvailable(runtime);
    const budget = this.loopService.getMakerLeaseBudget(run, input);
    const currentMakerLeases = alreadyLeased.filter((l) => l.role === 'maker').length;
    if (currentMakerLeases >= budget.maxMakerWorkers || selectedFindings.length > budget.maxMakerWorkers - currentMakerLeases) {
      throw new Error('LOOP_WORKER_BUDGET_EXHAUSTED');
    }

    const now = new Date().toISOString();
    for (const finding of selectedFindings) {
      const branchName = this.loopService.branchNameFor(run.id, finding.id);
      const worktreePath = this.loopService.createWorktree(run.repository_path, run.id, finding.id, branchName);
      this.loopService.ensureWorktreeControlIgnore(worktreePath);
      this.loopService.writeWorkAssignment(worktreePath, run, finding, runtime);
      const assignmentPacketFile = this.loopService.writeAssignmentPacket(worktreePath, run, finding, runtime);
      const makerLeaseId = randomUUID();
      const assignmentFile = this.loopService.workAssignmentPath(worktreePath);
      this.loopService.insertWorkerLease({
        id: makerLeaseId, loopRunId: run.id, role: 'maker', runtime,
        findingId: finding.id, worktreePath, branchName,
        metadata: { assignment_file: assignmentFile, assignment_packet_file: assignmentPacketFile, requested_runtime: runtime, effective_runtime: runtime }, now,
      });
      const checkerLeaseId = randomUUID();
      this.loopService.insertWorkerLease({
        id: checkerLeaseId, loopRunId: run.id, role: 'checker', runtime: 'manual',
        findingId: finding.id, worktreePath: null, branchName: null,
        metadata: { maker_lease_id: makerLeaseId, requires_independent_review: true }, now,
      });
      if (this.loopService.isHighRiskRun(run, finding)) {
        const securityCheckerLeaseId = randomUUID();
        this.loopService.insertWorkerLease({
          id: securityCheckerLeaseId, loopRunId: run.id, role: 'security_checker', runtime: 'manual',
          findingId: finding.id, worktreePath: null, branchName: null,
          metadata: { maker_lease_id: makerLeaseId, requires_security_review: true, high_risk_reason: this.loopService.highRiskReason(run, finding) }, now,
        });
      }
    }

    // Select best strategy from cognitive learning (if available)
    const strategy = this.loopService.metaOrchestration
      ? this.loopService.metaOrchestration.getStrategyRecommendation(run.loop_name || 'coding')
      : { strategy: 'maker-checker-v1', confidence: 0, rationale: 'No meta-orchestration' };

    this.loopService.getLoopRun(id); // refresh
    const db = (this.loopService as any).db;
    db.prepare("UPDATE loop_runs SET status = ?, next_actions_json = ?, updated_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.strategy', ?) WHERE id = ?").run(
      'running',
      JSON.stringify(this.loopService.isHighRiskRun(run)
        ? ['Run maker in prepared worktree', 'Run checker and security checker after maker output', 'Call verify before completion']
        : ['Run maker in prepared worktree', 'Run checker after maker output', 'Call verify before completion']),
      now,
      strategy.strategy,
      run.id,
    );
    this.loopService.recordLoopEvent(run.id, 'worker_leases_prepared', 'info', 'Prepared ' + selectedFindings.length + ' maker/checker assignment(s) with strategy "' + strategy.strategy + '".', {
      finding_ids: selectedFindings.map((f) => f.id), runtime, budget, strategy: strategy.strategy, strategyConfidence: strategy.confidence,
    });
    return { run: this.loopService.getLoopRun(run.id), leases: this.loopService.listWorkerLeases(run.id) };
  }

  splitLoopFinding(id: string, input: SplitLoopInput): SplitResult {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertLoopNotEscalated(run);
    this.loopService.assertWallClockBudgetAvailable(run);
    if (!input.finding_id) throw new Error('LOOP_FINDING_ID_REQUIRED');
    const parentIndex = run.findings.findIndex((f) => f.id === input.finding_id);
    if (parentIndex === -1) throw new Error('LOOP_FINDING_NOT_FOUND');
    const parent = run.findings[parentIndex];
    if (this.loopService.isSplitFinding(parent)) throw new Error('LOOP_FINDING_ALREADY_SPLIT');
    const childInputs = input.children || [];
    if (childInputs.length < 2) throw new Error('LOOP_SPLIT_CHILDREN_REQUIRED');
    const reason = input.reason?.trim() || 'Finding split into bounded child findings.';
    const now = new Date().toISOString();
    const updatedParent: LoopFinding = { ...parent, metadata: { ...(parent.metadata || {}), status: 'split', split_reason: reason, split_at: now } };
    const children: LoopFinding[] = childInputs.map((child, index) => {
      if (!child.message?.trim() || !child.suggested_fix?.trim()) throw new Error('LOOP_SPLIT_CHILD_INVALID');
      return {
        id: randomUUID(), type: parent.type, severity: parent.severity, file: child.file || parent.file,
        line: child.line ?? parent.line, message: child.message.trim(), evidence: parent.evidence,
        suggested_fix: child.suggested_fix.trim(), parent_finding_id: parent.id,
        metadata: { status: 'active', split_reason: reason, split_index: index, split_at: now },
      };
    });
    const findings = [...run.findings.slice(0, parentIndex), updatedParent, ...children, ...run.findings.slice(parentIndex + 1)];
    const plan = this.loopService.createPlan(run.loop_name as LoopName, findings);
    const nextActions = ['Review split child findings', 'Approve maker/checker worker execution for selected child findings'];
    const db = (this.loopService as any).db;
    db.prepare('UPDATE loop_runs SET status = ?, findings_json = ?, plan_json = ?, next_actions_json = ?, updated_at = ? WHERE id = ?').run(
      'planning', JSON.stringify(findings), JSON.stringify(plan), JSON.stringify(nextActions), now, run.id,
    );
    this.loopService.recordLoopEvent(run.id, 'finding_split', 'info', `Split finding ${parent.id} into ${children.length} child finding(s).`, {
      parent_finding_id: parent.id, child_finding_ids: children.map((c) => c.id), reason,
    });
    return { run: this.loopService.getLoopRun(run.id), parent: updatedParent, children, leases: this.loopService.listWorkerLeases(run.id) };
  }

  retryLoopRun(id: string, input: RetryLoopInput = {}): RetryResult {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertLoopNotEscalated(run);
    this.loopService.assertWallClockBudgetAvailable(run);
    this.loopService.assertTokenBudgetAvailable(run);
    if (!run.repository_path) throw new Error('LOOP_REPOSITORY_REQUIRED');
    const leases = this.loopService.listWorkerLeases(run.id);
    const checkerLeases = leases.filter((l) => l.role === 'checker');
    const maker = input.maker_lease_id
      ? leases.find((l) => l.id === input.maker_lease_id)
      : leases.find((l) => l.role === 'maker' && this.loopService.isRetryableMakerLease(l, checkerLeases));
    if (!maker) throw new Error('MAKER_LEASE_NOT_FOUND');
    if (maker.role !== 'maker') throw new Error('LEASE_NOT_MAKER');
    if (!maker.finding_id) throw new Error('LOOP_FINDING_NOT_FOUND');
    if (!this.loopService.isRetryableMakerLease(maker, checkerLeases)) throw new Error('LOOP_RETRY_NOT_ALLOWED');
    const finding = run.findings.find((c) => c.id === maker.finding_id);
    if (!finding) throw new Error('LOOP_FINDING_NOT_FOUND');
    const retryRootMakerLeaseId = this.loopService.retryRootFor(maker);
    const retryBudget = this.loopService.getRetryBudget(run, maker, input);
    const usedRetries = leases.filter((l) => l.role === 'maker' && l.metadata.retry_root_maker_lease_id === retryRootMakerLeaseId).length;
    if (usedRetries >= retryBudget.maxRetries) throw new Error('LOOP_RETRY_BUDGET_EXHAUSTED');
    const runtime = input.runtime || (maker.runtime as RetryLoopInput['runtime']) || 'manual';
    this.loopService.assertRuntimeAvailable(runtime);
    const retryAttempt = usedRetries + 1;
    const branchName = this.loopService.branchNameFor(run.id, finding.id, retryAttempt);
    const worktreePath = this.loopService.createWorktree(run.repository_path, run.id, `${finding.id}-retry-${retryAttempt}`, branchName);
    this.loopService.ensureWorktreeControlIgnore(worktreePath);
    this.loopService.writeWorkAssignment(worktreePath, run, finding, runtime);
    const assignmentPacketFile = this.loopService.writeAssignmentPacket(worktreePath, run, finding, runtime, retryAttempt);
    const assignmentFile = this.loopService.workAssignmentPath(worktreePath);
    const now = new Date().toISOString();
    const retryMakerLeaseId = randomUUID();
    this.loopService.insertWorkerLease({
      id: retryMakerLeaseId, loopRunId: run.id, role: 'maker', runtime, findingId: finding.id, worktreePath, branchName,
      metadata: { assignment_file: assignmentFile, assignment_packet_file: assignmentPacketFile, retry_of_maker_lease_id: maker.id, retry_root_maker_lease_id: retryRootMakerLeaseId, retry_attempt: retryAttempt }, now,
    });
    const retryCheckerLeaseId = randomUUID();
    this.loopService.insertWorkerLease({
      id: retryCheckerLeaseId, loopRunId: run.id, role: 'checker', runtime: 'manual', findingId: finding.id, worktreePath: null, branchName: null,
      metadata: { maker_lease_id: retryMakerLeaseId, requires_independent_review: true, retry_of_maker_lease_id: maker.id, retry_root_maker_lease_id: retryRootMakerLeaseId, retry_attempt: retryAttempt }, now,
    });
    this.loopService.updateWorkerLeaseStatus(maker.id, maker.status, { superseded_by_maker_lease_id: retryMakerLeaseId, superseded_at: now });
    const db = (this.loopService as any).db;
    db.prepare('UPDATE loop_runs SET status = ?, next_actions_json = ?, updated_at = ? WHERE id = ?').run(
      'running', JSON.stringify(['Run retry maker in prepared worktree', 'Run deterministic checks', 'Submit independent checker verdict']), now, run.id,
    );
    this.loopService.recordLoopEvent(run.id, 'retry_prepared', 'info', `Prepared retry ${retryAttempt} for maker lease ${maker.id}.`, {
      maker_lease_id: maker.id, retry_maker_lease_id: retryMakerLeaseId, retry_checker_lease_id: retryCheckerLeaseId, retry_attempt: retryAttempt, retry_budget: retryBudget,
    });
    const updatedLeases = this.loopService.listWorkerLeases(run.id);
    return { run: this.loopService.getLoopRun(run.id), leases: updatedLeases, retry_maker: updatedLeases.find((l) => l.id === retryMakerLeaseId)!, retry_checker: updatedLeases.find((l) => l.id === retryCheckerLeaseId)! };
  }
}
