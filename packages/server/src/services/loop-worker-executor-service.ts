/**
 * LoopWorkerExecutorService — handles maker and checker worker execution.
 *
 * Extracted from LoopService to reduce its 4535 LOC. This service owns the
 * runtime command building, process spawning, gate evaluation, and result
 * persistence for both maker and checker roles.
 */

import fs from 'fs';
import path from 'path';
import type {
  LoopService,
  LoopRunRecord,
  WorkerLeaseRecord,
  LoopGate,
  RuntimeContract,
  RuntimeUsage,
} from './loop-service';

export interface ExecuteMakerInput {
  lease_id?: string;
  timeout_ms?: number;
  skip_permissions?: boolean;
  diff_max_lines?: number;
}

export interface ExecuteCheckerInput {
  lease_id?: string;
  runtime?: string;
  timeout_ms?: number;
  skip_permissions?: boolean;
}

export interface ExecuteWorkerResult {
  run: LoopRunRecord;
  lease: WorkerLeaseRecord;
  gates: LoopGate[];
  stdout_path: string;
  stderr_path: string;
  checkpoint_before?: any;
  checkpoint_after?: any;
  trace?: any;
}

export class LoopWorkerExecutorService {
  constructor(
    private db: any,
    private loopService: LoopService,
  ) {}

  async executeMaker(id: string, input: ExecuteMakerInput = {}): Promise<ExecuteWorkerResult> {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertWallClockBudgetAvailable(run);
    const leases = this.loopService.listWorkerLeases(run.id);
    const makerLease = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'maker' && lease.status === 'prepared');

    if (!makerLease) throw new Error('MAKER_LEASE_NOT_FOUND');
    if (makerLease.role !== 'maker') throw new Error('LEASE_NOT_MAKER');
    if (makerLease.status !== 'prepared') throw new Error('MAKER_LEASE_NOT_PREPARED');
    if (!makerLease.worktree_path || !fs.existsSync(makerLease.worktree_path)) {
      this.loopService.recordMakerFailure(run.id, makerLease.id, 'MAKER_WORKTREE_NOT_FOUND', 'Worktree path does not exist');
      throw new Error('MAKER_WORKTREE_NOT_FOUND');
    }
    if (makerLease.runtime === 'manual') {
      this.loopService.recordMakerFailure(run.id, makerLease.id, 'MANUAL_MAKER_REQUIRES_HUMAN', 'Manual runtime requires human intervention');
      throw new Error('MANUAL_MAKER_REQUIRES_HUMAN');
    }

    // Meta-orchestration: failure prediction before execution
    if (this.loopService.metaOrchestration) {
      const prediction = this.loopService.metaOrchestration.predictFailure({
        title: run.loop_name || 'loop-task',
        description: makerLease.runtime + ' worker for ' + run.loop_name,
        priority: 'medium',
        riskLevel: this.loopService.isHighRiskRun(run) ? 'high' : 'low',
        executionMode: makerLease.runtime,
        tags: [makerLease.role, makerLease.runtime],
        metadata: { loop_run_id: run.id, lease_id: makerLease.id },
      });
      if (prediction.willFail && prediction.confidence > 0.8) {
        this.loopService.recordLoopEvent(run.id, 'failure_predicted', 'warning',
          `Meta-orchestration predicted failure (${(prediction.confidence * 100).toFixed(0)}% confidence): ${prediction.reasons.join('; ')}`,
          { prediction, lease_id: makerLease.id });
      }
    }

    const runtimeContract = this.loopService.getRuntimeContract(makerLease.runtime);
    this.loopService.recordWorkerManifest({
      decisionId: this.loopService.makeManifestDecisionId(run.id, makerLease.id, 'start'),
      loopRunId: run.id,
      leaseId: makerLease.id,
      action: 'start',
      runtimeContract,
      capacitySnapshot: this.loopService.currentCapacitySnapshot(),
      budgetSnapshot: this.loopService.currentBudgetSnapshot(run),
      gateRefs: ['runtime_contract'],
      blockedReasons: [],
      metadata: { worker_role: makerLease.role, worker_runtime: makerLease.runtime, started_from: 'executeMaker' },
    });

