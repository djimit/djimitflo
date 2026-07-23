/**
 * Governance API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type { ApprovalRequest, ApprovalPolicy, ExecutionPolicy, RiskAssessment, Approval, ApprovalDecision } from '@djimitflo/shared';
interface Task { id: string; title: string; status: string }


export const governanceApi = {
    async getApprovals(taskId: string): Promise<{ approvals: ApprovalRequest[] }> {
      return request(`/tasks/${taskId}/approvals`);
    },
    async getAllApprovals(status?: string): Promise<{ approvals: ApprovalRequest[] }> {
      const query = status ? `?status=${status}` : '';
      return request(`/approvals${query}`);
    },
    async getApproval(approvalId: string): Promise<ApprovalRequest> {
      return request(`/approvals/${approvalId}`);
    },
    async approveRequest(approvalId: string, decision: ApprovalDecision): Promise<Approval> {
      return request(`/approvals/${approvalId}`, {
        method: 'PATCH',
        body: JSON.stringify(decision),
      });
    },
    async approveRequestExplicit(approvalId: string, reason?: string): Promise<ApprovalRequest> {
      return request(`/approvals/${approvalId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },
    async denyRequestExplicit(approvalId: string, reason: string): Promise<ApprovalRequest> {
      return request(`/approvals/${approvalId}/deny`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    },
    async getPolicies(): Promise<{ policies: ExecutionPolicy[] }> {
      return request('/policies');
    },
    async createPolicy(input: Partial<ApprovalPolicy>): Promise<ExecutionPolicy> {
      return request('/policies', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    async updatePolicy(id: string, input: Partial<ApprovalPolicy>): Promise<ExecutionPolicy> {
      return request(`/policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },
    async assessCommand(command: string, workspacePath?: string): Promise<{ assessment: RiskAssessment }> {
      return request('/risk/command', {
        method: 'POST',
        body: JSON.stringify({ command, workspacePath }),
      });
    },
    async assessTask(task: Task, executorKind = 'opencode'): Promise<{ assessment: RiskAssessment }> {
      return request('/risk/task', {
        method: 'POST',
        body: JSON.stringify({ task, executorKind }),
      });
    },
    async getMCPPermissions(filters?: { serverId?: string; riskLevel?: string; decision?: string; q?: string }): Promise<{ permissions: Array<Record<string, unknown>> }> {
      const params = new URLSearchParams();
      if (filters?.serverId) params.set('server_id', filters.serverId);
      if (filters?.riskLevel) params.set('risk_level', filters.riskLevel);
      if (filters?.decision) params.set('decision', filters.decision);
      if (filters?.q) params.set('q', filters.q);
      const query = params.toString() ? `?${params}` : '';
      return request(`/mcp/permissions${query}`);
    },
    async updateMCPPermission(toolId: string, input: Record<string, unknown>): Promise<{ permission: Record<string, unknown> }> {
      return request(`/mcp/permissions/${toolId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    }
};
