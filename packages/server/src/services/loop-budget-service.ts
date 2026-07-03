/**
 * LoopBudgetService — token budget, cost tracking, concurrency control.
 *
 * Extracted from LoopService (Phase 2 decomposition).
 * Handles: dollar cost computation, budget allocation, efficiency metrics,
 * concurrency adjustment, failure threshold tracking.
 *
 * This service owns pure budget logic. Data access is delegated to the parent
 * LoopService via the DataAccess interface, avoiding duplication of JSON parsing.
 */

import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';
import type { LoopRunRecord, WorkerLeaseRecord } from './loop-service';

export interface RuntimeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens: number;
  usage_source?: string;
}

export interface TokenBudgetResult {
  gate: { name: string; status: 'pass' | 'fail' | 'skipped'; evidence: string };
  exhausted: boolean;
  efficiencyExceeded: boolean;
  budget: Record<string, unknown>;
}

interface GoalBudget {
  max_tokens?: number;
  max_tokens_per_worker?: number;
  max_tokens_per_diff_line?: number;
  max_maker_workers?: number;
  max_workers?: number;
  max_retries?: number;
  max_failure_count?: number;
  max_runtime_ms?: number;
}

interface GoalRecord {
  id: string;
  budget: GoalBudget;
}

/**
 * Data access delegation interface.
 * LoopService implements this so LoopBudgetService doesn't duplicate JSON parsing.
 */
export interface LoopBudgetDataAccess {
  getGoal(id: string): GoalRecord;
  getLoopRun(id: string): LoopRunRecord;
  listWorkerLeases(runId: string): WorkerLeaseRecord[];
  recordLoopEvent(runId: string, eventType: string, severity: string, message: string, metadata: Record<string, unknown>): void;
}

const PRICE_PER_MTOK: Record<string, number> = {
  codex: 2.0, opencode: 0.5, claude: 3.0, gemini: 1.0, pi: 0, editor: 0, mock: 0,
};

export class LoopBudgetService {
  constructor(
    private db: Database,
    private data: LoopBudgetDataAccess,
  ) {}

  computeDollarCost(runtime: string, totalTokens: number): number {
    const price = PRICE_PER_MTOK[runtime] ?? 2.0;
    return (totalTokens / 1_000_000) * price;
  }

  allocateDollarBudget(
    findings: Array<{ finding_id: string; capability_id: string; p50_dollars: number; competence: number }>,
    budget: number,
  ): { allocated: string[]; deferred: string[]; budgetInsufficient: boolean } {
    if (findings.length === 0) return { allocated: [], deferred: [], budgetInsufficient: false };
    const sorted = [...findings].sort((a, b) => (b.competence / b.p50_dollars) - (a.competence / a.p50_dollars));
    const allocated: string[] = [];
    const deferred: string[] = [];
    let remaining = budget;
    for (const finding of sorted) {
      if (finding.p50_dollars <= remaining) {
        allocated.push(finding.finding_id);
        remaining -= finding.p50_dollars;
      } else {
        deferred.push(finding.finding_id);
      }
    }
    return { allocated, deferred, budgetInsufficient: allocated.length === 0 };
  }