    this.loopService.updateWorkerLeaseStatus(makerLease.id, 'running', { started_at: new Date().toISOString() });

    if (!runtimeContract.available || runtimeContract.status !== 'ok') {
      this.loopService.recordWorkerManifest({
        decisionId: this.loopService.makeManifestDecisionId(run.id, makerLease.id, 'fail'),
        loopRunId: run.id, leaseId: makerLease.id, action: 'fail', runtimeContract,
        capacitySnapshot: this.loopService.currentCapacitySnapshot(),
        budgetSnapshot: this.loopService.currentBudgetSnapshot(run),
        gateRefs: ['runtime_contract'], blockedReasons: ['runtime_contract_drift'],
        metadata: { worker_role: makerLease.role, worker_runtime: makerLease.runtime, reason: 'runtime_contract_unavailable_or_drifted', started_from: 'executeMaker' },
      });
      this.loopService.updateWorkerLeaseStatus(makerLease.id, 'failed', { runtime_adapter: makerLease.runtime, runtime_contract: runtimeContract, runtime_contract_failed_at: new Date().toISOString() });
      throw new Error('RUNTIME_CONTRACT_DRIFTED');
    }

    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const prompt = fs.readFileSync(this.loopService.resolveWorkAssignmentPath(makerLease), 'utf8');
    const skipPermissions = this.loopService.resolveSkipPermissions(input.skip_permissions);
    const { command, args } = this.loopService.buildRuntimeCommand(makerLease.runtime, makerLease.worktree_path!, prompt, skipPermissions);
    const result = await this.loopService.runtimeCommand.executeRuntimeCommand(makerLease.id, command, args, {
      cwd: makerLease.worktree_path!,
      timeoutMs,
      enforceCwdBoundary: makerLease.runtime !== 'mock',
      maxBuffer: 5 * 1024 * 1024,
      env: this.loopService.buildNestedSpawnEnv(makerLease) ?? undefined,
    });

    const { stdoutPath, stderrPath } = this.writeOutput(run.id, makerLease.id, 'worker-output', result.stdout || '', result.stderr || '');
    const diff = this.loopService.git(makerLease.worktree_path!, ['diff', '--', '.']);
    const diffLines = diff ? diff.split(/\r?\n/).filter(Boolean).length : 0;
    const diffMaxLines = Math.max(1, Math.min(input.diff_max_lines || 200, 2_000));
    const exitStatus = result.exitCode;
    const timedOut = result.timedOut;
    const runtimeUsage = this.loopService.extractRuntimeUsage(result.stdout || '');
    const runtimeWarnings = this.loopService.extractRuntimeWarnings(result.stdout || '', result.stderr || '');
    const tokenBudget = this.loopService.evaluateTokenBudget(run, runtimeUsage, makerLease.id, diffLines);
    const efficiency = this.loopService.calculateWorkerEfficiency(runtimeUsage, diffLines);

    const gates: LoopGate[] = [
      { name: 'maker_runtime_exit_zero', status: exitStatus === 0 && !timedOut ? 'pass' : 'fail', evidence: `runtime=${makerLease.runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}, skip_permissions=${skipPermissions}` },
      { name: 'diff_under_threshold', status: diffLines <= diffMaxLines ? 'pass' : 'fail', evidence: `${diffLines} changed diff line(s), threshold ${diffMaxLines}.` },
      tokenBudget.gate,
      { name: 'runtime_warning_gate', status: this.loopService.runtimeWarningsBlockCompletion(runtimeWarnings, run) ? 'fail' : 'pass', evidence: this.loopService.runtimeWarningsEvidence(runtimeWarnings, run) },
      { name: 'no_automatic_merge', status: 'pass', evidence: 'Maker execution did not merge, push, or deploy.' },
    ];

    const failed = gates.some((gate) => gate.status === 'fail');
    const completionStatus = failed ? 'failed' : 'completed';
    const wasCancelled = this.loopService.isWorkerLeaseCancelled(makerLease.id);

