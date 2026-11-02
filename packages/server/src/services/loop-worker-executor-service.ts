/**
 * LoopWorkerExecutorService — handles maker and checker worker execution.
 *
 * Extracted from LoopService to reduce its 4535 LOC. This service owns the
 * worker orchestration, gate evaluation, and result persistence for maker and
 * checker roles. Real runtimes dispatch through ExecutionEngine.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { skillAssignment } from './executable-skills';
import { ExecutionEngine } from '../execution/execution-engine';
import { createError } from '../middleware/error-handler';
import type { ExecutionResult, ExecutorKind } from '../execution/types';
import type { LoopService } from './loop-service';
import { judgmentMode, runJudgment } from './judgment-service';
import { leaseIdentity } from './reviewer-independence-service';
import { checkerSecondOpinion, checkerSecondOpinionState } from './judgments/checker-second-opinion';
import { withoutHiddenChecks } from './fail-before-pass-after';
import { remoteMakerCancelReason } from '../execution/executors/remote-maker-executor';
import { SUBSCRIPTION_ENV_MARKER } from '../execution/executors/subscription-env';
import { recordPolicyViolation } from './policy-violations';
import { computeTokenAccounting, safeTokenAccounting } from './maker-token-accounting';
import { captureMakerDiff } from './maker-diff-capture';
import { assignMakerDepsArm, makerDeps001On, makerDepsEligible } from './maker-deps-001';
import { applyOutageFallback, fallbackRefusal, isFallbackLease } from './ollama-outage-fallback';
import { noteOllamaOutput } from './inference-failover';
import { isSubscriptionLimit, LIMIT_HIT } from './subscription-gym';
import { classifyStderr, STDERR_TAIL_CHARS, type FailureStage, type LeaseFailure } from './lease-failure';
import { makerWarmDepsBlocked, warmDepsCacheRoot, warmDepsState } from './maker-warm-deps';
import { asgAfterMaker, asgBeforeMaker, type AsgMakerOutcome } from './asg/oracle-lane';
import { asgMode } from './asg/mode';
import { recordWorkerCall } from './model-call-ledger';
import type {
  LoopRunRecord,
  WorkerLeaseRecord,
  LoopGate,
  RuntimeContract,
  RuntimeExecutionResult,
  RuntimeUsage,
} from './loop-types';

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

/** A worker lease's open lifecycle span (OPS-004): the worker span and its run-span parent. */
type LeaseSpan = { runSpanId: string; workerSpanId: string; leaseId: string };
/** What executeChecker learns from runChecker: the reviewer's span and the lease this call set running. */
type ReviewerDispatch = { current?: LeaseSpan | null; leaseId?: string };

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