  computeEfficiencyMetric(runId: string): { verifiedArtifacts: number; dollarsSpent: number; efficiency: number } {
    const leases = this.db.prepare('SELECT metadata FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ metadata: string }>;
    let totalTokens = 0;
    let runtime = 'codex';
    for (const lease of leases) {
      try {
        const meta = JSON.parse(lease.metadata || '{}');
        const usage = meta.runtime_usage as { total_tokens?: number } | undefined;
        if (usage?.total_tokens) totalTokens += usage.total_tokens;
        if (meta.runtime) runtime = meta.runtime as string;
      } catch { /* skip */ }
    }
    const dollarsSpent = this.computeDollarCost(runtime, totalTokens);
    const verifiedArtifacts = this.db.prepare(
      "SELECT COUNT(*) as c FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' AND status = 'completed'"
    ).get(runId) as { c: number };
    return {
      verifiedArtifacts: verifiedArtifacts.c,
      dollarsSpent,
      efficiency: dollarsSpent > 0 ? verifiedArtifacts.c / dollarsSpent : 0,
    };
  }

  adjustConcurrency(increase: boolean): { success: boolean; dynamicLimit: number; active: number; queueDepth: number } {
    const active = this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'running'").get() as { c: number };
    const queue = this.db.prepare("SELECT COUNT(*) as c FROM worker_leases WHERE status = 'prepared'").get() as { c: number };
    const currentLimit = Number(process.env.RUNTIME_MAX_CONCURRENCY) || 5;
    const dynamicLimit = increase ? currentLimit + 1 : Math.max(1, currentLimit - 1);

    swarmEventBus.emit('aimd_state', {
      success: true,
      dynamicLimit,
      active: active.c,
      queue_depth: queue.c,
    });

    return { success: true, dynamicLimit, active: active.c, queueDepth: queue.c };
  }

  getMakerLeaseBudget(run: LoopRunRecord, maxMakerWorkers?: number): { maxMakerWorkers: number; source: 'goal' | 'request' | 'default' } {
    if (run.goal_id) {
      const goal = this.data.getGoal(run.goal_id);
      const maxFromGoal = Number(goal.budget.max_maker_workers ?? goal.budget.max_workers);
      if (Number.isFinite(maxFromGoal) && maxFromGoal > 0) {
        return { maxMakerWorkers: Math.min(Math.floor(maxFromGoal), 100), source: 'goal' };
      }
    }
    const maxFromRequest = Number(maxMakerWorkers);
    if (Number.isFinite(maxFromRequest) && maxFromRequest > 0) {
      return { maxMakerWorkers: Math.min(Math.floor(maxFromRequest), 100), source: 'request' };
    }
    return { maxMakerWorkers: 5, source: 'default' };
  }

  getRetryBudget(run: LoopRunRecord, maker: WorkerLeaseRecord, maxRetries?: number): { maxRetries: number; source: 'goal' | 'request' | 'lease' | 'default' } {
    if (run.goal_id) {
      const goal = this.data.getGoal(run.goal_id);
      const maxFromGoal = Number(goal.budget.max_retries);
      if (Number.isFinite(maxFromGoal) && maxFromGoal >= 0) {
        return { maxRetries: Math.min(Math.floor(maxFromGoal), 10), source: 'goal' };
      }
    }
    const maxFromRequest = Number(maxRetries);
    if (Number.isFinite(maxFromRequest) && maxFromRequest >= 0) {
      return { maxRetries: Math.min(Math.floor(maxFromRequest), 10), source: 'request' };
    }
    const maxFromLease = Number(maker.budget.max_retries);
    if (Number.isFinite(maxFromLease) && maxFromLease >= 0) {
      return { maxRetries: Math.min(Math.floor(maxFromLease), 10), source: 'lease' };
    }
    return { maxRetries: 1, source: 'default' };
  }

  getFailureThreshold(run: LoopRunRecord): { maxFailureCount: number; source: 'goal' | 'default' } {
    if (run.goal_id) {
      const goal = this.data.getGoal(run.goal_id);
      const maxFromGoal = Number(goal.budget.max_failure_count);
      if (Number.isFinite(maxFromGoal) && maxFromGoal > 0) {
        return { maxFailureCount: Math.min(Math.floor(maxFromGoal), 20), source: 'goal' };
      }
    }
    return { maxFailureCount: 3, source: 'default' };
  }

  getTokenBudget(run: LoopRunRecord): { maxTokens?: number; maxTokensPerWorker?: number; maxTokensPerDiffLine?: number; source: 'goal' | 'none' } {
    if (!run.goal_id) return { source: 'none' };
    const goal = this.data.getGoal(run.goal_id);
    const maxTokens = Number(goal.budget.max_tokens);
    const maxTokensPerWorker = Number(goal.budget.max_tokens_per_worker);
    const maxTokensPerDiffLine = Number(goal.budget.max_tokens_per_diff_line);
    return {
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : undefined,
      maxTokensPerWorker: Number.isFinite(maxTokensPerWorker) && maxTokensPerWorker > 0 ? Math.floor(maxTokensPerWorker) : undefined,
      maxTokensPerDiffLine: Number.isFinite(maxTokensPerDiffLine) && maxTokensPerDiffLine > 0 ? Math.floor(maxTokensPerDiffLine) : undefined,
      source: 'goal',
    };
  }

  getWallClockBudget(run: LoopRunRecord): { maxRuntimeMs?: number; source: 'goal' | 'none' } {
    if (!run.goal_id) return { source: 'none' };
    const goal = this.data.getGoal(run.goal_id);
    const maxRuntimeMs = Number(goal.budget.max_runtime_ms);
    return {
      maxRuntimeMs: Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0 ? Math.floor(maxRuntimeMs) : undefined,
      source: 'goal',
    };
  }

  evaluateTokenBudget(run: LoopRunRecord, runtimeUsage: RuntimeUsage | null, currentLeaseId: string, diffLines?: number): TokenBudgetResult {
    const budget = this.getTokenBudget(run);
    if (!budget.maxTokens && !budget.maxTokensPerWorker) {
      return {
        gate: { name: 'token_budget', status: 'skipped', evidence: 'No token budget configured for this goal.' },
        exhausted: false,
        efficiencyExceeded: false,
        budget,
      };
    }
    if (!runtimeUsage) {
      return {
        gate: { name: 'token_budget', status: 'skipped', evidence: 'Runtime did not report token usage; no estimate was used.' },
        exhausted: false,
        efficiencyExceeded: false,
        budget,
      };
    }
    const usedBeforeCurrent = this.sumRuntimeTokens(
      this.data.listWorkerLeases(run.id).filter((lease) => lease.id !== currentLeaseId)
    );
    const totalAfterCurrent = usedBeforeCurrent + runtimeUsage.total_tokens;
    const perWorkerExceeded = Boolean(budget.maxTokensPerWorker && runtimeUsage.total_tokens > budget.maxTokensPerWorker);
    const totalExceeded = Boolean(budget.maxTokens && totalAfterCurrent > budget.maxTokens);
    const exhausted = perWorkerExceeded || totalExceeded;
    const tokensPerDiffLine = diffLines && diffLines > 0 ? runtimeUsage.total_tokens / diffLines : null;
    const efficiencyExceeded = Boolean(budget.maxTokensPerDiffLine && tokensPerDiffLine !== null && tokensPerDiffLine > budget.maxTokensPerDiffLine);

    return {
      gate: {
        name: 'token_budget',
        status: exhausted ? 'fail' : 'pass',
        evidence: `runtime_usage=${runtimeUsage.total_tokens}, total_after_current=${totalAfterCurrent}, max_tokens=${budget.maxTokens ?? 'unset'}, max_tokens_per_worker=${budget.maxTokensPerWorker ?? 'unset'}.`,
      },
      exhausted,
      efficiencyExceeded,
      budget: {
        ...budget,
        used_before_current: usedBeforeCurrent,
        total_after_current: totalAfterCurrent,
        efficiency_exceeded: efficiencyExceeded,
      },
    };
  }

  sumRuntimeTokens(leases: WorkerLeaseRecord[]): number {
    return leases.reduce((sum, lease) => {
      const usage = lease.metadata.runtime_usage as { total_tokens?: unknown } | undefined;
      const total = Number(usage?.total_tokens);
      return Number.isFinite(total) && total > 0 ? sum + total : sum;
    }, 0);
  }

  escalateIfFailureThresholdExceeded(runId: string, reason: string): LoopRunRecord {
    const run = this.data.getLoopRun(runId);
    const threshold = this.getFailureThreshold(run);
    const leases = this.data.listWorkerLeases(runId);
    const failureCount = this.countLoopFailures(leases);
    if (failureCount < threshold.maxFailureCount) {
      return run;
    }
    if (run.status !== 'escalated') {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, next_actions_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        'escalated',
        JSON.stringify(['Human review required before leasing more workers', 'Inspect review bundle and decide retry, split, or cancel']),
        now,
        runId,
      );
      this.data.recordLoopEvent(runId, 'loop_escalated', 'warning', `Loop escalated after ${failureCount} failure(s).`, {
        reason,
        failure_count: failureCount,
        failure_threshold: threshold,
      });
    }
    return this.data.getLoopRun(runId);
  }

  countLoopFailures(leases: WorkerLeaseRecord[]): number {
    const makerFailures = leases.filter((lease) => lease.role === 'maker' && lease.status === 'failed').length;
    const checkerFailures = leases.filter((lease) => (
      (lease.role === 'checker' || lease.role === 'security_checker')
      && ['needs_revision', 'rejected', 'insufficient_evidence'].includes(String(lease.metadata.verdict || ''))
    )).length;
    return makerFailures + checkerFailures;
  }
}
