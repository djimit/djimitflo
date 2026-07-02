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
  commitSha?: string;
  diff?: string;
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
      const makerResult = await this.loops.executeMaker(run.id);
      const checkerResult = await this.loops.executeChecker(run.id);
      this.loops.certifyLoopRun(run.id);

      return {
        success: run.status === 'completed',
        testPassed: checkerResult.gates.every(g => g.status === 'pass'),
        gates: checkerResult.gates.map(g => g.name),
        diff: makerResult.stdout_path,
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

  getFixHistory(limit: number = 20): Array<{ id: string; file: string; status: string; created_at: string }> {
    const rows = this.db.prepare(`
      SELECT lr.id, lf.file, lr.status, lr.created_at
      FROM loop_runs lr
      JOIN loop_findings lf ON lf.loop_run_id = lr.id
      WHERE lr.loop_name = 'doc-drift-and-small-fix-loop'
      ORDER BY lr.created_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; file: string; status: string; created_at: string }>;
    return rows;
  }
}
