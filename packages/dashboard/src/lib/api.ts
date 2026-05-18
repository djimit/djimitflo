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

const AUTH_TOKEN_KEY = 'djimitflo_auth_token';

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem(AUTH_TOKEN_KEY);
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
      localStorage.removeItem(AUTH_TOKEN_KEY);
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
      localStorage.removeItem(AUTH_TOKEN_KEY);
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