export const TEST_ONLY_DIFF_MAX = 400;
/** Every changed file is a test (``__tests__/``, ``*.test.*`` or ``*.spec.*``); no changes is not test-only. */
export function testOnlyChange(files: string[]): boolean {
  return files.length > 0 && files.every((f) => /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
}

/**
 * The jev second opinion runs once per maker: the security checker sees the same task and diff, so recording it for both
 * reviewers produced two identical rows per maker (prod 2026-10-02) and double-counted every maker in calibration.
 */
export function shouldRecordSecondOpinion(runtime: string, reviewRole: string, mode: string): boolean {
  return runtime !== 'mock' && reviewRole === 'checker' && mode !== 'off';
}

/**
 * What the runtime itself showed, as the hint for the lease's structured failure (lease-failure.ts); WorkerLeaseRepo fills the
 * rest (a cancel's stage and reason, the reason-text class). The engine path reports the child's exit apart from the gate's
 * 0/1; a direct runtime command's exitCode is the child's own.
 */
export function runtimeFailureHint(result: RuntimeExecutionResult, stage: FailureStage, tokenBudgetGateFailed = false): Partial<LeaseFailure> {
  const stderr = (result.stderr || '').slice(-STDERR_TAIL_CHARS);
  const message = result.runtimeMessage ?? '';
  const observed = result.exitObserved ?? true;
  return {
    stage,
    exit_observed: observed,
    exit_code: !observed ? null : result.exitObserved === undefined ? result.exitCode : result.processExitCode ?? null,
    signal: result.signal ?? null,
    timed_out: result.timedOut === true,
    token_budget_hit: result.tokenBudgetHit === true || tokenBudgetGateFailed,
    stderr_class: classifyStderr(`${stderr}\n${message}`),
    stderr_source: stderr.trim() ? 'stderr' : message.trim() ? 'reason' : 'none',
  };
}

export class LoopWorkerExecutorService {
  constructor(
    private db: any,
    private loopService: LoopService,
    private executionEngine?: ExecutionEngine,
  ) {}

  /**
   * A throw between marking the maker lease 'running' and settling it left the lease 'running' forever (prod 2026-09-26:
   * lease 29de65a9 ran 'running' for 3 h after its task had failed, and every auto-deploy and gym attempt counted it as
   * busy). Leases this call started and that are still 'running' are failed with the error; the approval/in-progress
   * paths put the lease back to 'prepared' before throwing, so they are untouched.
   */
  async executeMaker(id: string, input: ExecuteMakerInput = {}): Promise<ExecuteWorkerResult> {
    const since = new Date().toISOString();
    const span = this.openMakerSpan(id, input);
    let execution: ExecuteWorkerResult | undefined;
    let errorMessage: string | undefined;
    try {
      execution = await this.runMaker(id, input);
      return execution;
    } catch (err) {
      const stuck = this.db.prepare("SELECT id FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'running' AND json_extract(metadata, '$.started_at') >= ?")
        .all(id, since) as Array<{ id: string }>;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      errorMessage = message;
      for (const lease of stuck) this.loopService.updateWorkerLeaseStatus(lease.id, 'failed', { failure_reason: `maker_execution_error: ${message}`, failed_at: new Date().toISOString(),
        failure: { stderr_class: classifyStderr(message), stderr_source: 'reason' } });
      throw err;
    } finally {
      if (span) this.closeLeaseSpan(span, execution, errorMessage);
    }
  }

  /**
   * OPS-004: one lifecycle span per maker lease — a worker span, child of a run span, in `loop-<run>-worker-<lease>`.
   * Opened at the first dispatch of a prepared lease; a resumed call (after an approval / in-progress exit, which leaves the
   * lease 'prepared') reuses the lease's open span (found by its trace id) instead of opening a second one. Lease metadata
   * is not touched. Never throws.
   */
  private openMakerSpan(runId: string, input: ExecuteMakerInput): LeaseSpan | null {
    try {
      const run = this.loopService.getLoopRun(runId);
      const leases = this.loopService.listWorkerLeases(run.id);
      const lease = input.lease_id ? leases.find((l) => l.id === input.lease_id) : leases.find((l) => l.role === 'maker' && l.status === 'prepared');
      if (!lease) return null;
      // nothing to dispatch when not prepared: runMaker refuses it, no span for a refusal
      return this.openLeaseSpan(run, lease, `loop-${run.id}-worker-${lease.id}`, `loop:${run.id}/worker:${lease.id}`, lease.runtime, {}, lease.status === 'prepared');
    } catch {
      return null; // tracing never blocks a maker
    }
  }

  /**
   * One lifecycle span per worker lease (maker or reviewer): a worker span, child of a run span, in the lease's own trace.
   * A resumed call reuses the lease's open span (found by trace id) instead of opening a second one; a new pair is opened
   * only when `create`. Never throws. trg_worker_lease_settles_trace closes it on every settle path outside the caller.
   */
  private openLeaseSpan(run: LoopRunRecord, lease: WorkerLeaseRecord, traceId: string, evidenceRef: string, runtime: string,
    metadata: Record<string, unknown>, create = true): LeaseSpan | null {
    try {
      const open = this.db.prepare(`SELECT id, parent_span_id FROM agent_trace_spans WHERE trace_id = ? AND span_type = 'worker'
        AND ended_at IS NULL AND parent_span_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(traceId) as { id: string; parent_span_id: string } | undefined;
      if (open) return { runSpanId: open.parent_span_id, workerSpanId: open.id, leaseId: lease.id };
      if (!create) return null;
      const assurance = this.loopService.assurance;
      const runSpan = assurance.createTraceSpan({ trace_id: traceId, loop_run_id: run.id, span_type: 'loop', name: `loop_run:${run.id}`, status: 'running',
        evidence_ref: `loop:${run.id}`, metadata: { loop_name: run.loop_name, scope: 'worker_trace', worker_lease_id: lease.id } });
      const workerSpan = assurance.createTraceSpan({ trace_id: traceId, parent_span_id: runSpan.id, loop_run_id: run.id, span_type: 'worker',
        name: `${lease.role}:${runtime}`, status: 'running', evidence_ref: evidenceRef,
        metadata: { worker_lease_id: lease.id, role: lease.role, runtime, ...metadata } });
      return { runSpanId: runSpan.id, workerSpanId: workerSpan.id, leaseId: lease.id };
    } catch {
      return null; // tracing never blocks a worker
    }
  }

  /** Close the span only when the lease settled (completed / failed / cancelled); an approval / in-progress exit keeps it open. */
  private closeLeaseSpan(span: LeaseSpan, execution: ExecuteWorkerResult | undefined, errorMessage: string | undefined): void {
    const endedAt = new Date().toISOString(); // the settle time, before the caller's bookkeeping
    try {
      const leaseStatus = (this.db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(span.leaseId) as { status: string } | undefined)?.status;
      if (leaseStatus !== 'completed' && leaseStatus !== 'failed' && leaseStatus !== 'cancelled') return;
      const terminal = leaseStatus === 'completed' && !errorMessage ? 'ok' : leaseStatus === 'cancelled' ? 'cancelled' : 'error';
      const status = terminal === 'ok' ? 'ok' : 'error'; // the span schema has no 'cancelled': a cancel is a terminal failure
      const assurance = this.loopService.assurance;
      const closed = { terminal_status: terminal, lease_status: leaseStatus };
      try {
        assurance.finishTraceSpan(span.workerSpanId, { status, ended_at: endedAt, metadata: {
          ...closed,
          ...(errorMessage ? { error: errorMessage } : {}),
          ...(execution ? { stdout_path: execution.stdout_path, stderr_path: execution.stderr_path, gates: execution.gates } : {}),
          ...(typeof execution?.lease?.metadata?.verdict === 'string' ? { verdict: execution.lease.metadata.verdict } : {}),
        } });
      } catch {
        // secret-like detail is refused; the span still closes
        assurance.finishTraceSpan(span.workerSpanId, { status, ended_at: endedAt, metadata: { ...closed, detail_withheld: true } });
      }
      assurance.finishTraceSpan(span.runSpanId, { status, ended_at: endedAt, metadata: { terminal_status: terminal } });
    } catch { /* tracing never masks the worker's outcome */ }
  }

  private async runMaker(id: string, input: ExecuteMakerInput = {}): Promise<ExecuteWorkerResult> {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertOperatorNotPaused(run);
    this.loopService.assertWallClockBudgetAvailable(run);
    const leases = this.loopService.listWorkerLeases(run.id);
    const makerLease = input.lease_id
      ? leases.find((lease) => lease.id === input.lease_id)
      : leases.find((lease) => lease.role === 'maker' && lease.status === 'prepared');

    if (!makerLease) throw new Error('MAKER_LEASE_NOT_FOUND');
    if (makerLease.role !== 'maker' && makerLease.metadata.nested_spawn !== true) throw new Error('LEASE_NOT_MAKER');
    if (makerLease.status !== 'prepared') throw new Error('MAKER_LEASE_NOT_PREPARED');
    if (!makerLease.worktree_path || !fs.existsSync(makerLease.worktree_path)) {
      this.loopService.recordMakerFailure(run.id, makerLease.id, 'MAKER_WORKTREE_NOT_FOUND', 'Worktree path does not exist');
      throw new Error('MAKER_WORKTREE_NOT_FOUND');
    }
    if (makerLease.runtime === 'manual') {
      this.loopService.recordMakerFailure(run.id, makerLease.id, 'MANUAL_MAKER_REQUIRES_HUMAN', 'Manual runtime requires human intervention');
      throw new Error('MANUAL_MAKER_REQUIRES_HUMAN');
    }
    // OLLAMA_OUTAGE_FALLBACK_RUNTIME: the effective runtime of this maker (an opencode lease → claude on the subscription)
    applyOutageFallback(this.db, run, makerLease, makerLease.runtime);
    this.refuseFallbackSpawn(run, makerLease);

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
      this.loopService.updateWorkerLeaseStatus(makerLease.id, 'failed', { runtime_adapter: makerLease.runtime, runtime_contract: runtimeContract, runtime_contract_failed_at: new Date().toISOString(), failure_reason: 'runtime_contract_unavailable_or_drifted', failure: { stage: 'prepare' } });
      throw new Error('RUNTIME_CONTRACT_DRIFTED');
    }

    // a deploy between preparing and running (e.g. a maker waiting for its approval) leaves the worktree unlinked
    if (run.repository_path && makerLease.worktree_path && makerLease.branch_name
      && this.loopService.repairWorktree(run.repository_path, makerLease.worktree_path, makerLease.branch_name)) {
      this.loopService.recordLoopEvent(run.id, 'worktree_repaired', 'warning', 'Maker worktree was unlinked from the runtime repository (a deploy in between); re-registered on its branch.', { maker_lease_id: makerLease.id });
    }
    // MAKER-DEPS-001 (pre-registered, MAKER_DEPS_001_MODE): the arm is recorded before the maker starts; arm B gets the checks'
    // own install first. Local opencode makers of goal runs only (never TG-001, the gym or remote); caps and prompt are the same.
    // MAKER_WARM_DEPS (default off) refuses to act while MAKER-DEPS-001 runs: both arms stay exactly as pre-registered
    const warm = warmDepsState();
    if (warm === 'blocked_by_experiment') makerWarmDepsBlocked();
    if (makerDeps001On() && run.goal_id && makerDepsEligible({ runtime: makerLease.runtime, role: makerLease.role, goal_id: run.goal_id, loop_name: run.loop_name })) {
      const assigned = assignMakerDepsArm(this.db, run.id, makerLease, run.goal_id);
      if (assigned.arm === 'B') {
        const prep = this.loopService.prepareMakerWorktree(run.id, makerLease.id, makerLease.worktree_path!);
        this.loopService.recordLoopEvent(run.id, 'maker_worktree_prepared', prep.install_failed || prep.shared_failed ? 'warning' : 'info',
          `MAKER-DEPS-001 arm B: dependencies prepared before the maker started (installed=${prep.installed}, shared_built=${prep.shared_built}${prep.install_failed || prep.shared_failed ? '; failed, the maker runs as in arm A' : ''}).`,
          { maker_lease_id: makerLease.id, arm: assigned.arm, experiment: assigned.experiment, version: assigned.version, ...prep });
      }
    } else if (warm === 'on' && run.goal_id && makerDepsEligible({ runtime: makerLease.runtime, role: makerLease.role, goal_id: run.goal_id, loop_name: run.loop_name })) {
      // arm B's preparation, with node_modules from a lockfile-keyed cache: the candidate default once MAKER-DEPS-001 reads out
      const prep = this.loopService.prepareMakerWorktree(run.id, makerLease.id, makerLease.worktree_path!, { warmDepsRoot: warmDepsCacheRoot() });
      if (prep.warm_deps) this.loopService.patchWorkerLeaseMetadata(makerLease.id, { deps_source: prep.warm_deps.deps_source, warm_deps: prep.warm_deps });
      this.loopService.recordLoopEvent(run.id, 'maker_warm_deps', prep.install_failed || prep.shared_failed ? 'warning' : 'info',
        `MAKER_WARM_DEPS: dependencies ${prep.warm_deps ? `from ${prep.warm_deps.deps_source}` : 'already present'} before the maker started (shared_built=${prep.shared_built}${prep.install_failed || prep.shared_failed ? '; failed, the maker runs without them' : ''}).`,
        { maker_lease_id: makerLease.id, ...prep });
    }
    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const prompt = fs.readFileSync(this.loopService.resolveWorkAssignmentPath(makerLease), 'utf8');
    const skipPermissions = this.loopService.resolveSkipPermissions(input.skip_permissions);
    // ASG-001 (ASG_MODE, default off; docs/research/asg-001): oracle-lane makers only. off = this block never runs.
    const asg = asgMode() === 'off' ? null : asgBeforeMaker(this.db, run, makerLease, (cwd, args) => this.loopService.git(cwd, args));
    if (asg) {
      this.loopService.patchWorkerLeaseMetadata(makerLease.id, { asg: { mode: asg.mode, requested: asg.requested, blocked_by: asg.blocked_by, attempt_id: asg.attempt_id, lane: asg.lane,
        decision: asg.decision, route_executed: asg.route_executed, base: asg.base, spec: { targets: asg.spec.targets, declared_writes: asg.spec.declared_writes, capability: asg.spec.capability } } });
      this.loopService.recordLoopEvent(run.id, 'asg_route', 'info',
        `ASG ${asg.mode}: route ${asg.decision.route} (${asg.decision.reason_codes.join(',')}), executed ${asg.route_executed}; policy ${asg.decision.policy.hash}.`,
        { maker_lease_id: makerLease.id, mode: asg.mode, blocked_by: asg.blocked_by, route: asg.decision.route, route_executed: asg.route_executed, reason_codes: asg.decision.reason_codes,
          policy: asg.decision.policy, feature_schema_hash: asg.decision.feature_schema_hash, features: asg.decision.features, alternatives: asg.decision.alternatives });
    }
    const makerStartedAt = Date.now();
    const result = makerLease.runtime === 'mock'
      ? await this.executeMockWorker(makerLease, prompt, timeoutMs, skipPermissions)
      : await this.executeViaEngine(run, makerLease, makerLease.runtime, prompt, makerLease.worktree_path!, timeoutMs, skipPermissions,
        this.riskAssessmentText(makerLease, prompt));

    const { stdoutPath, stderrPath } = this.writeOutput(run.id, makerLease.id, 'worker-output', result.stdout || '', result.stderr || '');
    // A lockfile rewrite without a dependency change is install noise (prod 2026-09-23: npm install flipped hasInstallScript),
    // never the intended change; restore it so a test-only diff stays test-only, and record that we did.
    const changed = this.loopService.git(makerLease.worktree_path!, ['diff', '--name-only', '--', '.']).split('\n').filter(Boolean);
    if (changed.includes('package-lock.json') && !changed.includes('package.json')) {
      this.loopService.git(makerLease.worktree_path!, ['checkout', '--', 'package-lock.json']);
      this.loopService.recordLoopEvent(run.id, 'maker_lockfile_restored', 'warning', 'package-lock.json changed without a package.json change; restored before review.', { maker_lease_id: makerLease.id });
    }
    const diff = this.loopService.workingTreeDiff(makerLease.worktree_path!);
    // new files are untracked, so name-only diff alone misses them; LOOP_WORK.md lives under .djimitflo/
    const changedFiles = [...changed, ...this.loopService.git(makerLease.worktree_path!, ['ls-files', '--others', '--exclude-standard']).split('\n')]
      .filter((f) => f && f !== 'package-lock.json' && !f.startsWith('.djimitflo/'));
    const diffLines = diff ? diff.split(/\r?\n/).filter(Boolean).length : 0;
    // Y0a (operator 2026-10-01): a test-only change may use the mutation lane's 400 lines — 9 of 104 makers in 14 days wrote a
    // complete new test file of 207–412 lines and were rejected at 200 (completed ones peaked at 192)
    const diffMaxLines = Math.max(1, Math.min(testOnlyChange(changedFiles) ? Math.max(input.diff_max_lines || 200, TEST_ONLY_DIFF_MAX) : (input.diff_max_lines || 200), 2_000));
    const exitStatus = result.exitCode;
    const timedOut = result.timedOut;
    const fallbackLimited = this.fallbackLimitHit(makerLease, exitStatus, result);
    this.noteOpencodeLimit(makerLease.runtime, 'maker', exitStatus, result);
    const runtimeUsage = this.loopService.extractRuntimeUsage(result.stdout || '');
    const runtimeWarnings = this.loopService.extractRuntimeWarnings(result.stdout || '', result.stderr || '');
    // §5 token accounting: what the runtime reported, never fabricated; a failure here is recorded, never changes the outcome
    const tokenAccounting = safeTokenAccounting(() => computeTokenAccounting({ runtime: makerLease.runtime, stdout: result.stdout || '',
      leaseMetadata: makerLease.metadata || {}, durationMs: Date.now() - makerStartedAt }), makerLease.runtime);
    const tokenBudget = this.loopService.evaluateTokenBudget(run, runtimeUsage, makerLease.id, diffLines);
    const efficiency = this.loopService.calculateWorkerEfficiency(runtimeUsage, diffLines);

    // ASG-001: expected vs observed effects; in `on`, a bounded timeout/brake whose declared test passes is succeeded_with_incident
    const asgOutcome: AsgMakerOutcome | null = asg ? asgAfterMaker(asg, { exitCode: result.exitCode, timedOut: result.timedOut, tokenBudgetHit: result.tokenBudgetHit }, changedFiles, makerLease.worktree_path!, skipPermissions) : null;
    const gates: LoopGate[] = [
      { name: 'maker_runtime_exit_zero', status: exitStatus === 0 && !timedOut ? 'pass' : 'fail', evidence: `runtime=${makerLease.runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}, skip_permissions=${skipPermissions}` },
      { name: 'diff_under_threshold', status: diffLines <= diffMaxLines ? 'pass' : 'fail', evidence: `${diffLines} changed diff line(s), threshold ${diffMaxLines}.` },
      tokenBudget.gate,
      { name: 'runtime_warning_gate', status: this.loopService.runtimeWarningsBlockCompletion(runtimeWarnings, run) ? 'fail' : 'pass', evidence: this.loopService.runtimeWarningsEvidence(runtimeWarnings, run) },
      { name: 'no_automatic_merge', status: 'pass', evidence: 'Maker execution did not merge, push, or deploy.' },
    ];
    if (asgOutcome?.rescued) gates.push({ name: 'asg_end_state_verified', status: 'pass', evidence: `ASG on: runtime stopped (${asgOutcome.incident?.timed_out ? 'timeout' : 'token brake'}), effects ${asgOutcome.effects.observed.join(', ')} inside the declared write set, ${asgOutcome.verifier?.command} exit 0; incident recorded, maker_runtime_exit_zero kept as evidence.` });

    // §16 step 8 (shadow, POLICY_VIOLATION_LOG): the diff gate above already decided; this only counts the breach
    if (diffLines > diffMaxLines) recordPolicyViolation(this.db, { kind: 'diff_limit', actor: `maker:${makerLease.runtime}`, severity: 'medium', dedupe_key: makerLease.id,
      run_id: run.id, lease_id: makerLease.id, evidence_ref: `loop_run:${run.id}/lease:${makerLease.id}/gate:diff_under_threshold`,
      description: `${diffLines} changed diff line(s) over threshold ${diffMaxLines}` });
    // ASG on: only the runtime-exit gate is answered by the verified end state; every other gate still decides
    const failed = gates.some((gate) => gate.status === 'fail' && !(asgOutcome?.rescued && gate.name === 'maker_runtime_exit_zero'));
    const completionStatus = failed ? 'failed' : 'completed';
    const wasCancelled = this.loopService.isWorkerLeaseCancelled(makerLease.id);
    const remoteCancel = makerLease.runtime === 'remote' ? remoteMakerCancelReason(result.stderr) : null;

    // §3d P0 #1: both risk inputs, recorded; the effective risk is their max (verifyLoopRun recomputes it from changed_files)
    const leaseFinding = run.findings.find((candidate) => candidate.id === makerLease.finding_id);
    const textRisk = this.loopService.highRiskReason(run, leaseFinding) ?? (this.loopService.isHighRiskRun(run) ? 'run_findings_text' : null);
    const changedFilesRisk = this.loopService.changedFilesRiskReason(changedFiles);
    const metadataPatch: Record<string, unknown> = {
      risk_inputs: { text_risk_reason: textRisk, changed_files_risk_reason: changedFilesRisk, effective_risk: textRisk || changedFilesRisk ? 'high' : 'low' },
      completed_at: new Date().toISOString(), stdout_path: stdoutPath, stderr_path: stderrPath,
      diff_lines: diffLines, diff_max_lines: diffMaxLines, changed_files: changedFiles, exit_status: exitStatus, timed_out: timedOut,
      runtime_adapter: makerLease.runtime, runtime_contract: runtimeContract, runtime_pid: result.runtimePid,
      runtime_signal: result.signal, runtime_timed_out: result.timedOut, runtime_timed_out_at: result.timedOutAt,
      runtime_warnings: runtimeWarnings, token_efficiency: efficiency,
      runtime_usage: runtimeUsage || { usage_source: 'unknown' }, token_accounting: tokenAccounting,
      // MAKER_DIFF_CAPTURE=on: the redacted, capped diff diff_lines was counted from (record-only; an error leaves only diff_capture_error)
      ...captureMakerDiff(diff),
      ...(fallbackLimited ? { failure_reason: LIMIT_HIT, subscription_limit_hit_at: new Date().toISOString() } : failed ? { failure_reason: `maker_gate_failed:${gates.filter((gate) => gate.status === 'fail').map((gate) => gate.name).join(',')}${remoteCancel ? `;remote_maker_cancelled:${remoteCancel}` : ''}` } : {}),
      // structured failure capture (record-only; the gates above already decided)
      ...(failed || wasCancelled ? { failure: runtimeFailureHint(result, 'maker', tokenBudget.gate.status === 'fail') } : {}),
      // ASG-001: execution, verification and incident kept apart (the decision recorded before the runtime stays as written)
      ...(asg && asgOutcome ? { asg: { ...(this.loopService.getWorkerLease(makerLease.id).metadata.asg as Record<string, unknown> ?? {}), outcome: asgOutcome,
        ...(asgOutcome.rescued ? { incident_failure: runtimeFailureHint(result, 'maker', tokenBudget.gate.status === 'fail') } : {}) } } : {}),
    };

    if (wasCancelled) {
      this.loopService.patchWorkerLeaseMetadata(makerLease.id, { ...metadataPatch, runtime_was_cancelled: true });
    } else {
      this.loopService.updateWorkerLeaseStatus(makerLease.id, completionStatus, metadataPatch);
      if (completionStatus === 'completed' && changedFilesRisk) this.loopService.ensureChangedFilesSecurityChecker(run, makerLease, changedFilesRisk);
    }

    const budgetRisk = tokenBudget.efficiencyExceeded
      ? { type: 'token_efficiency' as const, lease_id: makerLease.id, runtime_usage: runtimeUsage ? { total_tokens: runtimeUsage.total_tokens } : { usage_source: 'unknown' }, budget: tokenBudget.budget }
      : null;

    this.updateRunAndRecord(run, makerLease, failed, wasCancelled, gates, budgetRisk, stdoutPath, stderrPath, runtimeUsage, runtimeWarnings, efficiency, tokenBudget, result, runtimeContract);

    const completedLease = this.loopService.getWorkerLease(makerLease.id);
    if (wasCancelled) return { run: this.loopService.getLoopRun(run.id), lease: completedLease, gates, stdout_path: stdoutPath, stderr_path: stderrPath };
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

  /**
   * OPS-004: one lifecycle span per reviewer lease (checker / security checker), as for makers — opened at dispatch in
   * `loop-<run>-checker-<lease>`, reused by a resumed call, closed when the lease settles (here, or by the settle trigger).
   * An unexpected error after dispatch fails the still-running lease (as executeMaker does), so the span closes; an
   * approval / in-progress continuation has put the lease back to 'prepared' and is left alone.
   */
  async executeChecker(id: string, input: ExecuteCheckerInput = {}): Promise<ExecuteWorkerResult> {
    const span: ReviewerDispatch = {};
    let execution: ExecuteWorkerResult | undefined;
    let errorMessage: string | undefined;
    try {
      execution = await this.runChecker(id, input, span);
    } catch (err) {
      errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      const stuck = span.leaseId ? this.db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(span.leaseId) as { status: string } | undefined : undefined;
      if (stuck?.status === 'running') this.loopService.updateWorkerLeaseStatus(span.leaseId!, 'failed', { failure_reason: `checker_execution_error: ${errorMessage}`,
        failed_at: new Date().toISOString(), failure: { stage: 'checker', stderr_class: classifyStderr(errorMessage), stderr_source: 'reason' } });
      throw err;
    } finally {
      if (span.current) this.closeLeaseSpan(span.current, execution, errorMessage);
    }
    // the trace as closed, with the detail the close added
    return execution.trace ? { ...execution, trace: this.loopService.assurance.getTrace(execution.trace.trace_id) } : execution;
  }

  private async runChecker(id: string, input: ExecuteCheckerInput, span: ReviewerDispatch): Promise<ExecuteWorkerResult> {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertOperatorNotPaused(run);
    const leases = this.loopService.listWorkerLeases(run.id);
    const checker = input.lease_id
      ? leases.find((candidate) => candidate.id === input.lease_id)
      : leases.find((candidate) => candidate.role === 'checker' && candidate.status === 'prepared');

    if (!checker) throw new Error('CHECKER_LEASE_NOT_FOUND');
    if (checker.role !== 'checker' && checker.role !== 'security_checker') throw new Error('LEASE_NOT_CHECKER');
    if (checker.status !== 'prepared') throw createError(409, 'Checker lease must be prepared before dispatch', 'CHECKER_LEASE_NOT_PREPARED');
    const reviewRole = checker.role;

    const makerLeaseId = checker.metadata.maker_lease_id as string | undefined;
    if (!makerLeaseId) throw new Error('CHECKER_MAKER_LINK_MISSING');
    const maker = leases.find((lease) => lease.id === makerLeaseId);
    if (!maker || maker.role !== 'maker' || maker.status !== 'completed') throw new Error('CHECKER_MAKER_NOT_COMPLETED');
    if (!maker.worktree_path || !fs.existsSync(maker.worktree_path)) throw new Error('MAKER_WORKTREE_NOT_FOUND');

    const requested = input.runtime || (checker.runtime !== 'manual' ? checker.runtime : undefined);
    // OLLAMA_OUTAGE_FALLBACK_RUNTIME: an opencode reviewer runs on claude (subscription); a continuation already carries it
    const runtime = requested && requested !== 'manual' ? applyOutageFallback(this.db, run, checker, requested) : requested;
    if (!runtime || runtime === 'manual') throw createError(400, 'An explicit runtime is required to dispatch a manual reviewer; use verdict submission for manual review', 'CHECKER_RUNTIME_REQUIRED');
    if (checker.metadata.execution_task_id && runtime !== checker.runtime) {
      throw createError(409, 'Reviewer continuation must use the originally dispatched runtime', 'CHECKER_RUNTIME_MISMATCH');
    }
    this.refuseFallbackSpawn(run, checker);
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
      this.loopService.updateWorkerLeaseStatus(checker.id, 'failed', { runtime_contract: runtimeContract, runtime_contract_failed_at: new Date().toISOString(), failure_reason: 'runtime_contract_unavailable_or_drifted', failure: { stage: 'checker' } });
      throw new Error('RUNTIME_CONTRACT_DRIFTED');
    }

    const checkerFindingId = `${maker.finding_id || maker.id}-${reviewRole}-${checker.id.slice(0, 8)}`;
    const checkerBranch = this.loopService.branchNameFor(run.id, checkerFindingId);
    const checkerWorktree = checker.worktree_path || this.loopService.createWorktree(
      maker.worktree_path,
      run.id,
      checkerFindingId,
      checkerBranch,
      false,
    );
    const checkerRealPath = fs.realpathSync(checkerWorktree);
    if (leases.some((lease) => lease.id !== checker.id && lease.worktree_path
      && fs.existsSync(lease.worktree_path) && fs.realpathSync(lease.worktree_path) === checkerRealPath)) {
      throw createError(409, 'Reviewer worktree must be independent of all other worker leases', 'CHECKER_WORKTREE_NOT_INDEPENDENT');
    }
    this.loopService.updateWorkerLeaseWorktree(checker.id, checkerWorktree, checkerBranch);

    const traceId = `loop-${run.id}-checker-${checker.id}`;
    const checkpointBefore = this.loopService.assurance.createCheckpoint({ loop_run_id: run.id, label: `before checker ${checker.id}`, metadata: { worker_lease_id: checker.id, maker_lease_id: maker.id, worker_role: checker.role, worker_runtime: runtime, phase: 'before_checker_execution' } });
    this.loopService.patchWorkerLeaseMetadata(checker.id, { checkpoint_before_id: checkpointBefore.id, trace_id: traceId, runtime_adapter: runtime });
    span.current = this.openLeaseSpan(run, checker, traceId, `loop:${run.id}/checker:${checker.id}`, runtime,
      { maker_lease_id: maker.id, checkpoint_before_id: checkpointBefore.id });
    span.leaseId = checker.id; // dispatched by this call: an unexpected error from here on fails it
    this.loopService.updateWorkerLeaseStatus(checker.id, 'running', { started_at: new Date().toISOString(), runtime_adapter: runtime });

    const timeoutMs = Math.max(1_000, Math.min(input.timeout_ms || 120_000, 600_000));
    const reviewerStartedAt = Date.now();
    const prompt = this.loopService.buildCheckerPrompt(run, maker, checker);
    const skipPermissions = this.loopService.resolveSkipPermissions(input.skip_permissions);
    const result = runtime === 'mock'
      ? await this.executeMockChecker(checker, checkerWorktree, prompt, timeoutMs)
      : await this.executeViaEngine(run, checker, runtime, prompt, checkerWorktree, timeoutMs, skipPermissions,
        this.riskAssessmentText(maker, prompt));

    const { stdoutPath, stderrPath } = this.writeOutput(run.id, checker.id, 'checker-output', result.stdout || '', result.stderr || '');
    const runtimeUsage = this.loopService.extractRuntimeUsage(result.stdout || '');
    // O2a: the reviewer's model call in the ledger (a mirror of this lease's runtime_usage; unknown tokens stay NULL)
    const ledgerReviewer = (ok: boolean, status?: string) => recordWorkerCall(this.db, { consumer: 'checker', role: reviewRole, runId: run.id, goalId: run.goal_id,
      loopName: run.loop_name, runtime, meta: { model: checker.metadata?.model, runtime_usage: runtimeUsage ? { input_tokens: runtimeUsage.prompt_tokens,
        output_tokens: runtimeUsage.completion_tokens, total_tokens: runtimeUsage.total_tokens } : undefined }, durationMs: Date.now() - reviewerStartedAt, ok, status });
    if (this.loopService.isWorkerLeaseCancelled(checker.id)) {
      // cancelled while it ran: the tokens it spent are still on the lease and in the ledger (once)
      this.loopService.patchWorkerLeaseMetadata(checker.id, { stdout_path: stdoutPath, stderr_path: stderrPath, runtime_was_cancelled: true, failure: runtimeFailureHint(result, 'checker'),
        runtime_usage: runtimeUsage || { usage_source: 'unknown' } });
      ledgerReviewer(false, 'cancelled');
      return { run: this.loopService.getLoopRun(run.id), lease: this.loopService.getWorkerLease(checker.id), gates: [], stdout_path: stdoutPath, stderr_path: stderrPath };
    }
    const exitStatus = result.exitCode;
    const timedOut = result.timedOut;
    const runtimeWarnings = this.loopService.extractRuntimeWarnings(result.stdout || '', result.stderr || '');
    const fallbackLimited = this.fallbackLimitHit(checker, exitStatus, result);
    this.noteOpencodeLimit(runtime, reviewRole, exitStatus, result);
    const verdict = exitStatus === 0 && !timedOut ? this.loopService.extractCheckerVerdict(result.stdout || '') : 'insufficient_evidence';
    if (shouldRecordSecondOpinion(runtime, reviewRole, judgmentMode(checkerSecondOpinion.id))) void this.recordSecondOpinion(run, maker, checker, verdict);
    const checkerChanged = this.loopService.git(checkerWorktree, ['diff', '--name-only', '--', '.']).split('\n').filter(Boolean);
    if (checkerChanged.includes('package-lock.json') && !checkerChanged.includes('package.json')) {
      this.loopService.git(checkerWorktree, ['checkout', '--', 'package-lock.json']);
      this.loopService.recordLoopEvent(run.id, 'checker_lockfile_restored', 'warning', `${reviewRole} rewrote package-lock.json (install noise); restored before the read-only check.`, { checker_lease_id: checker.id });
    }
    const checkerStatus = this.loopService.git(checkerWorktree, ['status', '--porcelain=v1', '--untracked-files=all']);
    const checkerDiffStat = this.loopService.git(checkerWorktree, ['diff', '--stat', 'HEAD', '--', '.']);
    const checkerReadOnly = checkerStatus.length === 0;
    // §16 step 8 (shadow, POLICY_VIOLATION_LOG): the read-only gate below already fails this reviewer; this only counts it
    if (!checkerReadOnly) recordPolicyViolation(this.db, { kind: 'reviewer_read_only', actor: `${reviewRole}:${runtime}`, severity: 'high', dedupe_key: checker.id,
      run_id: run.id, lease_id: checker.id, evidence_ref: `loop_run:${run.id}/lease:${checker.id}/gate:${reviewRole}_read_only_contract`,
      description: `${reviewRole} changed its worktree: ${checkerStatus.split('\n').filter(Boolean).slice(0, 10).join('; ').slice(0, 400)}` });

    this.loopService.updateWorkerLeaseStatus(checker.id, exitStatus === 0 && !timedOut ? 'completed' : 'failed', {
      verdict, notes: this.loopService.extractCheckerNotes(result.stdout || '') || `Checker runtime ${exitStatus === 0 && !timedOut ? 'completed' : 'failed'}.`,
      maker_lease_id: maker.id, completed_at: new Date().toISOString(), stdout_path: stdoutPath, stderr_path: stderrPath,
      exit_status: exitStatus, timed_out: timedOut, runtime_pid: result.runtimePid, runtime_signal: result.signal,
      runtime_timed_out: result.timedOut, runtime_timed_out_at: result.timedOutAt, runtime_adapter: runtime,
      runtime_contract: runtimeContract, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings,
      read_only_contract_passed: checkerReadOnly, runtime_verdict: verdict,
      // separates "no verdict parsed" from an explicit insufficient_evidence (both are stored as that verdict); reviewerSubReason
      verdict_parsed: exitStatus === 0 && !timedOut && this.loopService.checkerVerdictParsed(result.stdout || ''),
      // without it the lease repo fell back to the reviewer's notes, so 'failed' leases carried prose (or a raw event line) as their reason
      ...(fallbackLimited ? { failure_reason: LIMIT_HIT, subscription_limit_hit_at: new Date().toISOString() } : exitStatus === 0 && !timedOut ? {} : { failure_reason: `${reviewRole}_runtime_failed:exit=${exitStatus ?? 'signal'},timed_out=${timedOut}: ${(result.stderr || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('at ')).pop()?.slice(0, 200) ?? ''}` }),
      ...(exitStatus === 0 && !timedOut ? {} : { failure: runtimeFailureHint(result, 'checker') }),
    });

    ledgerReviewer(exitStatus === 0 && !timedOut);

    const gates: LoopGate[] = [
      { name: `${reviewRole}_runtime_exit_zero`, status: exitStatus === 0 && !timedOut ? 'pass' : 'fail', evidence: `runtime=${runtime}, exit=${exitStatus ?? 'signal'}, timed_out=${timedOut}` },
      { name: `${reviewRole}_verdict`, status: verdict === 'accepted' ? 'pass' : 'fail', evidence: `${reviewRole} verdict=${verdict}` },
      { name: `${reviewRole}_read_only_contract`, status: checkerReadOnly ? 'pass' : 'fail', evidence: checkerReadOnly ? 'Checker worktree remained clean.' : (checkerDiffStat || checkerStatus).slice(0, 1_000) },
    ];

    const failed = gates.some((gate) => gate.status === 'fail');
    const existingRun = this.loopService.getLoopRun(run.id);
    const mergedGates = this.loopService.mergeGates(existingRun.gates, gates);

    this.db.prepare('UPDATE loop_runs SET status = ?, gates_json = ?, next_actions_json = ?, updated_at = ? WHERE id = ?').run(
      failed ? 'blocked' : 'verifying', JSON.stringify(mergedGates),
      JSON.stringify(failed ? ['Inspect checker output and retry, split, or revise'] : ['Run verify gates before completion']),
      new Date().toISOString(), run.id,
    );

    this.loopService.recordLoopEvent(run.id, `${reviewRole}_executed`, failed ? 'warning' : 'info', `${reviewRole} lease ${checker.id} ${failed ? 'failed gates' : 'completed'}.`, { worker_role: reviewRole, checker_lease_id: checker.id, maker_lease_id: maker.id, verdict, gates, stdout_path: stdoutPath, stderr_path: stderrPath, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings });
    this.loopService.recordWorkerManifest({
      decisionId: this.loopService.makeManifestDecisionId(run.id, checker.id, failed ? 'fail' : 'complete'),
      loopRunId: run.id, leaseId: checker.id, action: failed ? 'fail' : 'complete', runtimeContract,
      capacitySnapshot: this.loopService.currentCapacitySnapshot(), budgetSnapshot: this.loopService.currentBudgetSnapshot(run),
      gateRefs: gates.map((g) => g.name), blockedReasons: gates.filter((g) => g.status === 'fail').map((g) => `${g.name}: ${g.evidence}`),
      metadata: { worker_role: checker.role, worker_runtime: runtime, maker_lease_id: maker.id, verdict, runtime_pid: result.runtimePid, runtime_signal: result.signal, runtime_timed_out: result.timedOut, runtime_timed_out_at: result.timedOutAt, exit_status: exitStatus, timed_out: timedOut, runtime_usage: runtimeUsage || { usage_source: 'unknown' }, runtime_warnings: runtimeWarnings, started_from: 'executeChecker' },
    });

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

  /**
   * OLLAMA_OUTAGE_FALLBACK_RUNTIME: a fallback lease without the OAuth token, or while the subscription is benched after a
   * usage limit, is never spawned — failed as infra (never a regression) and the dispatch throws.
   */
  private refuseFallbackSpawn(run: LoopRunRecord, lease: WorkerLeaseRecord): void {
    if (!isFallbackLease(lease)) return;
    const refusal = fallbackRefusal(this.db);
    if (!refusal) return;
    this.loopService.updateWorkerLeaseStatus(lease.id, 'failed', { failure_reason: refusal, failed_at: new Date().toISOString(), runtime_fallback_refused: true,
      failure: { stage: lease.role === 'maker' ? 'prepare' : 'checker' } });
    this.loopService.recordLoopEvent(run.id, 'runtime_fallback_refused', 'warning', `${lease.role} lease ${lease.id} not spawned on the outage fallback: ${refusal}.`, { lease_id: lease.id, role: lease.role, reason: refusal });
    throw new Error(refusal === LIMIT_HIT ? 'SUBSCRIPTION_LIMIT_BACKOFF' : 'SUBSCRIPTION_AUTH_MISSING');
  }

  /** OLLAMA_AUTO_FAILOVER: a failed opencode run whose output carries the Ollama Cloud usage-limit error records the limited state. */
  private noteOpencodeLimit(runtime: string | undefined, role: string, exitStatus: number | null | undefined, result: { stdout?: string; stderr?: string }): void {
    if (runtime !== 'opencode' || exitStatus === 0) return;
    noteOllamaOutput(this.db, `${result.stderr || ''}\n${(result.stdout || '').slice(-4_000)}`, `opencode:${role}`);
  }

  /** A failed fallback run whose CLI output says the subscription's usage window is exhausted (#881 detection). */
  private fallbackLimitHit(lease: WorkerLeaseRecord, exitStatus: number | null | undefined, result: { stdout?: string; stderr?: string }): boolean {
    return isFallbackLease(lease) && isSubscriptionLimit(exitStatus ?? null, result.stdout || '', result.stderr || '');
  }

  private async executeMockWorker(
    lease: WorkerLeaseRecord,
    prompt: string,
    timeoutMs: number,
    skipPermissions: boolean,
  ): Promise<RuntimeExecutionResult> {
    const { command, args } = this.loopService.buildRuntimeCommand('mock', lease.worktree_path!, prompt, skipPermissions);
    return this.loopService.runtimeCommand.executeRuntimeCommand(lease.id, command, args, {
      cwd: lease.worktree_path!, timeoutMs, maxBuffer: 5 * 1024 * 1024,
      env: this.loopService.buildNestedSpawnEnv(lease) ?? undefined,
    });
  }

  private async executeMockChecker(
    lease: WorkerLeaseRecord,
    cwd: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<RuntimeExecutionResult> {
    const { command, args } = this.loopService.buildMockCheckerCommand(cwd, prompt);
    return this.loopService.runtimeCommand.executeRuntimeCommand(lease.id, command, args, {
      cwd, timeoutMs, maxBuffer: 5 * 1024 * 1024,
      env: this.loopService.buildNestedSpawnEnv(lease) ?? undefined,
    });
  }


  decideApproval(approvalId: string, approved: boolean, decidedBy: string, reason?: string): Promise<unknown> {
    return (this.executionEngine ||= new ExecutionEngine(this.db)).handleApprovalDecision(approvalId, approved, decidedBy, reason);
  }

  private async executeViaEngine(
    run: LoopRunRecord,
    lease: WorkerLeaseRecord,
    runtime: string,
    prompt: string,
    cwd: string,
    timeoutMs: number,
    skipPermissions: boolean,
    riskAssessmentText: string,
  ): Promise<RuntimeExecutionResult> {
    const previousTaskId = lease.metadata.execution_task_id as string | undefined;
    if (previousTaskId) {
      const previousTask = this.db.prepare('SELECT status, metadata FROM tasks WHERE id = ?').get(previousTaskId) as { status: string; metadata: string } | undefined;
      const previousMetadata = previousTask ? JSON.parse(previousTask.metadata || '{}') : {};
      if (previousMetadata.execution_recovery_hold === true) throw new Error('LOOP_WORKER_EXECUTION_RECOVERY_REQUIRED');
      const previousResult = previousMetadata.executionResult as ExecutionResult | undefined;
      if (previousResult && ['completed', 'failed', 'cancelled'].includes(previousTask!.status)) {
        return this.toRuntimeResult(previousResult);
      }
      if (previousTask?.status === 'awaiting_approval') {
        this.loopService.updateWorkerLeaseStatus(lease.id, 'prepared', {});
        throw new Error('LOOP_WORKER_APPROVAL_REQUIRED');
      }
      if (previousTask?.status === 'running' || previousTask?.status === 'queued') {
        this.loopService.updateWorkerLeaseStatus(lease.id, 'prepared', {});
        throw new Error('LOOP_WORKER_EXECUTION_IN_PROGRESS');
      }
    }

    const taskId = `loop-worker-${lease.id}-${randomUUID().slice(0, 8)}`;
    const agentId = this.resolveAgentId(runtime, lease.role);
    const now = new Date().toISOString();
    const environment = Object.fromEntries(Object.entries(this.loopService.buildNestedSpawnEnv(lease) || {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    // SUBSCRIPTION_GYM_SPECIES: a gym maker on a flat subscription — the executor drops every billing key and adds the login at
    // spawn time (only the marker is stored here, never the token); opencode = an opencode-free:<model> species (keys dropped, no login)
    // OLLAMA_OUTAGE_FALLBACK_RUNTIME: every role of a fallback lease (maker, checker, security checker) runs the same way
    if ((lease.role === 'maker' || isFallbackLease(lease)) && lease.metadata.subscription_auth === runtime && (runtime === 'claude' || runtime === 'codex' || runtime === 'opencode')) environment[SUBSCRIPTION_ENV_MARKER] = runtime;
    const factoryGoal = run.goal_id ? this.db.prepare("SELECT owner_user_id FROM goals WHERE id = ? AND json_type(metadata, '$.skill_factory_key') = 'text'").get(run.goal_id) as { owner_user_id: string | null } | undefined : undefined;
    const selected = skillAssignment(this.db, prompt, lease.role === 'maker' && lease.metadata.skill_execution ? { skill_execution: lease.metadata.skill_execution } : {});
    prompt = selected.description;
    riskAssessmentText += selected.metadata.skill_package_receipts ? `\n${prompt}` : '';
    this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, agent_id, tags, metadata, created_at, updated_at, owner_user_id)
      VALUES (?, ?, ?, 'pending', ?, ?, 'local', ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      `${lease.role} worker for ${run.loop_name}`,
      prompt,
      this.loopService.isHighRiskRun(run) ? 'high' : 'medium',
      this.loopService.isHighRiskRun(run) ? 'high' : 'low',
      agentId,
      JSON.stringify(['loop-worker', lease.role, runtime]),
      JSON.stringify({ ...selected.metadata, loop_run_id: run.id, lease_id: lease.id, workingDirectory: cwd, timeoutMs, skipPermissions, environment,
        ...(typeof lease.metadata.model === 'string' ? { model: lease.metadata.model } : {}),
        ...(runtime === 'codex' && typeof lease.metadata.reasoningEffort === 'string' ? { reasoningEffort: lease.metadata.reasoningEffort } : {}),
        ...(runtime === 'codex' ? { codexSandbox: lease.role === 'maker' ? 'workspace-write' : 'read-only' } : {}),
      }),
      now,
      now,
      factoryGoal?.owner_user_id ?? null,
    );
    this.loopService.patchWorkerLeaseMetadata(lease.id, { execution_task_id: taskId,
      ...leaseIdentity(runtime, typeof lease.metadata.model === 'string' ? lease.metadata.model : undefined, prompt) });

    const execution = await (this.executionEngine ||= new ExecutionEngine(this.db)).executeTask(
      taskId, runtime as ExecutorKind, undefined, { riskAssessmentText },
    );
    if (execution.status === 'awaiting_approval') {
      this.loopService.updateWorkerLeaseStatus(lease.id, 'prepared', { execution_task_id: taskId, approval_id: execution.approvalId });
      throw new Error('LOOP_WORKER_APPROVAL_REQUIRED');
    }
    if (execution.status === 'denied' || !execution.completion) {
      // a denial without a stated reason fell through to 'unspecified: caller supplied no reason' (the repo reads execution_denied_reason)
      const denied = execution.reason || (execution.status === 'denied' ? 'execution_denied_without_reason' : `execution_${execution.status}_without_completion`);
      this.loopService.updateWorkerLeaseStatus(lease.id, 'failed', { execution_task_id: taskId, execution_denied_reason: denied,
        failure: { stage: lease.role === 'maker' ? 'prepare' : 'checker', stderr_class: classifyStderr(denied), stderr_source: 'reason' } });
      throw new Error('LOOP_WORKER_EXECUTION_DENIED');
    }

    const completed = await execution.completion;
    return this.toRuntimeResult(completed);
  }

  /**
   * `tasks.agent_id` was never populated for loop-worker tasks, so every
   * such task showed as "Unassigned" on the dashboard even while a real
   * runtime+role was actively executing it. There's no pre-existing `agents`
   * row for a runtime like "codex" or "hermes" (the seeded agents are demo
   * fixtures), so get-or-create a stable identity per runtime+role pair —
   * e.g. "codex-maker" — the first time it's needed.
   */
  private resolveAgentId(runtime: string, role: string): string {
    const name = `${runtime}-${role}`;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, description, status, capabilities, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(id, name, `Auto-registered ${role} worker identity for the ${runtime} runtime.`, JSON.stringify([runtime, role]), now, now);
    return (this.db.prepare('SELECT id FROM agents WHERE name = ?').get(name) as { id: string }).id;
  }

  private riskAssessmentText(lease: WorkerLeaseRecord, prompt: string): string {
    const packetPath = typeof lease.metadata.assignment_packet_file === 'string' ? lease.metadata.assignment_packet_file : '';
    if (packetPath && fs.existsSync(packetPath)) {
      const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8')) as { finding?: Record<string, unknown> };
      const finding = packet.finding;
      if (!finding || !['message', 'evidence', 'suggested_fix'].some((key) => typeof finding[key] === 'string')) {
        throw new Error('LOOP_WORKER_FINDING_NOT_FOUND');
      }
      return ['type', 'severity', 'file', 'message', 'evidence', 'suggested_fix']
        .map((key) => finding[key])
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
    }

    // Legacy assignment files include policy boilerplate that must not be
    // mistaken for the requested work; fail closed if the finding section is absent.
    const findingText = prompt.split('\n## Advisory Past Experience\n')[0]?.split('\n## Rules\n')[0]?.trim() || '';
    if (!findingText) throw new Error('LOOP_WORKER_FINDING_NOT_FOUND');
    return findingText;
  }

  private toRuntimeResult(completed: ExecutionResult): RuntimeExecutionResult {
    const message = `${completed.message}\n${completed.error || ''}`;
    const timedOut = /timed out/i.test(message);
    // exitCode stays the status-derived 0/1 the gates have always read; the child's own exit and signal are recorded beside it
    const exitObserved = completed.exitCode !== undefined || completed.signal !== undefined;
    return {
      exitCode: completed.status === 'completed' ? 0 : 1,
      signal: completed.signal ?? null,
      processExitCode: exitObserved ? completed.exitCode ?? null : null,
      exitObserved,
      tokenBudgetHit: /token budget exceeded/i.test(message),
      runtimeMessage: completed.status === 'completed' ? '' : `${completed.message || ''}${completed.error ? `\n${completed.error.split('\n')[0]}` : ''}`.slice(0, 1_000),
      timedOut,
      ...(timedOut ? { timedOutAt: new Date().toISOString() } : {}),
      stdout: completed.stdout || '',
      stderr: completed.stderr || completed.error || '',
    };
  }

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

  /** TypeSafe second opinion in shadow mode (fail-open, never awaited by the gate logic). */
  private async recordSecondOpinion(run: LoopRunRecord, maker: WorkerLeaseRecord, checker: WorkerLeaseRecord, checkerVerdict: string): Promise<void> {
    try {
      const packetFile = typeof maker.metadata.assignment_packet_file === 'string' ? maker.metadata.assignment_packet_file : '';
      let task = packetFile && fs.existsSync(packetFile) ? fs.readFileSync(packetFile, 'utf8') : '';
      try { const f = JSON.parse(task)?.finding; if (f?.message) task = [f.message, f.suggested_fix].filter(Boolean).join('\n'); } catch { /* raw packet text */ }
      const diff = maker.worktree_path ? this.loopService.workingTreeDiff(maker.worktree_path) : '';
      const state = checkerSecondOpinionState(task, diff, withoutHiddenChecks(maker.metadata.deterministic_checks || []));
      await runJudgment(this.db, checkerSecondOpinion, { type: 'worker_lease', id: checker.id }, state, undefined, { checkerVerdict, loopRunId: run.id });
    } catch { /* shadow judgment must never affect the loop */ }
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
