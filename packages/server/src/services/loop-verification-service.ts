/**
 * LoopVerificationService — handles loop verification, certification, and completion gates.
 *
 * Extracted from LoopService (~150 LOC) to isolate the verification logic
 * from the core loop lifecycle. This service evaluates whether a loop run
 * is ready for completion by checking all gates: maker/checker separation,
 * worktree isolation, diff thresholds, checker verdicts, and security reviews.
 */

import fs from 'fs';
import { swarmEventBus } from './swarm-event-bus';
import { recordPolicyViolation } from './policy-violations';
import type {
  LoopService,
} from './loop-service';
import { allGatesPassed } from './loop-types';
import type {
  LoopRunRecord,
  WorkerLeaseRecord,
  LoopGate,
  GateStatus,
} from './loop-types';

/** E2: combine per-lease observations — any durable failure fails; otherwise any missing evidence is unknown. */
const combine = (statuses: GateStatus[]): GateStatus =>
  statuses.includes('fail') ? 'fail' : statuses.includes('unknown') ? 'unknown' : 'pass';

/** Change-loop artifact gates (worktree, assignment, diff, checks, security review, auto-approval scope). */
const CHANGE_LOOP_ARTIFACT_GATES = new Set(['worktree_isolation', 'assignment_file_present', 'diff_threshold_all_makers',
  'tests_lint_typecheck', 'security_checker_verdict', 'auto_approved_scope']);
/** A gym run is graded by its own oracle (gym_result): none of the change-loop maker/checker gates apply. */
const GYM_INAPPLICABLE_GATES = new Set([...CHANGE_LOOP_ARTIFACT_GATES, 'maker_completion', 'maker_checker_separation', 'checker_verdict']);

export interface VerificationResult {
  run: LoopRunRecord;
  gates: LoopGate[];
  leases: WorkerLeaseRecord[];
}

export interface CertificationResult extends VerificationResult {
  certified: boolean;
}

export class LoopVerificationService {
  constructor(private loopService: LoopService) {}

