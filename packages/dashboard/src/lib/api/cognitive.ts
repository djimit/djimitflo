/**
 * Cognitive API client.
 * Extracted from api.ts (Task 5.3: ApiClient domain split)
 */
import { request } from "../api-client";

export const cognitiveApi = {
    async getCognitiveStats(): Promise<{
      totalEpisodes: number;
      totalPatterns: number;
      totalStrategies: number;
      overallSuccessRate: number;
      bestGoalType: string | null;
    }> {
      return request("/cognitive/stats");
    },
    async getCognitiveMetaLearning(): Promise<{ records: Array<{
      goalType: string;
      bestStrategy: string;
      bestSuccessRate: number;
      totalEpisodes: number;
      totalStrategies: number;
      lastUpdated: string;
    }> }> {
      return request("/cognitive/meta-learning");
    },
    async getBestStrategy(goalType: string): Promise<{
      id: string;
      name: string;
      description: string;
      goalType: string;
      successRate: number;
      episodeCount: number;
      avgDurationMs: number;
      avgCostDollars: number;
    } | null> {
      return request(`/cognitive/strategy/${encodeURIComponent(goalType)}`);
    },
    async getMemoryStats(): Promise<{
      total: number; active: number; candidates: number; archived: number;
      decayed: number; avgRelevance: number; totalRelations: number;
    }> {
      return request("/memory/stats");
    },
    async getComplianceStatus(): Promise<{
      totalAuditEntries: number; chainIntegrity: boolean;
      lastReportScore: number; lastReportStatus: string | null;
    }> {
      return request("/compliance/status");
    },
    async getMetaStats(): Promise<{
      totalDecisions: number; failuresPredicted: number; costSavingsDollars: number;
    }> {
      return request("/meta/stats");
    }
};
