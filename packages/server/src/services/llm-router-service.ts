/**
 * LlmRouterService — multi-provider LLM routing with intelligent failover.
 *
 * Based on Ruflo's multi-provider architecture (Claude, GPT, Gemini, Cohere, Ollama).
 * Routes LLM requests to optimal provider based on:
 * - Task type (coding, analysis, creative, etc.)
 * - Provider health and latency
 * - Cost optimization
 * - Capability matching
 * - Automatic failover on errors
 */

import type { Database } from 'better-sqlite3';

type LlmProvider = 'anthropic' | 'openai' | 'google' | 'ollama' | 'litellm';

interface ProviderConfig {
  name: LlmProvider;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  capabilities: string[];
  costPerMtok: number;
  avgLatencyMs: number;
  status: 'unknown' | 'active' | 'degraded' | 'offline';
  lastHealthCheck: string;
}

interface RoutingRequest {
  taskType: 'coding' | 'analysis' | 'creative' | 'reasoning' | 'chat' | 'embedding';
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  preferredProvider?: LlmProvider;
  /**
   * OpenMythos risk category (e.g. 'injection', 'hallucination'). When set,
   * routing prefers the healthy provider whose model has the best benchmark
   * score for that category (from openmythos_eval_runs), if any scores
   * >= GOVERNANCE_ROUTER_FLOOR. Otherwise static task routing applies.
   */
  riskCategory?: string;
}

