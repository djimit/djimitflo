/**
 * API client for Djimitflo backend
 */

import type {
  Task,
  TaskCreateInput,
  TaskUpdateInput,
  Agent,
  MCPServer,
  MCPTool,
  ExecutionEvent,
  Approval,
  ApprovalDecision,
} from '@djimitflo/shared';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api';

class ApiClient {
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `API error: ${response.status}`);
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

  async executeTask(id: string, executor: 'mock' | 'opencode' = 'opencode'): Promise<{ message: string; task_id: string; executor: string }> {
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
  async getApprovals(taskId: string): Promise<{ approvals: Approval[] }> {
    return this.request(`/tasks/${taskId}/approvals`);
  }

  async approveRequest(approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    return this.request(`/approvals/${approvalId}`, {
      method: 'PATCH',
      body: JSON.stringify(decision),
    });
  }

  // Health
  async getHealth(): Promise<{ status: string; timestamp: string; uptime: number }> {
    const url = API_BASE.replace('/api', '/health');
    const response = await fetch(url);
    return response.json();
  }
}

export const api = new ApiClient();
