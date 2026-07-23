/**
 * Agents API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type { Agent, MCPServer, MCPTool, ExecutionEvent } from '@djimitflo/shared';


export const agentsApi = {
    async getAgents(): Promise<{ agents: Agent[] }> {
      return request('/agents');
    },
    async getAgent(id: string): Promise<Agent> {
      return request(`/agents/${id}`);
    },
    async getMCPServers(): Promise<{ servers: MCPServer[] }> {
      return request('/mcp/servers?refresh=true');
    },
    async getMCPTools(filters?: { serverId?: string; riskLevel?: string; permission?: string; q?: string }): Promise<{ tools: MCPTool[] }> {
      const params = new URLSearchParams();
      if (filters?.serverId) params.set('server_id', filters.serverId);
      if (filters?.riskLevel) params.set('risk_level', filters.riskLevel);
      if (filters?.permission) params.set('permission', filters.permission);
      if (filters?.q) params.set('q', filters.q);
      const query = params.toString() ? `?${params}` : '';
      return request(`/mcp/tools${query}`);
    },
    async getExecutionEvents(taskId: string): Promise<{ events: ExecutionEvent[] }> {
      return request(`/tasks/${taskId}/events`);
    }
};
