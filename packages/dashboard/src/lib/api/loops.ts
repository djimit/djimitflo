/**
 * Loops API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";

export interface GoalRecord { id: string; objective: string; status: string }
export interface LoopRunRecord { id: string; goal_id: string; loop_name: string; status: string }
export interface LoopCatalogItem { name: string; description: string }
export interface RuntimeContract { runtime: string; capabilities: string[] }
export interface LoopReviewBundle { run: LoopRunRecord; gates: LoopGate[]; leases: WorkerLeaseRecord[] }
export interface WorkerLeaseRecord { id: string; loop_run_id: string; role: string; status: string }
export interface LoopGate { name: string; passed: boolean }
export interface LoopFinding { id: string; message: string }
export interface LoopEventRecord { id: string; event_type: string; message: string }
export interface GoalBatchPreviewResult { goals: GoalRecord[]; total: number }
export interface GoalBatchApplyResult { created: number; errors: string[] }
export interface ExecuteWorkerResult { run: LoopRunRecord; lease: WorkerLeaseRecord }

export const loopsApi = {

  async getGoals(): Promise<{ goals: GoalRecord[] }> {
    return request('/goals');
  },
  async createGoal(input: {
    objective: string;
    constraints?: string[];
    acceptance_criteria: string[];
    risk_class?: 'low' | 'medium' | 'high' | 'critical';
    budget?: Record<string, unknown>;
  }): Promise<GoalRecord> {
    return request('/goals', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async previewGoalBatch(input: { path?: string; batch?: unknown; selected_ids?: string[] } = {}): Promise<GoalBatchPreviewResult> {
    return request('/goals/batch/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async applyGoalBatch(input: { path?: string; batch?: unknown; selected_ids?: string[] } = {}): Promise<GoalBatchApplyResult> {
    return request('/goals/batch/apply', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async getLoopRuns(): Promise<{ runs: LoopRunRecord[] }> {
    return request('/loops/runs');
  },
  async getLoopCatalog(): Promise<{ loops: LoopCatalogItem[] }> {
    return request('/loops/catalog');
  },
  async getRuntimeContracts(): Promise<{ runtimes: Record<string, RuntimeContract> }> {
    return request('/loops/runtime-contracts');
  },
  async getLoopReviewBundle(runId: string): Promise<LoopReviewBundle> {
    return request(`/loops/runs/${runId}/review-bundle`);
  },
  async startLoop(input: { loop_name: string; repository_path: string; goal_id?: string; max_findings?: number }): Promise<LoopRunRecord> {
    return request('/loops/start', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async startDocDriftLoop(input: { repository_path: string; goal_id?: string; max_findings?: number }): Promise<LoopRunRecord> {
    return this.startLoop({ loop_name: 'doc-drift-and-small-fix-loop', ...input });
  },
  async continueLoopRun(runId: string, input: { max_assignments?: number; runtime?: 'manual' | 'codex' | 'opencode' | 'mock' } = {}): Promise<{ run: LoopRunRecord; leases: WorkerLeaseRecord[] }> {
    return request(`/loops/runs/${runId}/continue`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async executeWorker(runId: string, leaseId: string, input: { timeout_ms?: number; diff_max_lines?: number } = {}): Promise<ExecuteWorkerResult> {
    return request(`/loops/runs/${runId}/execute-worker`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, ...input }),
    });
  },
  async executeChecker(runId: string, leaseId: string, input: { runtime?: 'codex' | 'opencode' | 'mock'; timeout_ms?: number; diff_max_lines?: number } = {}): Promise<ExecuteWorkerResult> {
    return request(`/loops/runs/${runId}/execute-checker`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, ...input }),
    });
  },
  async verifyLoopRun(runId: string): Promise<{ run: LoopRunRecord; gates: LoopGate[]; leases: WorkerLeaseRecord[] }> {
    return request(`/loops/runs/${runId}/verify`, { method: 'POST' });
  },
  async stepLoopRun(runId: string): Promise<{ run: LoopRunRecord; leases: WorkerLeaseRecord[]; decision: string; next_actions: string[] }> {
    return request(`/loops/runs/${runId}/step`, { method: 'POST' });
  },
  async retryLoopRun(runId: string, makerLeaseId: string, runtime: 'manual' | 'codex' | 'opencode' | 'mock' = 'manual'): Promise<{ run: LoopRunRecord; leases: WorkerLeaseRecord[]; retry_maker: WorkerLeaseRecord; retry_checker: WorkerLeaseRecord }> {
    return request(`/loops/runs/${runId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ maker_lease_id: makerLeaseId, runtime }),
    });
  },
  async splitLoopFinding(runId: string, input: { finding_id: string; reason: string; children: Array<{ message: string; suggested_fix: string }> }): Promise<{ run: LoopRunRecord; parent: LoopFinding; children: LoopFinding[]; leases: WorkerLeaseRecord[] }> {
    return request(`/loops/runs/${runId}/split`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async submitCheckerVerdict(runId: string, leaseId: string, verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence', notes?: string): Promise<{ run: LoopRunRecord; checker: WorkerLeaseRecord }> {
    return request(`/loops/runs/${runId}/checker-verdict`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, verdict, notes: notes || '' }),
    });
  },
  async submitSecurityVerdict(runId: string, leaseId: string, verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence', notes?: string): Promise<{ run: LoopRunRecord; security_checker: WorkerLeaseRecord }> {
    return request(`/loops/runs/${runId}/security-verdict`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, verdict, notes: notes || '' }),
    });
  },
  async completeLoopRun(runId: string): Promise<{ run: LoopRunRecord; gates: LoopGate[] }> {
    return request(`/loops/runs/${runId}/complete`, { method: 'POST' });
  },
  async stopLoopRun(runId: string): Promise<{ run: LoopRunRecord; events: LoopEventRecord[] }> {
    return request(`/loops/runs/${runId}/stop`, { method: 'POST' });
  }
};
