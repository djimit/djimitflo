/**
 * Swarm API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";

export interface WorkerRuntime {
  type: string;
  concurrency: number;
  capabilities?: string[];
}
export type CheckerRuntime = Exclude<WorkerRuntime, { type: 'manual' }>;

export type WorkerPoolDecision = {

  lease_id: string;
  loop_run_id: string;
  role: string;
  runtime: string;
  effective_runtime: string;
  status: string;
  risk_class: string;
  eligible: boolean;
  blocked_reasons: string[];
  priority_score: number;
  queue_age_ms: number;
  bottleneck_reason: string | null;
  next_action: 'execute_maker' | 'execute_checker' | 'human_review' | 'wait';

};

export type WorkerPoolPlanResult = {

  decisions: WorkerPoolDecision[];
  eligible_count: number;
  blocked_count: number;
  running_count: number;
  max_workers: number;
  capacity_snapshot: SwarmRealityStatus['resource_snapshot'];

};

export type WorkerPoolStartResult = {

  action: 'started' | 'blocked';
  decision: WorkerPoolDecision | null;
  plan: WorkerPoolPlanResult;
  execution?: ExecuteWorkerResult;

};

export type WorkerPoolDrainResult = {

  action: 'drained';
  started: WorkerPoolStartResult[];
  final_plan: WorkerPoolPlanResult;

};

export type WorkerPoolStopResult = {

  lease: WorkerLeaseRecord;
  event: LoopEventRecord;

};

export type SchedulerTickResult = {

  created_work_items: WorkItemRecord[];
  planned_work_items: WorkItemRecord[];
  prepared_work_items: WorkItemRecord[];
  skipped_existing: number;
  inspected_loop_runs: number;
  leases_created: number;

};

export type BacklogFleetSyncResult = {

  inspected_work_items: number;
  updated_work_items: WorkItemRecord[];

};

export type KnowledgeRuntimeHealth = {

  okf_base: string | null;
  canonical_candidate: string;
  symlink_target: string | null;
  exists: boolean;
  valid: boolean;
  validate_okf: {
    status: 'pass' | 'fail' | 'skipped';
    command: string | null;
    stdout: string;
    stderr: string;
  
};

export type KnowledgeSyncResult = {

  dry_run: boolean;
  okf_base: string;
  created: number;
  updated: number;
  blocked: number;
  unchanged: number;
  capabilities: Array<Record<string, unknown>>;

};

export type SwarmRealityStatus = {

  registry_agent_count: number;
  live_agent_count: number;
  worker_lease_count: number;
  active_execution_count: number;
  task_count: {
    open_work_items: number;
    open_loop_runs: number;
    open_tasks: number;
    total: number;
  
};

export type WorkItemRecord = {

  id: string;
  title: string;
  description: string;
  source: string;
  source_ref: string | null;
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  value_score: number;
  confidence: number;
  status: 'candidate' | 'triaged' | 'planned' | 'leased' | 'blocked' | 'done' | 'discarded';
  recommended_loop: string | null;
  assigned_agent_id: string | null;
  assigned_runtime: string | null;
  parent_goal_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;

};

export type MemoryCandidateRecord = {

  id: string;
  title: string;
  content: string;
  memory_type: 'operational_memory' | 'engineering_rule' | 'policy_rule';
  source_ref: string | null;
  status: 'candidate' | 'review_required' | 'rejected' | 'promoted';
  promotion_status: 'proposed' | 'blocked_pending_review' | 'blocked_pending_human' | 'rejected' | 'promoted';
  human_required: boolean;
  sensitivity: 'normal' | 'security_sensitive' | 'secret_detected';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;

};

export type SpecialistProfile = {

  id: string;
  title: string;
  domains: string[];
  default_questions: string[];
  required_evidence: string[];
  forbidden_claims: string[];
  output_schema: string[];

};

export type SpecialistPanelRecord = {

  id: string;
  topic: string;
  question: string;
  status: 'planned' | 'reviewing' | 'consensus_ready' | 'backlog_created' | 'goal_created' | 'cancelled';
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  panel: SpecialistProfile[];
  context: Record<string, unknown>;
  consensus: SpecialistConsensus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reviews?: SpecialistReviewRecord[];

};

export const swarmApi = {

  async getSwarmStatus(): Promise<SwarmRealityStatus> {
    return request('/swarms/status');
  },
  async runSchedulerTick(input: { max_items?: number; plan_triaged?: boolean; prepare_planned?: boolean; runtime?: WorkerRuntime; repository_path?: string; max_assignments_per_item?: number; work_item_ids?: string[] } = {}): Promise<SchedulerTickResult> {
    return request('/swarms/scheduler/tick', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async syncBacklogFromFleet(input: { loop_run_ids?: string[] } = {}): Promise<BacklogFleetSyncResult> {
    return request('/swarms/backlog/sync', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async getKnowledgeRuntime(): Promise<KnowledgeRuntimeHealth> {
    return request('/swarms/knowledge/runtime');
  },
  async syncKnowledgeRuntime(input: { dry_run?: boolean; apply?: boolean } = {}): Promise<KnowledgeSyncResult> {
    return request('/swarms/knowledge/sync', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async closeLoopLearning(input: { loop_run_id: string; work_item_id?: string; promote_memory?: boolean }): Promise<Record<string, unknown>> {
    return request('/swarms/evolution/close-loop', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async planWorkerPool(input: { runtime?: WorkerRuntime; checker_runtime?: CheckerRuntime; max_workers?: number; allow_high_risk?: boolean; ignore_capacity?: boolean; simulate_low_capacity?: boolean } = {}): Promise<WorkerPoolPlanResult> {
    return request('/swarms/worker-pool/plan', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async startNextWorker(input: { runtime?: WorkerRuntime; checker_runtime?: CheckerRuntime; timeout_ms?: number; diff_max_lines?: number; allow_high_risk?: boolean; ignore_capacity?: boolean } = {}): Promise<WorkerPoolStartResult> {
    return request('/swarms/worker-pool/start-next', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async drainWorkerPool(input: { runtime?: WorkerRuntime; checker_runtime?: CheckerRuntime; max_workers?: number; timeout_ms?: number; diff_max_lines?: number; allow_high_risk?: boolean; ignore_capacity?: boolean } = {}): Promise<WorkerPoolDrainResult> {
    return request('/swarms/worker-pool/drain', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async stopWorkerLease(leaseId: string): Promise<WorkerPoolStopResult> {
    return request(`/swarms/worker-pool/stop/${leaseId}`, { method: 'POST' });
  },
  async getWorkItems(params?: { status?: string; limit?: number }): Promise<{ work_items: WorkItemRecord[] }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request(`/work-items${suffix}`);
  },
  async updateWorkItem(id: string, input: Partial<Pick<WorkItemRecord, 'status' | 'assigned_runtime' | 'recommended_loop'>>): Promise<WorkItemRecord> {
    return request(`/work-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  async convertWorkItemToGoal(id: string): Promise<{ work_item: WorkItemRecord; goal_id: string }> {
    return request(`/work-items/${id}/convert-to-goal`, { method: 'POST' });
  },
  async getMemoryCandidates(limit?: number): Promise<{ candidates: MemoryCandidateRecord[] }> {
    const query = limit ? `?limit=${limit}` : '';
    return request(`/swarms/memory/candidates${query}`);
  },
  async promoteMemoryCandidate(id: string): Promise<{ candidate: MemoryCandidateRecord; sinks: Array<Record<string, unknown>> }> {
    return request(`/swarms/memory/candidates/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ sinks: ['okf'], approved_by: 'dashboard' }),
    });
  },
  async getSpecialistCatalog(): Promise<{ specialists: SpecialistProfile[] }> {
    return request('/swarms/specialists/catalog');
  },
  async getSpecialistPanels(limit?: number): Promise<{ panels: SpecialistPanelRecord[] }> {
    const query = limit ? `?limit=${limit}` : '';
    return request(`/swarms/specialist-panels${query}`);
  },
  async createSpecialistPanel(input: {
    topic: string;
    question: string;
    risk_class?: 'low' | 'medium' | 'high' | 'critical';
    specialist_ids?: string[];
    context?: Record<string, unknown>;
  }): Promise<SpecialistPanelRecord> {
    return request('/swarms/specialist-panels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async submitSpecialistReview(panelId: string, input: {
    specialist_id: string;
    stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
    confidence: number;
    findings?: string[];
    recommendations?: string[];
    evidence_refs?: string[];
    limitations?: string;
  }): Promise<SpecialistPanelRecord> {
    return request(`/swarms/specialist-panels/${panelId}/reviews`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async projectSpecialistPanelToBacklog(panelId: string): Promise<{ panel: SpecialistPanelRecord; work_item: WorkItemRecord; created: boolean }> {
    return request(`/swarms/specialist-panels/${panelId}/backlog`, { method: 'POST' });
  }
};
