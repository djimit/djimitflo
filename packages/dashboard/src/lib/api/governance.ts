/**
 * Governance API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type * from "../api-client";

export const governanceApi = {
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
    async getMCPPermissions(filters?: { serverId?: string; riskLevel?: string; decision?: string; q?: string }): Promise<{ permissions: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (filters?.serverId) params.set('server_id', filters.serverId);
      if (filters?.riskLevel) params.set('risk_level', filters.riskLevel);
      if (filters?.decision) params.set('decision', filters.decision);
      if (filters?.q) params.set('q', filters.q);
      const query = params.toString() ? `?${params}` : '';
      return this.request(`/mcp/permissions${query}`);
    }
    async updateMCPPermission(toolId: string, input: Record<string, unknown>): Promise<{ permission: Record<string, unknown> }> {
      return this.request(`/mcp/permissions/${toolId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    }
};
