/**
 * Repositories API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type * from "../api-client";

export const repositoriesApi = {
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
};
