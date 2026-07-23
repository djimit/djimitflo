/**
 * LoopCheckerService
 * Extracted from loop-service.ts (Task 5.2: LoopService decompositie)
 * Constitution v1.1.0 — Architecture decomposition
 */
import type Database from 'better-sqlite3';
import type { LoopRunRecord, WorkerLeaseRecord } from '@djimitflo/shared';

export class LoopCheckerService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
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
      ? this.verifyLoopRun(run.id).run
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
      ? this.verifyLoopRun(run.id).run
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
        env: this.buildRuntimeEnv(),
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

}