  /**
   * Verify a loop run — evaluate all completion gates.
   */
  verifyLoopRun(id: string): VerificationResult {
    const run = this.loopService.getLoopRun(id);
    this.loopService.assertOperatorNotPaused(run);
    const leases = this.loopService.listWorkerLeases(run.id);
    const makerLeases = leases.filter((lease) => lease.role === 'maker');
    const supersededMakerIds = new Set(
      makerLeases.filter((lease) => this.loopService.isSupersededMakerLease(lease)).map((lease) => lease.id)
    );
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
    const highRisk = this.loopService.isHighRiskRun(run);
    const notApplicable = this.inapplicableGates(run, activeMakerLeases);

    const computedGates: LoopGate[] = [
      {
        name: 'run_not_cancelled',
        status: run.status === 'cancelled' ? 'fail' : 'pass',
        evidence: 'Verification cannot resume or certify an operator-cancelled run.',
      },
      {
        name: 'maker_completion',
        status: activeMakerLeases.length > 0 && completedMakerLeases.length === activeMakerLeases.length ? 'pass' : 'fail',
        evidence: `${completedMakerLeases.length}/${activeMakerLeases.length} active maker lease(s) completed; every non-superseded maker must complete.`,
      },
      {
        name: 'maker_checker_separation',
        status: activeMakerLeases.length > 0 && checkerLeases.length >= activeMakerLeases.length ? 'pass' : 'fail',
        evidence: `${activeMakerLeases.length} active maker lease(s), ${checkerLeases.length} active checker lease(s), ${supersededMakerIds.size} superseded maker lease(s).`,
      },
      {
        name: 'worktree_isolation',
        status: combine(activeMakerLeases.map((lease) => this.worktreeObservation(lease))),
        evidence: 'Every maker lease must have an existing isolated worktree (a completed maker whose recorded worktree is gone is insufficient evidence, not a failure).',
      },
      {
        name: 'assignment_file_present',
        status: combine(activeMakerLeases.map((lease) => this.assignmentObservation(lease))),
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
        status: completedMakerLeases.length === 0 ? 'skipped' : combine(completedMakerLeases.map((lease) => this.reviewObservation(lease.id, checkerLeases))),
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
            : combine(completedMakerLeases.map((lease) => this.reviewObservation(lease.id, securityCheckerLeases))),
        evidence: !highRisk
          ? 'Run is not high-risk.'
          : `${securityCheckerLeases.length} active security checker lease(s); high-risk completion requires accepted security verdict for every completed maker.`,
      },
      {
        // J5: an auto-approved maker may only have written the one test file its approval covered.
        name: 'auto_approved_scope',
        status: completedMakerLeases.every((lease) => !lease.metadata?.auto_approved_scope || this.leaseWithinScope(lease)) ? 'pass' : 'fail',
        evidence: 'An auto-approved maker lease may change only its approved test file (human-approved makers pass).',
      },
      {
        name: 'no_automatic_merge',
        status: 'pass',
        evidence: 'Loop only prepared worktrees and did not merge, push, or deploy.',
      },
    ];
    const gates: LoopGate[] = computedGates.map((gate) => notApplicable.gates.has(gate.name)
      ? { name: gate.name, status: 'skipped', evidence: `Not applicable: ${notApplicable.reason}.` }
      : gate);

    const waitingForMakers = activeMakerLeases.some((lease) => lease.status === 'prepared' || lease.status === 'running')
      && activeMakerLeases.every((lease) => lease.status !== 'failed' && lease.status !== 'cancelled');
    const blockingGate = gates.some((gate) => gate.status === 'fail'
      && !(gate.name === 'maker_completion' && waitingForMakers));
    const unknownGates = gates.filter((gate) => gate.status === 'unknown');
    const status = run.status === 'cancelled' || run.status === 'completed'
      ? run.status
      : blockingGate || unknownGates.length > 0
      ? 'blocked'
      // a run that is not a change loop (gym, PR review) has no merge readiness to assert: its owner settles it
      : notApplicable.gates.size > 0
        ? run.status
      : activeMakerLeases.length > 0 && completedMakerLeases.length === activeMakerLeases.length
        ? 'ready_for_human_merge'
        : 'verifying';

    // Record structured block reasons in metadata
    const failedGates = gates.filter((gate) => gate.status === 'fail');
    const blockMetadata: Record<string, unknown> = { ...run.metadata };

    delete blockMetadata.unknown_gates;
    if (status === 'blocked' && failedGates.length > 0) {
      blockMetadata.block_reason = 'gate_failed';
      blockMetadata.failed_gates = failedGates.map((g) => `${g.name}: ${g.evidence}`);
      blockMetadata.recommendations = ['Review failed gates and address issues before re-verifying'];
      blockMetadata.blocked_at = new Date().toISOString();
    } else if (status === 'blocked' && unknownGates.length > 0) {
      // E2: missing evidence is reported as insufficient evidence, never as a failed invariant (no failed_gates entry)
      blockMetadata.block_reason = 'insufficient_evidence';
      delete blockMetadata.failed_gates;
      blockMetadata.unknown_gates = unknownGates.map((g) => `${g.name}: ${g.evidence}`);
      blockMetadata.recommendations = ['Evidence for these gates is missing or unavailable; re-run or re-collect it before re-verifying'];
      blockMetadata.blocked_at = new Date().toISOString();
    } else if (blockMetadata.block_reason === 'gate_failed' || blockMetadata.block_reason === 'insufficient_evidence') {
      delete blockMetadata.block_reason;
      delete blockMetadata.failed_gates;
      delete blockMetadata.recommendations;
      delete blockMetadata.blocked_at;
    }

    const db = (this.loopService as any).db;
    // §16 step 8 (shadow, POLICY_VIOLATION_LOG): the scope gate already failed these; record each breach once, decide nothing
    for (const lease of completedMakerLeases) {
      if (notApplicable.gates.has('auto_approved_scope') || !lease.metadata?.auto_approved_scope || this.leaseWithinScope(lease)) continue;
      const files = Array.isArray(lease.metadata.changed_files) ? lease.metadata.changed_files.map(String) : [];
      recordPolicyViolation(db, { kind: 'scope_gate', actor: `maker:${lease.runtime}`, severity: 'high', dedupe_key: lease.id, run_id: run.id, lease_id: lease.id,
        evidence_ref: `loop_run:${run.id}/lease:${lease.id}`,
        description: `auto-approved maker changed files outside ${String(lease.metadata.auto_approved_scope)}: ${files.filter((f: string) => f !== lease.metadata.auto_approved_scope).join(', ') || '(none listed)'}` });
    }
    db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, updated_at = ?, metadata = ?
      WHERE id = ?
    `).run(status, JSON.stringify(gates), new Date().toISOString(), JSON.stringify(blockMetadata), run.id);

    this.loopService.recordLoopEvent(run.id, 'loop_verified', failedGates.length + unknownGates.length > 0 ? 'warning' : 'info',
      `Verification status: ${status}; ${failedGates.length} gate(s) incomplete or failed${unknownGates.length ? `; ${unknownGates.length} gate(s) with insufficient evidence` : ''}.`,
      { gates, block_metadata: blockMetadata });

    return { run: this.loopService.getLoopRun(run.id), gates, leases };
  }

  /**
   * Certify a loop run — verify + emit convergence event.
   */
  certifyLoopRun(id: string): CertificationResult {
    const result = this.verifyLoopRun(id);
    const allPass = (result.run.status === 'ready_for_human_merge' || result.run.status === 'completed') && allGatesPassed(result.gates);
    swarmEventBus.emit('convergence', {
      run_id: id,
      certified: allPass,
      gates: result.gates.map((g) => ({ name: g.name, status: g.status })),
    });
    return { ...result, certified: allPass };
  }

  // ─── Gate Helpers ────────────────────────────────────────────────────

  private leaseWithinScope(lease: WorkerLeaseRecord): boolean {
    const files = lease.metadata?.changed_files;
    return Array.isArray(files) && files.length === 1 && files[0] === lease.metadata.auto_approved_scope;
  }

  private leaseDiffWithinThreshold(lease: WorkerLeaseRecord): boolean {
    const diffLines = Number(lease.metadata?.diff_lines ?? 0);
    const diffMaxLines = Number(lease.metadata?.diff_max_lines ?? 0);
    return diffMaxLines > 0 && diffLines <= diffMaxLines;
  }

  /**
   * E2: which gates do not apply to this run. A gym run (loop_name evolution-gym or metadata.gym) is graded by its oracle; a
   * GitHub PR review (synthetic maker lease carrying github_pr) is checker-only — the PR's commits are the patch, so the
   * change-loop artifact gates have nothing to observe. Governed change loops get the empty set (no gate weakened).
   */
  private inapplicableGates(run: LoopRunRecord, activeMakerLeases: WorkerLeaseRecord[]): { gates: Set<string>; reason: string } {
    const gym = run.metadata?.gym;
    if (run.loop_name === 'evolution-gym' || (gym !== null && typeof gym === 'object')) {
      return { gates: GYM_INAPPLICABLE_GATES, reason: 'gym run, graded by the gym oracle rather than change-loop gates' };
    }
    const prReview = activeMakerLeases.length > 0 && activeMakerLeases.every((lease) => lease.metadata?.synthetic === true
      && lease.metadata?.github_pr !== null && typeof lease.metadata?.github_pr === 'object');
    if (prReview) return { gates: CHANGE_LOOP_ARTIFACT_GATES, reason: 'pull-request review, the maker is the PR itself and has no change-loop artifacts' };
    return { gates: new Set(), reason: '' };
  }

  /** No recorded worktree is a durable failure; a completed (historical) maker whose recorded worktree is gone is unknown. */
  private worktreeObservation(lease: WorkerLeaseRecord): GateStatus {
    if (!lease.worktree_path) return 'fail';
    if (fs.existsSync(lease.worktree_path)) return 'pass';
    return lease.status === 'completed' ? 'unknown' : 'fail';
  }

  /** No assignment recorded at all is a failure; an unreadable historical assignment of a completed maker is unknown. */
  private assignmentObservation(lease: WorkerLeaseRecord): GateStatus {
    const assignmentPath = this.loopService.resolveWorkAssignmentPath(lease);
    if (assignmentPath && fs.existsSync(assignmentPath)) return 'pass';
    return assignmentPath && lease.status === 'completed' ? 'unknown' : 'fail';
  }

  private reviewObservation(makerLeaseId: string, reviewerLeases: WorkerLeaseRecord[]): GateStatus {
    const observations = reviewerLeases.filter((l) => l.metadata.maker_lease_id === makerLeaseId).map((l) => this.reviewEvidence(l));
    return observations.includes('pass') ? 'pass' : observations.includes('unknown') ? 'unknown' : 'fail';
  }

  public hasAcceptedReviewEvidence(lease: WorkerLeaseRecord): boolean {
    return this.reviewEvidence(lease) === 'pass';
  }

  /**
   * E2: 'pass' = accepted with full runtime proof; 'unknown' = every recorded observation is an accepted verdict but its
   * recorded stdout file is no longer readable (unavailable evidence); 'fail' = anything else.
   */
  public reviewEvidence(lease: WorkerLeaseRecord): GateStatus {
    if (lease.status !== 'completed' || lease.metadata.verdict !== 'accepted') return 'fail';
    // Manual review is an explicit, supported decision path, not runtime proof.
    // P1a: require attestation — a named reviewer + a recorded reason. Without it, the
    // manual bypass would silently skip all runtime evidence checks (G-audit P3.3).
    if (lease.runtime === 'manual') {
      const att = lease.metadata.manual_review_attestation as { reviewer?: unknown; reason?: unknown } | undefined;
      return typeof att?.reviewer === 'string' && att.reviewer.length > 0
        && typeof att?.reason === 'string' && att.reason.length > 0 ? 'pass' : 'fail';
    }
    const proof = lease.metadata;
    const contract = proof.runtime_contract as { available?: unknown; status?: unknown } | undefined;
    // Historical runtime verdicts lacking these observations remain blocked; an
    // accepted string cannot erase cancellation, runtime failure or a write violation.
    const proven = proof.exit_status === 0 && proof.timed_out === false && proof.runtime_verdict === 'accepted'
      && proof.runtime_was_cancelled !== true && proof.runtime_timed_out !== true
      && proof.read_only_contract_passed === true && proof.runtime_adapter === lease.runtime
      && contract?.available === true && contract.status === 'ok'
      && typeof proof.stdout_path === 'string';
    if (!proven) return 'fail';
    return fs.existsSync(proof.stdout_path as string) ? 'pass' : 'unknown';
  }

  private leaseChecksPassed(lease: WorkerLeaseRecord): boolean {
    const checks = lease.metadata?.deterministic_checks;
    if (!Array.isArray(checks) || checks.length === 0) return false;
    // B1 (17-10): zero executed checks cannot verify a run — at least one check really ran and passed (all-skipped used to pass)
    if (!checks.some((check) => (check as { status?: unknown }).status === 'pass')) return false;
    return checks.every((check) => {
      const status = (check as { status?: unknown }).status;
      return status === 'pass' || status === 'skipped';
    });
  }
}
