import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';

export interface FixRequest {
  repositoryPath: string;
  filePath: string;
  description: string;
  category: 'bug' | 'security' | 'performance' | 'refactor';
}

export interface FixResult {
  success: boolean;
  loopRunId?: string;
  verdict?: string;
  testPassed: boolean;
  gates: string[];
  error?: string;
}

export class FixLoopService {
  constructor(
    private db: Database,
    private loops: LoopService,
  ) {}

  async fixFile(request: FixRequest): Promise<FixResult> {
    try {
      const run = this.loops.startDocDriftAndSmallFixLoop({
        repository_path: request.repositoryPath,
      });

      this.loops.planLoopRun(run.id);
      await this.loops.executeMaker(run.id, { runtime: 'mock' });
      const checkerResult = await this.loops.executeChecker(run.id, { runtime: 'mock' });
      const cert = this.loops.certifyLoopRun(run.id);

      return {
        success: run.status === 'completed',
        loopRunId: run.id,
        verdict: cert.certified ? 'certified' : 'not_certified',
        testPassed: checkerResult.gates.length > 0 && checkerResult.gates.every(g => g.status === 'pass'),
        gates: checkerResult.gates.map(g => `${g.name}:${g.status}`),
      };
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
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
