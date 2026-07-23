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
import type {
  LoopService,
} from './loop-service';
import type {
  LoopRunRecord,
  WorkerLeaseRecord,
  LoopGate,
} from './loop-types';

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
        status: activeMakerLeases.every((lease) => fs.existsSync(this.loopService.resolveWorkAssignmentPath(lease))) ? 'pass' : 'fail',
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

    const status = gates.some((gate) => gate.status === 'fail')
      ? 'blocked'
      : completedMakerLeases.length > 0
        ? 'ready_for_human_merge'
        : 'verifying';

    // Record structured block reasons in metadata
    const failedGates = gates.filter((gate) => gate.status === 'fail');
    let blockMetadata: Record<string, unknown> = {};
    try {
      const existing = JSON.parse(String(run.metadata || '{}'));
      blockMetadata = existing;
    } catch { /* use empty */ }

    if (status === 'blocked') {
      blockMetadata.block_reason = 'gate_failed';
      blockMetadata.failed_gates = failedGates.map((g) => `${g.name}: ${g.evidence}`);
      blockMetadata.recommendations = ['Review failed gates and address issues before re-verifying'];
      blockMetadata.blocked_at = new Date().toISOString();
    }

    const db = (this.loopService as any).db;
    db.prepare(`
      UPDATE loop_runs
      SET status = ?, gates_json = ?, updated_at = ?, metadata = ?
      WHERE id = ?
    `).run(status, JSON.stringify(gates), new Date().toISOString(), JSON.stringify(blockMetadata), run.id);

    this.loopService.recordLoopEvent(run.id, 'loop_verified', status === 'blocked' ? 'warning' : 'info',
      `Verification gates ${status === 'blocked' ? 'blocked' : 'passed'} for prepared work.`,
      { gates, block_metadata: blockMetadata });

    return { run: this.loopService.getLoopRun(run.id), gates, leases };
  }

  /**
   * Certify a loop run — verify + emit convergence event.
   */
  certifyLoopRun(id: string): CertificationResult {
    const result = this.verifyLoopRun(id);
    const allPass = result.gates.every((g) => g.status === 'pass');
    swarmEventBus.emit('convergence', {
      run_id: id,
      certified: allPass,
      gates: result.gates.map((g) => ({ name: g.name, status: g.status })),
    });
    return { ...result, certified: allPass };
  }

  // ─── Gate Helpers ────────────────────────────────────────────────────

  private leaseDiffWithinThreshold(lease: WorkerLeaseRecord): boolean {
    const diffLines = Number(lease.metadata?.diff_lines ?? 0);
    const diffMaxLines = Number(lease.metadata?.diff_max_lines ?? 0);
    return diffMaxLines > 0 && diffLines <= diffMaxLines;
  }

  private hasAcceptedCheckerVerdict(makerLeaseId: string, checkerLeases: WorkerLeaseRecord[]): boolean {
    return checkerLeases.some(
      (l) => l.metadata.maker_lease_id === makerLeaseId && l.metadata.verdict === 'accepted'
    );
  }

  private hasAcceptedSecurityCheckerVerdict(makerLeaseId: string, securityCheckerLeases: WorkerLeaseRecord[]): boolean {
    return securityCheckerLeases.some(
      (l) => l.metadata.maker_lease_id === makerLeaseId && l.metadata.verdict === 'accepted'
    );
  }

  private leaseChecksPassed(lease: WorkerLeaseRecord): boolean {
    const checks = lease.metadata?.deterministic_checks;
    if (!Array.isArray(checks) || checks.length === 0) return false;
    return checks.every((check) => {
      const status = (check as { status?: unknown }).status;
      return status === 'pass' || status === 'skipped';
    });
  }
}
