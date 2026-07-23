/**
 * LoopRecoveryService — handles recovery of interrupted loop runs after server restart.
 *
 * When the server restarts, in-memory process handles are lost. This service:
 * 1. Marks orphaned worker leases as 'failed'
 * 2. Marks orphaned loop runs as 'interrupted'
 * 3. Provides resume logic for interrupted runs
 *
 * Extracted from LoopService to isolate recovery logic.
 */

import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';
import { WorkerLeaseRepo } from './loop-worker-lease-repo';
import { LoopRunQueryService } from './loop-run-query-service';
import { LoopRunMutationService } from './loop-run-mutation-service';
import type { WorkerLeaseRecord } from './loop-types';

export interface RecoveryResult {
  interruptedRuns: number;
  failedLeases: number;
}

export interface ResumeResult {
  resumed: boolean;
  boundedFail: boolean;
  resumeAttempt: number;
  requeuedFindings: string[];
  skippedFindings: string[];
}

/**
 * Shared state for runtime leases across the loop subsystem.
 * Previously a static field on LoopService.
 */
export class RuntimeLeaseRegistry {
  private static leases = new Map<string, { leaseId: string; startedAt: string }>();

  static register(leaseId: string): void {
    this.leases.set(leaseId, { leaseId, startedAt: new Date().toISOString() });
  }

  static unregister(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  static isLive(leaseId: string): boolean {
    return this.leases.has(leaseId);
  }

  static getLiveIds(): Set<string> {
    return new Set(this.leases.keys());
  }

  static count(): number {
    return this.leases.size;
  }

  static clear(): void {
    this.leases.clear();
  }
}

export class LoopRecoveryService {
  private leases: WorkerLeaseRepo;
  private queries: LoopRunQueryService;
  private mutations: LoopRunMutationService;

  constructor(db: Database) {
    this.leases = new WorkerLeaseRepo(db);
    this.queries = new LoopRunQueryService(db);
    this.mutations = new LoopRunMutationService(db);
  }

  /**
   * Recover in-flight work orphaned by a server crash/restart.
   * Safe to call at any time. Idempotent.
   */
  recoverInterruptedRuns(): RecoveryResult {
    const now = new Date().toISOString();
    const liveLeaseIds = RuntimeLeaseRegistry.getLiveIds();

    // Fail 'running' leases whose child process is gone.
    const runningLeases = this.leases.getRunning();
    let failedLeases = 0;
    for (const lease of runningLeases) {
      if (liveLeaseIds.has(lease.id)) continue;
      this.leases.updateStatus(lease.id, 'failed', {
        failed_reason: 'server_restart',
        failed_at: now,
      });
      failedLeases++;
    }

    // Runs in an active status whose worker leases are all non-live are orphaned.
    const liveRunIds = this.leases.getLoopRunIdsForLeases(Array.from(liveLeaseIds));
    const activeRuns = this.queries.getActive();
    let interruptedRuns = 0;
    for (const run of activeRuns) {
      if (liveRunIds.has(run.id)) continue;
      this.mutations.updateStatus(run.id, 'interrupted', {
        interrupted_reason: 'server_restart',
        interrupted_at: now,
      });
      interruptedRuns++;
    }

    return { interruptedRuns, failedLeases };
  }

  /**
   * Resume an interrupted run. Bounded by maxResumeAttempts.
   */
  resumeInterruptedRun(runId: string, maxResumeAttempts = 3): ResumeResult {
    const run = this.queries.getById(runId);
    if (run.status !== 'interrupted') {
      throw new Error('LOOP_RUN_NOT_INTERRUPTED');
    }

    const metadata = run.metadata;
    const resumeAttempts = (metadata.resume_attempts as number ?? 0) + 1;

    if (resumeAttempts > maxResumeAttempts) {
      this.mutations.updateStatus(runId, 'failed', { resume_attempts: resumeAttempts });
      return { resumed: false, boundedFail: true, resumeAttempt: resumeAttempts, requeuedFindings: [], skippedFindings: [] };
    }

    const findings = run.findings;
    const completedFindings = new Set<string>();
    const leaseStatuses = this.leases.getFindingStatuses(runId);
    for (const ls of leaseStatuses) {
      if (ls.status === 'completed' && ls.finding_id) completedFindings.add(ls.finding_id);
    }

    const requeuedFindings: string[] = [];
    const skippedFindings: string[] = [];

    for (const finding of findings) {
      if (completedFindings.has(finding.id)) {
        skippedFindings.push(finding.id);
      } else {
        requeuedFindings.push(finding.id);
      }
    }

    this.mutations.updateStatus(runId, 'running', { resume_attempts: resumeAttempts });

    swarmEventBus.emit('recovery', {
      run_id: runId,
      resumed: true,
      requeued_findings: requeuedFindings.length,
    });

    return { resumed: true, boundedFail: false, resumeAttempt: resumeAttempts, requeuedFindings, skippedFindings };
  }

  /**
   * Resume all interrupted runs.
   */
  resumeInterruptedRuns(): { resumed: number; boundedFailed: number; details: Array<{ runId: string; resumed: boolean }> } {
    const interruptedRuns = this.queries.getInterrupted();
    const details: Array<{ runId: string; resumed: boolean }> = [];
    let resumed = 0;
    let boundedFailed = 0;

    for (const run of interruptedRuns) {
      const result = this.resumeInterruptedRun(run.id);
      details.push({ runId: run.id, resumed: result.resumed });
      if (result.resumed) resumed++;
      else boundedFailed++;
    }

    return { resumed, boundedFailed, details };
  }

  /**
   * Check if a worker lease is cancelled or stopped.
   */
  isWorkerLeaseCancelled(leaseId: string): boolean {
    return this.leases.isCancelled(leaseId);
  }

  /**
   * Get a worker lease by ID.
   */
  getWorkerLease(leaseId: string): WorkerLeaseRecord {
    return this.leases.getById(leaseId);
  }
}