    const metadataPatch: Record<string, unknown> = {
      completed_at: new Date().toISOString(), stdout_path: stdoutPath, stderr_path: stderrPath,
      diff_lines: diffLines, diff_max_lines: diffMaxLines, exit_status: exitStatus, timed_out: timedOut,
      runtime_adapter: makerLease.runtime, runtime_contract: runtimeContract, runtime_pid: result.runtimePid,
      runtime_signal: result.signal, runtime_timed_out: result.timedOut, runtime_timed_out_at: result.timedOutAt,
      runtime_warnings: runtimeWarnings, token_efficiency: efficiency,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' },
    };

    if (wasCancelled) {
      this.loopService.patchWorkerLeaseMetadata(makerLease.id, { ...metadataPatch, runtime_was_cancelled: true });
    } else {
      this.loopService.updateWorkerLeaseStatus(makerLease.id, completionStatus, metadataPatch);
    }

    const budgetRisk = tokenBudget.efficiencyExceeded
      ? { type: 'token_efficiency' as const, lease_id: makerLease.id, runtime_usage: runtimeUsage ? { total_tokens: runtimeUsage.total_tokens } : { usage_source: 'unknown' }, budget: tokenBudget.budget }
      : null;

    this.updateRunAndRecord(run, makerLease, failed, wasCancelled, gates, budgetRisk, stdoutPath, stderrPath, runtimeUsage, runtimeWarnings, efficiency, tokenBudget, result, runtimeContract);

    const completedLease = this.loopService.getWorkerLease(makerLease.id);
    if (!wasCancelled && completionStatus === 'completed') {
      return { run: failed ? this.loopService.escalateIfFailureThresholdExceeded(run.id, 'maker_execution_failed') : this.loopService.getLoopRun(run.id), lease: completedLease, gates, stdout_path: stdoutPath, stderr_path: stderrPath };
    }

    this.db.prepare('UPDATE loop_runs SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ? WHERE id = ?').run(
      failed ? 'blocked' : 'verifying', JSON.stringify(gates),
      JSON.stringify(failed ? ['Inspect maker output and revise or retry'] : ['Run checker review', 'Run verify gates before completion']),
      new Date().toISOString(), run.id,
    );

