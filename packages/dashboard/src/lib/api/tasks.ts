/**
 * Tasks API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type { Task, TaskCreateInput, TaskUpdateInput } from '@djimitflo/shared';
interface FileChange { path: string; additions: number; deletions: number }


export const tasksApi = {
    async getTasks(params?: { status?: string; agent_id?: string }): Promise<{ tasks: Task[]; total: number }> {
      const query = new URLSearchParams(params as Record<string, string>);
      return request(`/tasks?${query}`);
    },
    async getTask(id: string): Promise<Task> {
      return request(`/tasks/${id}`);
    },
    async createTask(input: TaskCreateInput): Promise<Task> {
      return request('/tasks', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    async updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
      return request(`/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
    },
    async deleteTask(id: string): Promise<void> {
      return request(`/tasks/${id}`, {
        method: 'DELETE',
      });
    },
    async executeTask(id: string, executor: 'mock' | 'opencode' = 'opencode'): Promise<{ message: string; task_id: string; executor: string; status: string; approvalId?: string; reason?: string }> {
      return request(`/tasks/${id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ executor }),
      });
    },
    async cancelTask(id: string): Promise<{ message: string; task_id: string }> {
      return request(`/tasks/${id}/cancel`, {
        method: 'POST',
      });
    },
    async getTaskDiff(taskId: string): Promise<{ files: FileChange[]; summary: { totalFiles: number; totalAdditions: number; totalDeletions: number; truncated: boolean; redactedSecrets: number } }> {
      return request(`/tasks/${taskId}/diff`);
    },
    async getTaskSnapshots(taskId: string): Promise<{ snapshots: any[] }> {
      return request(`/tasks/${taskId}/snapshots`);
    }
};
