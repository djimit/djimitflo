/**
 * Swarm API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type * from "../api-client";

export const swarmApi = {
    async getSwarmStatus(): Promise<SwarmRealityStatus> {
      return this.request('/swarms/status');
    }
    async runSchedulerTick(input: { max_items?: number; plan_triaged?: boolean; prepare_planned?: boolean; runtime?: WorkerRuntime; repository_path?: string; max_assignments_per_item?: number; work_item_ids?: string[] } = {}): Promise<SchedulerTickResult> {
      return this.request('/swarms/scheduler/tick', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async syncBacklogFromFleet(input: { loop_run_ids?: string[] } = {}): Promise<BacklogFleetSyncResult> {
      return this.request('/swarms/backlog/sync', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async getKnowledgeRuntime(): Promise<KnowledgeRuntimeHealth> {
      return this.request('/swarms/knowledge/runtime');
    }
    async syncKnowledgeRuntime(input: { dry_run?: boolean; apply?: boolean } = {}): Promise<KnowledgeSyncResult> {
      return this.request('/swarms/knowledge/sync', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async closeLoopLearning(input: { loop_run_id: string; work_item_id?: string; promote_memory?: boolean }): Promise<Record<string, unknown>> {
      return this.request('/swarms/evolution/close-loop', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async planWorkerPool(input: { runtime?: WorkerRuntime; checker_runtime?: CheckerRuntime; max_workers?: number; allow_high_risk?: boolean; ignore_capacity?: boolean; simulate_low_capacity?: boolean } = {}): Promise<WorkerPoolPlanResult> {
      return this.request('/swarms/worker-pool/plan', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async startNextWorker(input: { runtime?: WorkerRuntime; checker_runtime?: CheckerRuntime; timeout_ms?: number; diff_max_lines?: number; allow_high_risk?: boolean; ignore_capacity?: boolean } = {}): Promise<WorkerPoolStartResult> {
      return this.request('/swarms/worker-pool/start-next', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async drainWorkerPool(input: { runtime?: WorkerRuntime; checker_runtime?: CheckerRuntime; max_workers?: number; timeout_ms?: number; diff_max_lines?: number; allow_high_risk?: boolean; ignore_capacity?: boolean } = {}): Promise<WorkerPoolDrainResult> {
      return this.request('/swarms/worker-pool/drain', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async stopWorkerLease(leaseId: string): Promise<WorkerPoolStopResult> {
      return this.request(`/swarms/worker-pool/stop/${leaseId}`, { method: 'POST' });
    }
    async getWorkItems(params?: { status?: string; limit?: number }): Promise<{ work_items: WorkItemRecord[] }> {
      const query = new URLSearchParams();
      if (params?.status) query.set('status', params.status);
      if (params?.limit) query.set('limit', String(params.limit));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return this.request(`/work-items${suffix}`);
    }
    async updateWorkItem(id: string, input: Partial<Pick<WorkItemRecord, 'status' | 'assigned_runtime' | 'recommended_loop'>>): Promise<WorkItemRecord> {
      return this.request(`/work-items/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    }
    async convertWorkItemToGoal(id: string): Promise<{ work_item: WorkItemRecord; goal_id: string }> {
      return this.request(`/work-items/${id}/convert-to-goal`, { method: 'POST' });
    }
    async getMemoryCandidates(limit?: number): Promise<{ candidates: MemoryCandidateRecord[] }> {
      const query = limit ? `?limit=${limit}` : '';
      return this.request(`/swarms/memory/candidates${query}`);
    }
    async promoteMemoryCandidate(id: string): Promise<{ candidate: MemoryCandidateRecord; sinks: Array<Record<string, unknown>> }> {
      return this.request(`/swarms/memory/candidates/${id}/promote`, {
        method: 'POST',
        body: JSON.stringify({ sinks: ['okf'], approved_by: 'dashboard' }),
      });
    }
    async getSpecialistCatalog(): Promise<{ specialists: SpecialistProfile[] }> {
      return this.request('/swarms/specialists/catalog');
    }
    async getSpecialistPanels(limit?: number): Promise<{ panels: SpecialistPanelRecord[] }> {
      const query = limit ? `?limit=${limit}` : '';
      return this.request(`/swarms/specialist-panels${query}`);
    }
    async createSpecialistPanel(input: {
      topic: string;
      question: string;
      risk_class?: 'low' | 'medium' | 'high' | 'critical';
      specialist_ids?: string[];
      context?: Record<string, unknown>;
    }): Promise<SpecialistPanelRecord> {
      return this.request('/swarms/specialist-panels', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async submitSpecialistReview(panelId: string, input: {
      specialist_id: string;
      stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
      confidence: number;
      findings?: string[];
      recommendations?: string[];
      evidence_refs?: string[];
      limitations?: string;
    }): Promise<SpecialistPanelRecord> {
      return this.request(`/swarms/specialist-panels/${panelId}/reviews`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    }
    async projectSpecialistPanelToBacklog(panelId: string): Promise<{ panel: SpecialistPanelRecord; work_item: WorkItemRecord; created: boolean }> {
      return this.request(`/swarms/specialist-panels/${panelId}/backlog`, { method: 'POST' });
    }
};