    return { run: this.loopService.getLoopRun(run.id), lease: completedLease, gates, stdout_path: stdoutPath, stderr_path: stderrPath };
  }

  async executeChecker(id: string, input: ExecuteCheckerInput = {}): Promise<ExecuteWorkerResult> {
    const run = this.loopService.getLoopRun(id);
    const leases = this.loopService.listWorkerLeases(run.id);
    const checker = input.lease_id
      ? leases.find((candidate) => candidate.id === input.lease_id)
      : leases.find((candidate) => candidate.role === 'checker' && candidate.status === 'prepared');

    if (!checker) throw new Error('CHECKER_LEASE_NOT_FOUND');
    if (checker.role !== 'checker') throw new Error('LEASE_NOT_CHECKER');

    const makerLeaseId = checker.metadata.maker_lease_id as string | undefined;
    if (!makerLeaseId) throw new Error('CHECKER_MAKER_LINK_MISSING');
    const maker = leases.find((lease) => lease.id === makerLeaseId);
    if (!maker || maker.status !== 'completed') throw new Error('CHECKER_MAKER_NOT_COMPLETED');
    if (!maker.worktree_path || !fs.existsSync(maker.worktree_path)) throw new Error('MAKER_WORKTREE_NOT_FOUND');

    const runtime = input.runtime || (checker.runtime !== 'manual' ? checker.runtime : 'mock');
    const runtimeContract = this.loopService.getRuntimeContract(runtime);

    this.loopService.recordWorkerManifest({
      decisionId: this.loopService.makeManifestDecisionId(run.id, checker.id, 'start'),
      loopRunId: run.id, leaseId: checker.id, action: 'start', runtimeContract,
      capacitySnapshot: this.loopService.currentCapacitySnapshot(), budgetSnapshot: this.loopService.currentBudgetSnapshot(run),
      gateRefs: ['runtime_contract'], blockedReasons: [],
      metadata: { worker_role: checker.role, worker_runtime: runtime, maker_lease_id: checker.metadata.maker_lease_id, started_from: 'executeChecker' },
    });

    this.loopService.updateWorkerLeaseRuntime(checker.id, runtime);

    if (!runtimeContract.available || runtimeContract.status !== 'ok') {
      this.loopService.recordWorkerManifest({
        decisionId: this.loopService.makeManifestDecisionId(run.id, checker.id, 'fail'),
        loopRunId: run.id, leaseId: checker.id, action: 'fail', runtimeContract,
        capacitySnapshot: this.loopService.currentCapacitySnapshot(), budgetSnapshot: this.loopService.currentBudgetSnapshot(run),
        gateRefs: ['runtime_contract'], blockedReasons: ['runtime_contract_drift'],
        metadata: { worker_role: checker.role, worker_runtime: runtime, maker_lease_id: checker.metadata.maker_lease_id, reason: 'runtime_contract_unavailable_or_drifted', started_from: 'executeChecker' },
      });
      this.loopService.updateWorkerLeaseStatus(checker.id, 'failed', { runtime_contract: runtimeContract, runtime_contract_failed_at: new Date().toISOString() });
      throw new Error('RUNTIME_CONTRACT_DRIFTED');
    }

    const traceId = `loop-${run.id}-checker-${checker.id}`;
    const checkpointBefore = this.loopService.assurance.createCheckpoint({ loop_run_id: run.id, label: `before checker ${checker.id}`, metadata: { worker_lease_id: checker.id, maker_lease_id: maker.id, worker_role: checker.role, worker_runtime: runtime, phase: 'before_checker_execution' } });
    this.loopService.patchWorkerLeaseMetadata(checker.id, { checkpoint_before_id: checkpointBefore.id, trace_id: traceId, runtime_adapter: runtime });
    this.loopService.assurance.createTraceSpan({ trace_id: traceId, loop_run_id: run.id, span_type: 'worker', name: `${checker.role}:${runtime}:spawn`, status: 'running', evidence_ref: `loop:${run.id}/checker:${checker.id}`, metadata: { worker_lease_id: checker.id, maker_lease_id: maker.id, role: checker.role, runtime, checkpoint_before_id: checkpointBefore.id } });
    this.loopService.updateWorkerLeaseStatus(checker.id, 'running', { started_at: new Date().toISOString(), runtime_adapter: runtime });

    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const prompt = this.loopService.buildCheckerPrompt(run, maker, checker);
    const skipPermissions = this.loopService.resolveSkipPermissions(input.skip_permissions);
    const { command, args } = runtime === 'mock'
      ? this.loopService.buildMockCheckerCommand(maker.worktree_path!, prompt)
      : this.loopService.buildRuntimeCommand(runtime, maker.worktree_path!, prompt, skipPermissions);
    const result = await this.loopService.runtimeCommand.executeRuntimeCommand(checker.id, command, args, {
      cwd: maker.worktree_path!, timeoutMs, enforceCwdBoundary: runtime !== 'mock', maxBuffer: 5 * 1024 * 1024,
      env: this.loopService.buildNestedSpawnEnv(checker) ?? undefined,
    });

    const { stdoutPath, stderrPath } = this.writeOutput(run.id, checker.id, 'checker-output', result.stdout || '', result.stderr || '');
    const exitStatus = result.exitCode;
    const timedOut = result.timedOut;
    const runtimeUsage = this.loopService.extractRuntimeUsage(result.stdout || '');
    const runtimeWarnings = this.loopService.extractRuntimeWarnings(result.stdout || '', result.stderr || '');
    const verdict = exitStatus === 0 && !timedOut ? this.loopService.extractCheckerVerdict(result.stdout || '') : 'insufficient_evidence';

    this.loopService.updateWorkerLeaseStatus(checker.id, exitStatus === 0 && !timedOut ? 'completed' : 'failed', {
      verdict, notes: this.loopService.extractCheckerNotes(result.stdout || '') || `Checker runtime ${exitStatus === 0 && !timedOut ? 'completed' : 'failed'}.`,
      maker_lease_id: maker.id, completed_at: new Date().toISOString(), stdout_path: stdoutPath, stderr_path: stderrPath,
      exit_status: exitStatus, timed_out: timedOut, runtime_pid: result.runtimePid, runtime_signal: result.signal,
      runtime_timed_out: result.timedOut, runtime_timed_out_at: result.timedOutAt, runtime_adapter: runtime,
      runtime_contract: runtimeContract, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings,
    });

    const gates: LoopGate[] = [
      { name: 'checker_runtime_exit_zero', status: exitStatus === 0 && !timedOut ? 'pass' : 'fail', evidence: `runtime=${runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}` },
      { name: 'checker_verdict', status: verdict === 'accepted' ? 'pass' : 'fail', evidence: `checker verdict=${verdict}` },
      { name: 'checker_read_only_contract', status: 'pass', evidence: 'Checker prompt forbids file mutation, merge, push, deploy, secret and policy edits.' },
    ];

    const failed = gates.some((gate) => gate.status === 'fail');
    const existingRun = this.loopService.getLoopRun(run.id);
    const mergedGates = this.loopService.mergeGates(existingRun.gates, gates);

    this.db.prepare('UPDATE loop_runs SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ? WHERE id = ?').run(
      failed ? 'blocked' : 'verifying', JSON.stringify(mergedGates),
      JSON.stringify(failed ? ['Inspect checker output and retry, split, or revise'] : ['Run verify gates before completion']),
      new Date().toISOString(), run.id,
    );

    this.loopService.recordLoopEvent(run.id, 'checker_executed', failed ? 'warning' : 'info', `Checker lease ${checker.id} ${failed ? 'failed gates' : 'completed'}.`, { checker_lease_id: checker.id, maker_lease_id: maker.id, verdict, gates, stdout_path: stdoutPath, stderr_path: stderrPath, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings });
    this.loopService.recordWorkerManifest({
      decisionId: this.loopService.makeManifestDecisionId(run.id, checker.id, failed ? 'fail' : 'complete'),
      loopRunId: run.id, leaseId: checker.id, action: failed ? 'fail' : 'complete', runtimeContract,
      capacitySnapshot: this.loopService.currentCapacitySnapshot(), budgetSnapshot: this.loopService.currentBudgetSnapshot(run),
      gateRefs: gates.map((g) => g.name), blockedReasons: gates.filter((g) => g.status === 'fail').map((g) => `${g.name}: ${g.evidence}`),
      metadata: { worker_role: checker.role, worker_runtime: runtime, maker_lease_id: maker.id, verdict, runtime_pid: result.runtimePid, runtime_signal: result.signal, runtime_timed_out: result.timedOut, runtime_timed_out_at: result.timedOutAt, exit_status: exitStatus, timed_out: timedOut, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings, started_from: 'executeChecker' },
    });

    this.loopService.assurance.createTraceSpan({ trace_id: traceId, loop_run_id: run.id, span_type: 'worker', name: `${checker.role}:${runtime}:completion`, status: failed ? 'error' : 'ok', evidence_ref: stdoutPath, metadata: { worker_lease_id: checker.id, maker_lease_id: maker.id, role: checker.role, runtime, stdout_path: stdoutPath, stderr_path: stderrPath, gates, verdict } });
    const checkpointAfter = this.loopService.assurance.createCheckpoint({ loop_run_id: run.id, label: `after checker ${checker.id}`, metadata: { worker_lease_id: checker.id, maker_lease_id: maker.id, worker_role: checker.role, worker_runtime: runtime, phase: 'after_checker_execution' } });
    this.loopService.patchWorkerLeaseMetadata(checker.id, { checkpoint_after_id: checkpointAfter.id });

    return {
      run: failed ? this.loopService.escalateIfFailureThresholdExceeded(run.id, 'checker_execution_failed') : this.loopService.getLoopRun(run.id),
      lease: this.loopService.listWorkerLeases(run.id).find((c) => c.id === checker.id)!,
      gates, stdout_path: stdoutPath, stderr_path: stderrPath,
      checkpoint_before: checkpointBefore, checkpoint_after: checkpointAfter,
      trace: this.loopService.assurance.getTrace(traceId),
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private updateRunAndRecord(
    run: LoopRunRecord, makerLease: WorkerLeaseRecord, failed: boolean, wasCancelled: boolean,
    gates: LoopGate[], budgetRisk: any, stdoutPath: string, stderrPath: string,
    runtimeUsage: RuntimeUsage | null, runtimeWarnings: any, efficiency: any,
    tokenBudget: any, result: any, runtimeContract: RuntimeContract,
  ): void {
    this.db.prepare("UPDATE loop_runs SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ?, metadata = json_set(COALESCE(metadata, '{}'), '$.budget_risk', json(?)) WHERE id = ?").run(
      wasCancelled ? this.loopService.getLoopRun(run.id).status : (failed ? 'blocked' : 'verifying'),
      JSON.stringify(gates),
      JSON.stringify(failed ? ['Inspect maker output and revise or retry'] : ['Run checker review', 'Run verify gates before completion']),
      new Date().toISOString(), JSON.stringify(budgetRisk), run.id,
    );

    this.loopService.recordLoopEvent(run.id, 'maker_executed', failed ? 'warning' : 'info', `Maker lease ${makerLease.id} ${failed ? 'failed gates' : wasCancelled ? 'stopped' : 'completed'}.`, {
      lease_id: makerLease.id, gates, stdout_path: stdoutPath, stderr_path: stderrPath,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings,
      token_efficiency: efficiency, runtime_cancelled: wasCancelled,
    });

    if (tokenBudget.exhausted) {
      this.loopService.recordLoopEvent(run.id, 'loop_budget_exhausted', 'warning', 'Token budget exhausted by maker runtime usage.', { budget_type: 'tokens', lease_id: makerLease.id, runtime_usage: runtimeUsage, token_budget: tokenBudget.budget });
    }
    if (budgetRisk) {
      this.loopService.recordLoopEvent(run.id, 'token_efficiency_budget_risk', 'warning', 'Token efficiency exceeded configured per-diff-line budget.', { lease_id: makerLease.id, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, budget: budgetRisk });
    }

    this.loopService.recordWorkerManifest({
      decisionId: this.loopService.makeManifestDecisionId(run.id, makerLease.id, failed ? 'fail' : 'complete'),
      loopRunId: run.id, leaseId: makerLease.id, action: wasCancelled ? 'stop' : failed ? 'fail' : 'complete',
      runtimeContract, capacitySnapshot: this.loopService.currentCapacitySnapshot(),
      budgetSnapshot: this.loopService.currentBudgetSnapshot(run, runtimeUsage),
      gateRefs: gates.map((g) => g.name), blockedReasons: gates.filter((g) => g.status === 'fail').map((g) => `${g.name}: ${g.evidence}`),
      metadata: { worker_role: makerLease.role, worker_runtime: makerLease.runtime, exit_status: result.exitCode, timed_out: result.timedOut, runtime_pid: result.runtimePid, runtime_signal: result.signal, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings, token_efficiency: efficiency, started_from: 'executeMaker', run_canceled: wasCancelled },
    });
  }

  private writeOutput(runId: string, leaseId: string, subDir: string, stdout: string, stderr: string): { stdoutPath: string; stderrPath: string } {
    const outputDir = path.join(this.loopService.evidenceRoot, runId, subDir, leaseId);
    fs.mkdirSync(outputDir, { recursive: true });
    const stdoutPath = path.join(outputDir, 'stdout.log');
    const stderrPath = path.join(outputDir, 'stderr.log');
    fs.writeFileSync(stdoutPath, stdout, 'utf8');
    fs.writeFileSync(stderrPath, stderr, 'utf8');
    return { stdoutPath, stderrPath };
  }
}
