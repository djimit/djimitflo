/**
 * Evidence API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";
import type { ExecutionEvidence, ExecutionSummary, FileChange, ObservabilityMetrics, AuditTrailEntry } from '@djimitflo/shared';
// Local types (defined in original api.ts)
export interface UsageQuota { provider: string; tier: string; is_active: boolean; tokens_used_hourly: number; tokens_used_daily: number; tokens_used_weekly: number; tokens_used_monthly: number; quota_hourly: number | null; quota_daily: number | null; quota_weekly: number | null; quota_monthly: number | null; cost_total: number; cost_per_1k_prompt: number | null; cost_per_1k_completion: number | null }
export interface UsageBreakdown { by_hour: Array<{ hour: string; tokens: number; cost: number }>; by_day: Array<{ date: string; tokens: number; cost: number }> }
export interface UsageLog { id: string; timestamp: string; model: string; tokens: number; cost: number }
export interface Task { id: string; title: string; status: string }


export const evidenceApi = {
    async getTaskEvidence(taskId: string, filters?: { evidence_type?: string; severity?: string }): Promise<{ evidence: ExecutionEvidence[] }> {
      const params = new URLSearchParams();
      if (filters?.evidence_type) params.set('evidence_type', filters.evidence_type);
      if (filters?.severity) params.set('severity', filters.severity);
      const query = params.toString() ? `?${params.toString()}` : '';
      return request(`/evidence/task/${taskId}${query}`);
    },
    async getExecutionSummary(taskId: string): Promise<{ summary: ExecutionSummary | null }> {
      return request(`/evidence/summary/${taskId}`);
    },
    async getFileChanges(taskId: string): Promise<{ file_changes: FileChange[] }> {
      return request(`/evidence/file-changes/${taskId}`);
    },
    async getAuditTrail(taskId: string): Promise<{ trail: AuditTrailEntry[] }> {
      return request(`/evidence/audit-trail/${taskId}`);
    },
    async getExecutionReview(taskId: string): Promise<{
      task: Task;
      summary: ExecutionSummary | null;
      evidence: ExecutionEvidence[];
      file_changes: FileChange[];
      audit_trail: AuditTrailEntry[];
    }> {
      return request(`/evidence/review/${taskId}`);
    },
    async getObservabilityMetrics(): Promise<ObservabilityMetrics> {
      return request('/observability/metrics');
    },
    async getRiskTrends(days?: number): Promise<{ trends: Array<{ date: string; risk_level: string; count: number }> }> {
      const query = days ? `?days=${days}` : '';
      return request(`/observability/risk-trends${query}`);
    },
    async getPolicyStats(): Promise<{
      policies: Array<Record<string, unknown>>;
      decision_counts: Array<Record<string, unknown>>;
      recent_denials: Array<Record<string, unknown>>;
    }> {
      return request('/observability/policy-stats');
    },
    async getExecutionActivity(hours?: number): Promise<{
      activity: Array<Record<string, unknown>>;
      recent_tasks: Array<Record<string, unknown>>;
    }> {
      const query = hours ? `?hours=${hours}` : '';
      return request(`/observability/execution-activity${query}`);
    },
    async getUsageQuotas(): Promise<{ quotas: UsageQuota[] }> {
      return request('/usage/quotas');
    },
    async getUsageTokens(params?: { group_by?: 'hour' | 'day'; days?: number }): Promise<{
      total_tokens: number;
      total_cost: number;
      breakdown: UsageBreakdown[];
    }> {
      const query = new URLSearchParams();
      if (params?.group_by) query.set('group_by', params.group_by);
      if (params?.days) query.set('days', String(params.days));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return request(`/usage/tokens${suffix}`);
    },
    async getUsageRecent(limit?: number): Promise<{ logs: UsageLog[] }> {
      const query = limit ? `?limit=${limit}` : '';
      return request(`/usage/recent${query}`);
    }
};
