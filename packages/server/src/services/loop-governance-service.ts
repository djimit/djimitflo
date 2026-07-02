import type { Database } from 'better-sqlite3';

export interface GateResult {
  passed: boolean;
  gates: Array<{ name: string; status: 'pass' | 'fail' | 'skipped'; evidence: string }>;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
  remaining?: number;
}

export interface LearningCurveData {
  runIndex: number;
  success: boolean;
  durationMs: number;
  tokensUsed: number;
}

export class LoopGovernanceService {
  constructor(private db: Database) {}

  checkGates(runId: string): GateResult {
    const gates: GateResult['gates'] = [];

    try {
      const run = this.db.prepare('SELECT status, gates_json FROM loop_runs WHERE id = ?').get(runId) as { status: string; gates_json: string } | undefined;
      if (!run) return { passed: false, gates: [{ name: 'existence', status: 'fail', evidence: 'run not found' }] };

      const storedGates = JSON.parse(run.gates_json || '[]') as Array<{ name: string; status: string; evidence: string }>;
      for (const gate of storedGates) {
        gates.push({ name: gate.name, status: gate.status === 'pass' ? 'pass' : 'fail', evidence: gate.evidence || '' });
      }

      if (gates.length === 0) {
        gates.push({ name: 'default', status: 'pass', evidence: 'no gates configured' });
      }
    } catch { gates.push({ name: 'error', status: 'fail', evidence: 'gate check failed' }); }

    const passed = gates.every(g => g.status === 'pass');
    return { passed, gates };
  }

  evaluateTokenBudget(_runId: string, usage: number, maxBudget: number): BudgetDecision {
    if (usage > maxBudget) {
      return { allowed: false, reason: `Token budget exceeded: ${usage}/${maxBudget}`, remaining: 0 };
    }
    return { allowed: true, remaining: maxBudget - usage };
  }

  evaluateDollarBudget(_runId: string, spent: number, maxBudget: number): BudgetDecision {
    if (spent > maxBudget) {
      return { allowed: false, reason: `Dollar budget exceeded: $${spent}/$${maxBudget}`, remaining: 0 };
    }
    return { allowed: true, remaining: maxBudget - spent };
  }

  computeLearningCurve(limit: number = 10): LearningCurveData[] {
    try {
      const runs = this.db.prepare('SELECT id, status, created_at, updated_at FROM loop_runs WHERE status IN (?, ?) ORDER BY created_at DESC LIMIT ?').all('completed', 'failed', limit) as Array<{
        id: string; status: string; created_at: string; updated_at: string;
      }>;

      return runs.map((run, index) => ({
        runIndex: index + 1,
        success: run.status === 'completed',
        durationMs: new Date(run.updated_at).getTime() - new Date(run.created_at).getTime(),
        tokensUsed: 0,
      })).reverse();
    } catch { return []; }
  }

  getSuccessRate(limit: number = 20): number {
    try {
      const runs = this.db.prepare('SELECT status FROM loop_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ status: string }>;
      if (runs.length === 0) return 0;
      const completed = runs.filter(r => r.status === 'completed').length;
      return completed / runs.length;
    } catch { return 0; }
  }

  shouldEscalate(_runId: string, failureCount: number, threshold: number = 3): boolean {
    return failureCount >= threshold;
  }

  getBudgetStatus(runId: string): { tokensUsed: number; leasesActive: number; leasesCompleted: number } {
    try {
      const leases = this.db.prepare('SELECT status FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ status: string }>;
      return {
        tokensUsed: 0,
        leasesActive: leases.filter(l => l.status === 'running').length,
        leasesCompleted: leases.filter(l => l.status === 'completed').length,
      };
    } catch { return { tokensUsed: 0, leasesActive: 0, leasesCompleted: 0 }; }
  }
}
