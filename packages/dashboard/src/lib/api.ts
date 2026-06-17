/**
 * API client for Djimitflo backend
 */

import type {
  ApprovalRequest,
  ApprovalPolicy,
  ExecutionPolicy,
  RiskAssessment,
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  Agent,
  MCPServer,
  MCPTool,
  ExecutionEvent,
  Approval,
  ApprovalDecision,
  ExecutionEvidence,
  ExecutionSummary,
  FileChange,
  ObservabilityMetrics,
  AuditTrailEntry,
  Repository,
  RepositoryScanResult,
  RepositoryHealthFinding,
  AgentsMdIssue,
  ExportFormat,
  ExportRequest,
} from '@djimitflo/shared';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const AUTH_SESSION_KEY = 'djimitflo_auth_session';

type UsageQuota = {
  provider: string;
  tier: string;
  is_active: boolean;
  tokens_used_hourly: number;
  tokens_used_daily: number;
  tokens_used_weekly: number;
  tokens_used_monthly: number;
  quota_hourly: number | null;
  quota_daily: number | null;
  quota_weekly: number | null;
  quota_monthly: number | null;
  cost_total: number;
  cost_per_1k_prompt: number | null;
  cost_per_1k_completion: number | null;
  rate_limit_rpm: number | null;
  rate_limit_rpd: number | null;
};

type UsageBreakdown = {
  date: string;
  tokens: number;
  cost: number;
};

type UsageLog = {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  task_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
};

