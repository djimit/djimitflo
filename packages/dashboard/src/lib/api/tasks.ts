/**
 * Tasks API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type * from "../api-client";

export const tasksApi = {
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
    async getTaskDiff(taskId: string): Promise<{ files: FileChange[]; summary: { totalFiles: number; totalAdditions: number; totalDeletions: number; truncated: boolean; redactedSecrets: number } }> {
      return this.request(`/tasks/${taskId}/diff`);
    }
    async getTaskSnapshots(taskId: string): Promise<{ snapshots: any[] }> {
      return this.request(`/tasks/${taskId}/snapshots`);
    }
};
