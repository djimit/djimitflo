import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';

export interface FixRequest {
  repositoryPath: string;
  filePath: string;
  description: string;
  category: 'bug' | 'security' | 'performance' | 'refactor';
  runtime?: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'pi' | 'mock';
}

export interface FixResult {
  success: boolean;
  loopRunId?: string;
  status?: string;
  requiresHumanApproval?: boolean;
  verdict?: string;
  testPassed: boolean;
  gates: string[];
  runtime?: string;
  error?: string;
}

export class FixLoopService {
  constructor(
    private db: Database,
    private loops: LoopService,
  ) {}

  async fixFile(request: FixRequest): Promise<FixResult> {
    let loopRunId: string | undefined;
    try {
      const run = this.loops.startDocDriftAndSmallFixLoop({
        repository_path: request.repositoryPath,
        target_finding: {
          file_path: request.filePath,
          description: request.description,
          category: request.category,
        },
      });
      loopRunId = run.id;

      const runtime = request.runtime || 'mock';
      const prepared = this.loops.continueLoopRun(run.id, { runtime, max_assignments: 1 });
      const maker = await this.loops.executeMaker(run.id, { lease_id: prepared.leases.find(lease => lease.role === 'maker')?.id });
      const checks = this.loops.runDeterministicChecks(run.id, { lease_id: maker.lease.id });
      const checkerResult = await this.loops.executeChecker(run.id, { runtime, lease_id: prepared.leases.find(lease => lease.role === 'checker')?.id });
      const securityCheckerLease = prepared.leases.find(lease => lease.role === 'security_checker');
      if (securityCheckerLease) {
        await this.loops.executeChecker(run.id, { runtime, lease_id: securityCheckerLease.id });
      }
      const verification = this.loops.verifyLoopRun(run.id);
      const gatePass = verification.gates.every(g => g.status === 'pass' || (g.name === 'security_checker_verdict' && g.status === 'skipped'));

      return {
        success: gatePass && (verification.run.status === 'ready_for_human_merge' || verification.run.status === 'completed'),
        loopRunId: run.id, status: verification.run.status,
        requiresHumanApproval: verification.run.status === 'ready_for_human_merge',
        verdict: gatePass ? 'pass' : 'fail',
        testPassed: checks.checks.length > 0 && checks.checks.every(check => check.status === 'pass' || check.status === 'skipped')
          && checkerResult.gates.every(g => g.status === 'pass'),
        gates: verification.gates.map(g => `${g.name}:${g.status}`), runtime,
      };
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
        loopRunId,
        testPassed: false,
        gates: [],
        error: err.message,
      };
    }
  }

  async fixMultiple(requests: FixRequest[]): Promise<FixResult[]> {
    const results: FixResult[] = [];
    for (const request of requests) {
      results.push(await this.fixFile(request));
    }
    return results;
  }

  getFixHistory(limit: number = 20): Array<{ id: string; status: string; created_at: string }> {
    try {
      const rows = this.db.prepare(`
        SELECT id, status, created_at FROM loop_runs
        WHERE loop_name = 'doc-drift-and-small-fix-loop'
        ORDER BY created_at DESC LIMIT ?
      `).all(limit) as Array<{ id: string; status: string; created_at: string }>;
      return rows;
    } catch {
      return [];
    }
  }

  getStatus(): {
    totalFixRuns: number;
    successfulFixes: number;
    failedFixes: number;
    successRate: number;
  } {
    try {
      const total = (this.db.prepare("SELECT COUNT(*) as c FROM loop_runs WHERE loop_name = 'doc-drift-and-small-fix-loop'").get() as { c: number }).c;
      const success = (this.db.prepare("SELECT COUNT(*) as c FROM loop_runs WHERE loop_name = 'doc-drift-and-small-fix-loop' AND status = 'completed'").get() as { c: number }).c;
      return {
        totalFixRuns: total,
        successfulFixes: success,
        failedFixes: total - success,
        successRate: total > 0 ? success / total : 0,
      };
    } catch {
      return { totalFixRuns: 0, successfulFixes: 0, failedFixes: 0, successRate: 0 };
    }
  }
}

export { randomUUID };