export type GoalRecord = {
  id: string;
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  budget: Record<string, unknown>;
  status: string;
  owner_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type LoopFinding = {
  id: string;
  type: string;
  severity: 'info' | 'warning';
  file: string;
  line?: number;
  message: string;
  evidence: string;
  suggested_fix: string;
  parent_finding_id?: string;
  metadata?: Record<string, unknown>;
};

export type LoopGate = {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  evidence: string;
};

export type LoopRunRecord = {
  id: string;
  goal_id: string | null;
  loop_name: string;
  mode: 'closed' | 'open';
  status: string;
  repository_path: string | null;
  state_file: string | null;
  findings: LoopFinding[];
  plan: Record<string, unknown>;
  gates: LoopGate[];
  next_actions: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type LoopCatalogItem = {
  name: string;
  title: string;
  description: string;
  mode: 'closed';
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  trigger: string[];
  context_sources: string[];
  actions_allowed: string[];
  actions_forbidden: string[];
  verification: string[];
  state: string[];
  escalation: string[];
  stop_conditions: string[];
  status: string;
  gates: string[];
  runtimes: Record<string, { available: boolean; command: string | null; version?: string; reason?: string }>;
};

export type WorkerLeaseRecord = {
  id: string;
  loop_run_id: string;
  role: string;
  runtime: string;
  status: string;
  finding_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  budget: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type LoopEventRecord = {
  id: string;
  loop_run_id: string;
  event_type: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type LoopReviewBundle = {
  run: LoopRunRecord;
  leases: WorkerLeaseRecord[];
  events: LoopEventRecord[];
  state_content: string | null;
};

export type ExecuteWorkerResult = {
  run: LoopRunRecord;
  lease: WorkerLeaseRecord;
  gates: LoopGate[];
  stdout_path: string;
  stderr_path: string;
  checkpoint_before: Record<string, unknown>;
  checkpoint_after: Record<string, unknown>;
  trace: Record<string, unknown>;
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
  backlog_count: Record<string, number>;
  stale_agents: Array<{ id: string; name: string; status: string; last_active_at: string | null }>;
  resource_snapshot: {
    cpu_threads: number;
    total_memory_bytes: number;
    free_memory_bytes: number;
    load_average: number[];
    uptime_seconds: number;
  };
  reality_check: {
    agent_count_is_registry_only: boolean;
    active_execution_requires_runtime_evidence: boolean;
  };
};

export type SchedulerTickResult = {
  created_work_items: WorkItemRecord[];
  planned_work_items: WorkItemRecord[];
  skipped_existing: number;
  inspected_loop_runs: number;
  leases_created: number;
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

export type SpecialistReviewRecord = {
  id: string;
  panel_id: string;
  specialist_id: string;
  specialist_title: string;
  stance: 'support' | 'oppose' | 'uncertain' | 'needs_evidence';
  confidence: number;
  findings: string[];
  recommendations: string[];
  evidence_refs: string[];
  limitations: string | null;
  status: 'draft' | 'submitted' | 'rejected';
  created_at: string;
  updated_at: string;
};

export type SpecialistConsensus = {
  required_reviews: number;
  submitted_reviews: number;
  support_count: number;
  oppose_count: number;
  uncertain_count: number;
  needs_evidence_count: number;
  average_confidence: number;
  consensus_level: 'strong' | 'weak' | 'blocked' | 'no_consensus';
  decision: 'goal' | 'backlog' | 'needs_more_evidence' | 'blocked';
  dissent: Array<Pick<SpecialistReviewRecord, 'specialist_id' | 'specialist_title' | 'stance' | 'limitations'>>;
  next_actions: string[];
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

export type AgentEvalRunRecord = {
  id: string;
  suite_name: string;
  target_type: 'memory' | 'skill' | 'swarm' | 'loop' | 'capability';
  target_ref: string | null;
  status: 'passed' | 'failed' | 'needs_review';
  score: number;
  scorecard: Record<string, unknown>;
  findings: unknown[];
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AgentAssuranceSummary = {
  trace_count: number;
  trace_span_count: number;
  checkpoint_count: number;
  eval_run_count: number;
  active_capability_count: number;
  pending_capability_count: number;
  reflection_review_required_count: number;
  latest_evals: AgentEvalRunRecord[];
  guardrails: {
    external_writes_from_evals: number;
    capability_sensitive_material_stored?: boolean;
    replay_copies_worker_leases: boolean;
    [key: string]: unknown;
  };
};

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem(AUTH_SESSION_KEY);
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE}${endpoint}`;
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers as Record<string, string>,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      window.location.href = '/login';
      throw new Error('Session expired');
    }

    if (response.status === 403) {
      throw new Error('Access denied');
    }

    if (response.status === 404) {
      throw new Error('Not found');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || error.error?.message || `API error: ${response.status}`);
    }

    return response.json();
  }

  // Tasks
  async getTasks(params?: { status?: string; agent_id?: string }): Promise<{ tasks: Task[]; total: number }> {
    const query = new URLSearchParams(params as Record<string, string>);
    return this.request(`/tasks?${query}`);
  }

  async getTask(id: string): Promise<Task> {
    return this.request(`/tasks/${id}`);
  }

  async createTask(input: TaskCreateInput): Promise<Task> {
    return this.request('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
    return this.request(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async deleteTask(id: string): Promise<void> {
    return this.request(`/tasks/${id}`, {
      method: 'DELETE',
    });
  }

  async executeTask(id: string, executor: 'mock' | 'opencode' = 'opencode'): Promise<{ message: string; task_id: string; executor: string; status: string; approvalId?: string; reason?: string }> {
    return this.request(`/tasks/${id}/execute`, {
      method: 'POST',
      body: JSON.stringify({ executor }),
    });
  }

  async cancelTask(id: string): Promise<{ message: string; task_id: string }> {
    return this.request(`/tasks/${id}/cancel`, {
      method: 'POST',
    });
  }

  // Agents
  async getAgents(): Promise<{ agents: Agent[] }> {
    return this.request('/agents');
  }

  async getAgent(id: string): Promise<Agent> {
    return this.request(`/agents/${id}`);
  }

  // MCP
  async getMCPServers(): Promise<{ servers: MCPServer[] }> {
    return this.request('/mcp/servers');
  }

  async getMCPTools(serverId?: string): Promise<{ tools: MCPTool[] }> {
    const query = serverId ? `?server_id=${serverId}` : '';
    return this.request(`/mcp/tools${query}`);
  }

  // Execution Events
  async getExecutionEvents(taskId: string): Promise<{ events: ExecutionEvent[] }> {
    return this.request(`/tasks/${taskId}/events`);
  }

  // Approvals
  async getApprovals(taskId: string): Promise<{ approvals: ApprovalRequest[] }> {
    return this.request(`/tasks/${taskId}/approvals`);
  }

  async getAllApprovals(status?: string): Promise<{ approvals: ApprovalRequest[] }> {
    const query = status ? `?status=${status}` : '';
    return this.request(`/approvals${query}`);
  }

  async getApproval(approvalId: string): Promise<ApprovalRequest> {
    return this.request(`/approvals/${approvalId}`);
  }

  async approveRequest(approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    return this.request(`/approvals/${approvalId}`, {
      method: 'PATCH',
      body: JSON.stringify(decision),
    });
  }

  async approveRequestExplicit(approvalId: string, reason?: string): Promise<ApprovalRequest> {
    return this.request(`/approvals/${approvalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async denyRequestExplicit(approvalId: string, reason: string): Promise<ApprovalRequest> {
    return this.request(`/approvals/${approvalId}/deny`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async getPolicies(): Promise<{ policies: ExecutionPolicy[] }> {
    return this.request('/policies');
  }

  async createPolicy(input: Partial<ApprovalPolicy>): Promise<ExecutionPolicy> {
    return this.request('/policies', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async updatePolicy(id: string, input: Partial<ApprovalPolicy>): Promise<ExecutionPolicy> {
    return this.request(`/policies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async assessCommand(command: string, workspacePath?: string): Promise<{ assessment: RiskAssessment }> {
    return this.request('/risk/command', {
      method: 'POST',
      body: JSON.stringify({ command, workspacePath }),
    });
  }

  async assessTask(task: Task, executorKind = 'opencode'): Promise<{ assessment: RiskAssessment }> {
    return this.request('/risk/task', {
      method: 'POST',
      body: JSON.stringify({ task, executorKind }),
    });
  }

  async getMCPPermissions(): Promise<{ permissions: Array<Record<string, unknown>> }> {
    return this.request('/mcp/permissions');
  }

  async updateMCPPermission(toolId: string, input: Record<string, unknown>): Promise<{ permission: Record<string, unknown> }> {
    return this.request(`/mcp/permissions/${toolId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  // Health
  async getHealth(): Promise<{ status: string; timestamp: string; uptime: number }> {
    const url = API_BASE.replace('/api', '/health');
    const response = await fetch(url);
    return response.json();
  }

  // Evidence
  async getTaskEvidence(taskId: string, filters?: { evidence_type?: string; severity?: string }): Promise<{ evidence: ExecutionEvidence[] }> {
    const params = new URLSearchParams();
    if (filters?.evidence_type) params.set('evidence_type', filters.evidence_type);
    if (filters?.severity) params.set('severity', filters.severity);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/evidence/task/${taskId}${query}`);
  }

  async getExecutionSummary(taskId: string): Promise<{ summary: ExecutionSummary | null }> {
    return this.request(`/evidence/summary/${taskId}`);
  }

  async getFileChanges(taskId: string): Promise<{ file_changes: FileChange[] }> {
    return this.request(`/evidence/file-changes/${taskId}`);
  }

  async getAuditTrail(taskId: string): Promise<{ trail: AuditTrailEntry[] }> {
    return this.request(`/evidence/audit-trail/${taskId}`);
  }

  async getExecutionReview(taskId: string): Promise<{
    task: Task;
    summary: ExecutionSummary | null;
    evidence: ExecutionEvidence[];
    file_changes: FileChange[];
    audit_trail: AuditTrailEntry[];
  }> {
    return this.request(`/evidence/review/${taskId}`);
  }

  // Observability
  async getObservabilityMetrics(): Promise<ObservabilityMetrics> {
    return this.request('/observability/metrics');
  }

  async getRiskTrends(days?: number): Promise<{ trends: Array<{ date: string; risk_level: string; count: number }> }> {
    const query = days ? `?days=${days}` : '';
    return this.request(`/observability/risk-trends${query}`);
  }

  async getPolicyStats(): Promise<{
    policies: Array<Record<string, unknown>>;
    decision_counts: Array<Record<string, unknown>>;
    recent_denials: Array<Record<string, unknown>>;
  }> {
    return this.request('/observability/policy-stats');
  }

  async getExecutionActivity(hours?: number): Promise<{
    activity: Array<Record<string, unknown>>;
    recent_tasks: Array<Record<string, unknown>>;
  }> {
    const query = hours ? `?hours=${hours}` : '';
    return this.request(`/observability/execution-activity${query}`);
  }

  // Usage
  async getUsageQuotas(): Promise<{ quotas: UsageQuota[] }> {
    return this.request('/usage/quotas');
  }

  async getUsageTokens(params?: { group_by?: 'hour' | 'day'; days?: number }): Promise<{
    total_tokens: number;
    total_cost: number;
    breakdown: UsageBreakdown[];
  }> {
    const query = new URLSearchParams();
    if (params?.group_by) query.set('group_by', params.group_by);
    if (params?.days) query.set('days', String(params.days));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request(`/usage/tokens${suffix}`);
  }

  async getUsageRecent(limit?: number): Promise<{ logs: UsageLog[] }> {
    const query = limit ? `?limit=${limit}` : '';
    return this.request(`/usage/recent${query}`);
  }

  // Goals and loops
  async getGoals(): Promise<{ goals: GoalRecord[] }> {
    return this.request('/goals');
  }

  async createGoal(input: {
    objective: string;
    constraints?: string[];
    acceptance_criteria: string[];
    risk_class?: 'low' | 'medium' | 'high' | 'critical';
    budget?: Record<string, unknown>;
  }): Promise<GoalRecord> {
    return this.request('/goals', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getLoopRuns(): Promise<{ runs: LoopRunRecord[] }> {
    return this.request('/loops/runs');
  }

  async getLoopCatalog(): Promise<{ loops: LoopCatalogItem[] }> {
    return this.request('/loops/catalog');
  }

  async getLoopReviewBundle(runId: string): Promise<LoopReviewBundle> {
    return this.request(`/loops/runs/${runId}/review-bundle`);
  }

  async startLoop(input: { loop_name: string; repository_path: string; goal_id?: string; max_findings?: number }): Promise<LoopRunRecord> {
    return this.request('/loops/start', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async startDocDriftLoop(input: { repository_path: string; goal_id?: string; max_findings?: number }): Promise<LoopRunRecord> {
    return this.startLoop({ loop_name: 'doc-drift-and-small-fix-loop', ...input });
  }

  async continueLoopRun(runId: string, input: { max_assignments?: number; runtime?: 'manual' | 'codex' | 'opencode' | 'mock' } = {}): Promise<{ run: LoopRunRecord; leases: WorkerLeaseRecord[] }> {
    return this.request(`/loops/runs/${runId}/continue`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async executeWorker(runId: string, leaseId: string, input: { timeout_ms?: number; diff_max_lines?: number } = {}): Promise<ExecuteWorkerResult> {
    return this.request(`/loops/runs/${runId}/execute-worker`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, ...input }),
    });
  }

  async verifyLoopRun(runId: string): Promise<{ run: LoopRunRecord; gates: LoopGate[]; leases: WorkerLeaseRecord[] }> {
    return this.request(`/loops/runs/${runId}/verify`, { method: 'POST' });
  }

  async stepLoopRun(runId: string): Promise<{ run: LoopRunRecord; leases: WorkerLeaseRecord[]; decision: string; next_actions: string[] }> {
    return this.request(`/loops/runs/${runId}/step`, { method: 'POST' });
  }

  async retryLoopRun(runId: string, makerLeaseId: string, runtime: 'manual' | 'codex' | 'opencode' | 'mock' = 'manual'): Promise<{ run: LoopRunRecord; leases: WorkerLeaseRecord[]; retry_maker: WorkerLeaseRecord; retry_checker: WorkerLeaseRecord }> {
    return this.request(`/loops/runs/${runId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ maker_lease_id: makerLeaseId, runtime }),
    });
  }

  async splitLoopFinding(runId: string, input: { finding_id: string; reason: string; children: Array<{ message: string; suggested_fix: string }> }): Promise<{ run: LoopRunRecord; parent: LoopFinding; children: LoopFinding[]; leases: WorkerLeaseRecord[] }> {
    return this.request(`/loops/runs/${runId}/split`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async submitCheckerVerdict(runId: string, leaseId: string, verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence', notes?: string): Promise<{ run: LoopRunRecord; checker: WorkerLeaseRecord }> {
    return this.request(`/loops/runs/${runId}/checker-verdict`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, verdict, notes: notes || '' }),
    });
  }

  async submitSecurityVerdict(runId: string, leaseId: string, verdict: 'accepted' | 'needs_revision' | 'rejected' | 'insufficient_evidence', notes?: string): Promise<{ run: LoopRunRecord; security_checker: WorkerLeaseRecord }> {
    return this.request(`/loops/runs/${runId}/security-verdict`, {
      method: 'POST',
      body: JSON.stringify({ lease_id: leaseId, verdict, notes: notes || '' }),
    });
  }

  async completeLoopRun(runId: string): Promise<{ run: LoopRunRecord; gates: LoopGate[] }> {
    return this.request(`/loops/runs/${runId}/complete`, { method: 'POST' });
  }

  async stopLoopRun(runId: string): Promise<{ run: LoopRunRecord; events: LoopEventRecord[] }> {
    return this.request(`/loops/runs/${runId}/stop`, { method: 'POST' });
  }

  // Workstation swarm resources
  async getSwarmStatus(): Promise<SwarmRealityStatus> {
    return this.request('/swarms/status');
  }

  async runSchedulerTick(input: { max_items?: number; plan_triaged?: boolean } = {}): Promise<SchedulerTickResult> {
    return this.request('/swarms/scheduler/tick', {
      method: 'POST',
      body: JSON.stringify(input),
    });
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

  async getAssuranceSummary(): Promise<AgentAssuranceSummary> {
    return this.request('/swarms/assurance/summary');
  }

  async runAssuranceEval(input: {
    suite_name: string;
    target_type: 'memory' | 'skill' | 'swarm' | 'loop' | 'capability';
    target_ref?: string;
  }): Promise<AgentEvalRunRecord> {
    return this.request('/swarms/assurance/evals/run', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  // Repositories
  async getRepositories(): Promise<{ repositories: Repository[] }> {
    return this.request('/repositories');
  }

  async getRepository(id: string): Promise<{ repository: Repository }> {
    return this.request(`/repositories/${id}`);
  }

  async scanRepository(path: string): Promise<RepositoryScanResult> {
    return this.request('/repositories/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  async rescanRepository(id: string): Promise<RepositoryScanResult> {
    return this.request(`/repositories/${id}/rescan`, {
      method: 'POST',
    });
  }

  async getRepositoryHealth(id: string): Promise<{ health_score: number | null; findings: RepositoryHealthFinding[] }> {
    return this.request(`/repositories/${id}/health`);
  }

  async getRepositoryAgentsMd(id: string): Promise<{ files: any[]; issues: AgentsMdIssue[] }> {
    return this.request(`/repositories/${id}/agents-md`);
  }

  async getEffectiveInstructionStack(id: string, path?: string): Promise<any> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request(`/repositories/${id}/agents-md/effective${query}`);
  }

  async validateAgentsMd(id: string): Promise<{ issues: AgentsMdIssue[]; total: number; critical: number; errors: number; warnings: number }> {
    return this.request(`/repositories/${id}/agents-md/validate`, { method: 'POST' });
  }

  // Diffs
  async getTaskDiff(taskId: string): Promise<{ files: FileChange[]; summary: { totalFiles: number; totalAdditions: number; totalDeletions: number; truncated: boolean; redactedSecrets: number } }> {
    return this.request(`/tasks/${taskId}/diff`);
  }

  async getTaskSnapshots(taskId: string): Promise<{ snapshots: any[] }> {
    return this.request(`/tasks/${taskId}/snapshots`);
  }

  // Exports
  private async exportDownload(endpoint: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
    const url = `${API_BASE}${endpoint}`;
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ format, ...options }),
    });

    if (response.status === 401) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      window.location.href = '/login';
      throw new Error('Session expired');
    }
    if (response.status === 403) throw new Error('Access denied');
    if (response.status === 404) throw new Error('Not found');
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || error.error?.message || `Export failed: ${response.status}`);
    }

    const blob = await response.blob();
    const contentDisposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisposition.match(/filename="(.+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `export.${format}`;

    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  }

  async exportTask(taskId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
    return this.exportDownload(`/exports/task/${taskId}`, format, options);
  }

  async exportEvidence(taskId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
    return this.exportDownload(`/exports/evidence/${taskId}`, format, options);
  }

  async exportAudit(format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
    return this.exportDownload('/exports/audit', format, options);
  }

  async exportRepository(repositoryId: string, format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
    return this.exportDownload(`/exports/repository/${repositoryId}`, format, options);
  }

  async exportSummaryReport(format: ExportFormat, options?: Partial<ExportRequest>): Promise<void> {
    return this.exportDownload('/exports/report/summary', format, options);
  }
}

export const api = new ApiClient();