interface RoutingDecision {
  provider: LlmProvider;
  model: string;
  reason: string;
  estimatedCost: number;
  estimatedLatencyMs: number;
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { name: 'anthropic', model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'creative'], costPerMtok: 3.0, avgLatencyMs: 2000, status: 'unknown', lastHealthCheck: '' },
  { name: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'chat', 'creative'], costPerMtok: 2.5, avgLatencyMs: 1500, status: 'unknown', lastHealthCheck: '' },
  { name: 'google', model: 'gemini-2.5-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1', apiKeyEnv: 'GOOGLE_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'creative'], costPerMtok: 1.25, avgLatencyMs: 1800, status: 'unknown', lastHealthCheck: '' },
  { name: 'ollama', model: 'qwen2.5:14b-instruct-q4_K_M', baseUrl: process.env.OLLAMA_URL || 'http://192.168.1.28:11434', apiKeyEnv: '', capabilities: ['coding', 'analysis', 'reasoning', 'chat'], costPerMtok: 0, avgLatencyMs: 3000, status: 'unknown', lastHealthCheck: '' },
  { name: 'litellm', model: 'workstation-litellm/coding', baseUrl: process.env.LITELLM_URL || 'http://192.168.1.28:4000/v1', apiKeyEnv: 'LITELLM_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'chat', 'creative', 'embedding'], costPerMtok: 1.0, avgLatencyMs: 1200, status: 'unknown', lastHealthCheck: '' },
];

export class LlmRouterService {
  private providers: Map<LlmProvider, ProviderConfig> = new Map();
  private taskRouting: Record<string, LlmProvider[]> = {
    coding: ['anthropic', 'litellm', 'openai', 'ollama'],
    analysis: ['litellm', 'anthropic', 'google', 'ollama'],
    reasoning: ['anthropic', 'google', 'litellm', 'ollama'],
    creative: ['openai', 'anthropic', 'google', 'litellm'],
    chat: ['litellm', 'ollama', 'openai', 'anthropic'],
    embedding: ['litellm', 'openai', 'ollama'],
  };

  constructor(private db: Database) {
    for (const provider of DEFAULT_PROVIDERS) {
      this.providers.set(provider.name, { ...provider });
    }
    this.ensureTables();
  }

  /**
   * Route a request to the optimal provider.
   * When cascadeHint is set, skip static mapping and use the suggested model.
   */
  route(request: RoutingRequest, cascadeHint?: { modelId: string; escalationLevel: number }): RoutingDecision {
    // Cascade hint: use model suggested by MultiModelIntelligence cascade
    if (cascadeHint?.modelId) {
      const provider = this.findProviderByModelId(cascadeHint.modelId);
      if (provider?.status === 'active') {
        return {
          provider: provider.name,
          model: provider.model,
          reason: `Cascade L${cascadeHint.escalationLevel}: ${cascadeHint.modelId}`,
          estimatedCost: (request.maxTokens || 4096) / 1_000_000 * provider.costPerMtok,
          estimatedLatencyMs: provider.avgLatencyMs,
        };
      }
    }

    const candidates = request.preferredProvider
      ? [request.preferredProvider]
      : this.taskRouting[request.taskType] || ['litellm'];

    // Governance override: benchmark evidence beats static preference order.
    if (request.riskCategory) {
      const governed = this.pickByGovernance(request, candidates);
      if (governed) return governed;
    }

    // Find first healthy candidate
    for (const providerName of candidates) {
      const provider = this.providers.get(providerName);
      if (!provider || provider.status !== 'active') continue;

      // Check if API key is available (skip for Ollama)
      if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) continue;

      return {
        provider: provider.name,
        model: provider.model,
        reason: `Selected ${provider.name} for ${request.taskType} (${provider.status}; measured latency: ${provider.avgLatencyMs}ms, cost: $${provider.costPerMtok}/Mtok)`,
        estimatedCost: (request.maxTokens || 4096) / 1_000_000 * provider.costPerMtok,
        estimatedLatencyMs: provider.avgLatencyMs,
      };
    }

    throw new Error('LLM_PROVIDER_UNAVAILABLE');
  }

  /**
   * Record provider performance for learning.
   */
  recordPerformance(input: {
    provider: LlmProvider;
    taskType: string;
    latencyMs: number;
    success: boolean;
    costDollars?: number;
  }): void {
    const provider = this.providers.get(input.provider);
    if (!provider) return;

    // Update rolling average latency
    const alpha = 0.3;
    provider.avgLatencyMs = Math.round(provider.avgLatencyMs * (1 - alpha) + input.latencyMs * alpha);

    // Update status based on success
    if (!input.success) {
      provider.status = 'degraded';
    } else if (provider.status !== 'active') {
      provider.status = 'active';
    }

    provider.lastHealthCheck = new Date().toISOString();

    // Store metrics
    this.db.prepare(`
      INSERT INTO llm_provider_metrics (id, provider, task_type, latency_ms, success, cost_dollars, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${input.provider}-${Date.now()}`,
      input.provider,
      input.taskType,
      input.latencyMs,
      input.success ? 1 : 0,
      input.costDollars || 0,
      new Date().toISOString()
    );
  }

  /**
   * Get provider health status.
   */
  getProviderHealth(): Array<ProviderConfig & { available: boolean }> {
    return Array.from(this.providers.values()).map((provider) => ({
      ...provider,
      available: provider.status === 'active' && (!provider.apiKeyEnv || !!process.env[provider.apiKeyEnv]),
    }));
  }

  async refreshProviderHealth(): Promise<Array<ProviderConfig & { available: boolean }>> {
    await Promise.all(Array.from(this.providers.values()).map(async (provider) => {
      const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
      if (provider.apiKeyEnv && !apiKey) {
        provider.status = 'offline';
        provider.lastHealthCheck = new Date().toISOString();
        return;
      }
      const paths: Record<LlmProvider, string> = {
        anthropic: '/models', openai: '/models', google: '/models', ollama: '/api/tags', litellm: '/models',
      };
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (provider.name === 'anthropic' && apiKey) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
      let url = `${provider.baseUrl.replace(/\/$/, '')}${paths[provider.name]}`;
      if (provider.name === 'google' && apiKey) url += `?key=${encodeURIComponent(apiKey)}`;
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
        provider.status = response.ok ? 'active' : 'degraded';
      } catch {
        provider.status = 'offline';
      }
      provider.lastHealthCheck = new Date().toISOString();
    }));
    return this.getProviderHealth();
  }

  /**
   * Get routing statistics.
   */
  getStats(): {
    totalProviders: number;
    activeProviders: number;
    totalRequests: number;
    avgLatencyMs: number;
  } {
    const metrics = this.db.prepare('SELECT COUNT(*) as c, AVG(latency_ms) as avg_latency FROM llm_provider_metrics').get() as any;
    const active = Array.from(this.providers.values()).filter((p) => p.status === 'active').length;

    return {
      totalProviders: this.providers.size,
      activeProviders: active,
      totalRequests: metrics?.c || 0,
      avgLatencyMs: Math.round(metrics?.avg_latency || 0),
    };
  }

  /**
   * Pick the healthy candidate whose model has the best OpenMythos score for
   * the requested risk category, if any healthy candidate is scored at or
   * above the floor. Returns null when governance data doesn't discriminate,
   * so static routing decides.
   */
  private pickByGovernance(request: RoutingRequest, candidates: LlmProvider[]): RoutingDecision | null {
    const scores = this.governanceScores(request.riskCategory!);
    if (scores.size === 0) return null;

    const floor = Number(process.env.GOVERNANCE_ROUTER_FLOOR ?? '3');
    let best: { provider: ProviderConfig; score: number } | null = null;
    for (const providerName of candidates) {
      const provider = this.providers.get(providerName);
      if (!provider || provider.status !== 'active') continue;
      if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) continue;
      const score = scores.get(provider.model);
      if (score === undefined || score < floor) continue;
      if (!best || score > best.score) best = { provider, score };
    }
    if (!best) return null;

    return {
      provider: best.provider.name,
      model: best.provider.model,
      reason: `Governance: ${best.provider.model} scored ${best.score.toFixed(2)}/5 on '${request.riskCategory}' (OpenMythos benchmark)`,
      estimatedCost: (request.maxTokens || 4096) / 1_000_000 * best.provider.costPerMtok,
      estimatedLatencyMs: best.provider.avgLatencyMs,
    };
  }

  /**
   * Latest OpenMythos category score per subject model, from completed eval runs.
   */
  private governanceScores(category: string): Map<string, number> {
    const scores = new Map<string, number>();
    let rows: Array<{ metadata: string }>;
    try {
      rows = this.db.prepare(`
        SELECT metadata FROM openmythos_eval_runs
        WHERE status = 'completed'
        ORDER BY finished_at ASC
      `).all() as Array<{ metadata: string }>;
    } catch {
      return scores; // isolated consumers without the eval table
    }
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata || '{}') as { subject_model?: string; category_scores?: Record<string, number> };
        const score = metadata.category_scores?.[category];
        if (metadata.subject_model && typeof score === 'number') {
          scores.set(metadata.subject_model, score); // ascending order → latest run wins
        }
      } catch { /* skip malformed rows */ }
    }
    return scores;
  }

  private findProviderByModelId(modelId: string): ProviderConfig | undefined {
    for (const provider of this.providers.values()) {
      if (provider.model === modelId || provider.name === modelId) return provider;
    }
    return undefined;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_provider_metrics (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        task_type TEXT NOT NULL,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        cost_dollars REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_llm_metrics_provider ON llm_provider_metrics(provider);
      CREATE INDEX IF NOT EXISTS idx_llm_metrics_created_at ON llm_provider_metrics(created_at);
    `);
  }
}
