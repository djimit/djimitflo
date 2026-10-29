/**
 * LlmRouterService — multi-provider LLM routing with Thompson Sampling.
 *
 * Replaces the v1 heuristic softmax with a Bayesian Multi-Armed Bandit (MAB)
 * approach that provides:
 * - Provably sublinear regret: O(sqrt(K*T*ln T))
 * - Natural exploration/exploit via posterior sampling
 * - Bayesian confidence tracking per provider
 * - Literature-backed EWMA (alpha=0.1 for latency)
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
}

interface RoutingDecision {
  available: true;
  provider: LlmProvider;
  model: string;
  reason: string;
  estimatedCost: number;
  estimatedLatencyMs: number;
  wasExploration?: boolean;
  posteriorScope?: PosteriorScope;
}

interface RoutingUnavailable {
  available: false;
  taskType: string;
  reason: string;
}

// ponytail: the Beta posterior lives in memory only and resets on restart, while
// llm_provider_metrics persists. Ceiling: nothing but the advisory
// /api/apex/llm/* routes reads this router (no runtime/maker decision consumer),
// so the posterior is labelled session-only instead of being persisted.
// Upgrade trigger: the first runtime/maker caller of route() — then rebuild the
// posterior at startup from persisted outcomes keyed by provider+model (add a
// model column) so a model change does not inherit prior evidence.
type PosteriorScope = 'session-only';
const POSTERIOR_SCOPE: PosteriorScope = 'session-only';

interface BanditArm {
  id: string;
  provider: LlmProvider;
  model: string;
  alpha: number;
  beta: number;
  latencyEwma: number;
  costPerToken: number;
}

interface BanditStats {
  id: string;
  meanSuccess: number;
  ci95: [number, number];
  nObservations: number;
  posteriorScope: PosteriorScope;
}

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { name: 'anthropic', model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'creative'], costPerMtok: 3.0, avgLatencyMs: 2000, status: 'unknown', lastHealthCheck: '' },
  { name: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'chat', 'creative'], costPerMtok: 2.5, avgLatencyMs: 1500, status: 'unknown', lastHealthCheck: '' },
  { name: 'google', model: 'gemini-2.5-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1', apiKeyEnv: 'GOOGLE_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'creative'], costPerMtok: 1.25, avgLatencyMs: 1800, status: 'unknown', lastHealthCheck: '' },
  { name: 'ollama', model: 'qwen2.5:14b-instruct-q4_K_M', baseUrl: process.env.OLLAMA_URL || 'http://192.168.1.28:11434', apiKeyEnv: '', capabilities: ['coding', 'analysis', 'reasoning', 'chat'], costPerMtok: 0, avgLatencyMs: 3000, status: 'unknown', lastHealthCheck: '' },
  { name: 'litellm', model: 'workstation-litellm/coding', baseUrl: process.env.LITELLM_URL || 'http://192.168.1.28:4000/v1', apiKeyEnv: 'LITELLM_API_KEY', capabilities: ['coding', 'analysis', 'reasoning', 'chat', 'creative', 'embedding'], costPerMtok: 1.0, avgLatencyMs: 1200, status: 'unknown', lastHealthCheck: '' },
];

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do { x = gaussianRandom(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function gaussianRandom(): number {
  return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

export class LlmRouterService {
  private providers: Map<LlmProvider, ProviderConfig> = new Map();
  private arms: BanditArm[] = [];
  private totalRounds = 0;  private metricCounter = 0;
  private explorationCount = 0;
  private readonly latencyAlpha = 0.1;

  constructor(private db: Database) {
    for (const provider of DEFAULT_PROVIDERS) {
      this.providers.set(provider.name, { ...provider });
      this.arms.push({ id: provider.name, provider: provider.name, model: provider.model, alpha: 1, beta: 1, latencyEwma: provider.avgLatencyMs, costPerToken: provider.costPerMtok / 1_000_000 });
    }
    this.ensureTables();
  }

  /** The single eligibility predicate: healthy AND credentialed AND declares the task capability. */
  private isEligible(provider: ProviderConfig | undefined, taskType: string): provider is ProviderConfig {
    return !!provider
      && provider.status === 'active'
      && (!provider.apiKeyEnv || !!process.env[provider.apiKeyEnv])
      && provider.capabilities.includes(taskType);
  }

  route(request: RoutingRequest, cascadeHint?: { modelId: string; escalationLevel: number }): RoutingDecision | RoutingUnavailable {
    if (cascadeHint?.modelId) {
      const provider = this.findProviderByModelId(cascadeHint.modelId);
      if (this.isEligible(provider, request.taskType)) {
        return { available: true, provider: provider.name, model: provider.model, reason: 'Cascade L' + cascadeHint.escalationLevel + ': ' + cascadeHint.modelId, estimatedCost: (request.maxTokens || 4096) / 1_000_000 * provider.costPerMtok, estimatedLatencyMs: provider.avgLatencyMs };
      }
    }
    const result = this.selectThompson(request.taskType, request.preferredProvider);
    if (!result) {
      return { available: false, taskType: request.taskType, reason: 'No eligible provider (healthy, credentialed, capable of ' + request.taskType + ')' + (request.preferredProvider ? ' among preferred ' + request.preferredProvider : '') };
    }
    this.totalRounds++;
    if (result.wasExploration) this.explorationCount++;
    return { available: true, provider: result.arm.provider, model: result.arm.model, reason: 'Thompson Sampling (round=' + this.totalRounds + ', exploration=' + result.wasExploration + ')', estimatedCost: (request.maxTokens || 4096) * result.arm.costPerToken, estimatedLatencyMs: result.arm.latencyEwma, wasExploration: result.wasExploration, posteriorScope: POSTERIOR_SCOPE };
  }

  private selectThompson(taskType: string, preferredProvider?: LlmProvider): { arm: BanditArm; wasExploration: boolean } | null {
    const eligibleArms = this.arms.filter(a => (!preferredProvider || a.provider === preferredProvider) && this.isEligible(this.providers.get(a.provider), taskType));
    if (eligibleArms.length === 0) return null;
    const empiricalBest = eligibleArms.reduce((best, arm) => (arm.alpha / (arm.alpha + arm.beta)) > (best.alpha / (best.alpha + best.beta)) ? arm : best);
    const samples = eligibleArms.map(arm => {
      const posteriorSample = sampleBeta(arm.alpha, arm.beta);
      const latencyPenalty = 1 / (1 + arm.latencyEwma / 1000) * 0.1;
      return { arm, sample: posteriorSample + latencyPenalty };
    });
    const selected = samples.reduce((best, s) => s.sample > best.sample ? s : best);
    return { arm: selected.arm, wasExploration: selected.arm.id !== empiricalBest.id };
  }

  recordPerformance(input: { provider: LlmProvider; taskType: string; latencyMs: number; success: boolean; costDollars?: number }): void {
    const provider = this.providers.get(input.provider);
    if (!provider) return;
    const arm = this.arms.find(a => a.id === input.provider);
    if (arm) {
      if (input.success) { arm.alpha += 1; } else { arm.beta += 1; }
      arm.latencyEwma = arm.latencyEwma * (1 - this.latencyAlpha) + input.latencyMs * this.latencyAlpha;
    }
    provider.status = input.success ? 'active' : 'degraded';
    provider.lastHealthCheck = new Date().toISOString();
    this.db.prepare('INSERT INTO llm_provider_metrics (id, provider, task_type, latency_ms, success, cost_dollars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(input.provider + '-' + Date.now() + '-' + (++this.metricCounter), input.provider, input.taskType, input.latencyMs, input.success ? 1 : 0, input.costDollars || 0, new Date().toISOString());
  }

  getBanditStats(): BanditStats[] {
    return this.arms.map(arm => {
      const mean = arm.alpha / (arm.alpha + arm.beta);
      const n = Math.max(0, arm.alpha + arm.beta - 2);
      if (n === 0) return { id: arm.id, meanSuccess: Math.round(mean * 1000) / 1000, ci95: [0, 1], nObservations: 0, posteriorScope: POSTERIOR_SCOPE };
      const z = 1.96;
      const denominator = 1 + z * z / n;
      const centre = (mean + z * z / (2 * n)) / denominator;
      const width = (z * Math.sqrt(mean * (1 - mean) / n + z * z / (4 * n * n))) / denominator;
      return { id: arm.id, meanSuccess: Math.round(mean * 1000) / 1000, ci95: [Math.max(0, Math.round((centre - width) * 1000) / 1000), Math.min(1, Math.round((centre + width) * 1000) / 1000)], nObservations: n, posteriorScope: POSTERIOR_SCOPE };
    });
  }

  getProviderHealth(): Array<ProviderConfig & { available: boolean }> {
    return Array.from(this.providers.values()).map(p => ({ ...p, available: p.status === 'active' && (!p.apiKeyEnv || !!process.env[p.apiKeyEnv]) }));
  }

  async refreshProviderHealth(): Promise<Array<ProviderConfig & { available: boolean }>> {
    await Promise.all(Array.from(this.providers.values()).map(async (provider) => {
      const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
      if (provider.apiKeyEnv && !apiKey) { provider.status = 'offline'; provider.lastHealthCheck = new Date().toISOString(); return; }
      const paths: Record<LlmProvider, string> = { anthropic: '/models', openai: '/models', google: '/models', ollama: '/api/tags', litellm: '/models' };
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      if (provider.name === 'anthropic' && apiKey) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
      let url = provider.baseUrl.replace(/\/$/, '') + paths[provider.name];
      if (provider.name === 'google' && apiKey) url += '?key=' + encodeURIComponent(apiKey);
      try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }); provider.status = response.ok ? 'active' : 'degraded'; } catch { provider.status = 'offline'; }
      provider.lastHealthCheck = new Date().toISOString();
    }));
    return this.getProviderHealth();
  }

  getStats(): { totalProviders: number; activeProviders: number; totalRequests: number; avgLatencyMs: number; explorationRate: number; posteriorScope: PosteriorScope } {
    const metrics = this.db.prepare('SELECT COUNT(*) as c, AVG(latency_ms) as avg_latency FROM llm_provider_metrics').get() as any;
    const active = Array.from(this.providers.values()).filter(p => p.status === 'active').length;
    return { totalProviders: this.providers.size, activeProviders: active, totalRequests: metrics?.c || 0, avgLatencyMs: Math.round(metrics?.avg_latency || 0), explorationRate: this.totalRounds > 0 ? Math.round(this.explorationCount / this.totalRounds * 1000) / 1000 : 0, posteriorScope: POSTERIOR_SCOPE };
  }

  private findProviderByModelId(modelId: string): ProviderConfig | undefined {
    for (const provider of this.providers.values()) { if (provider.model === modelId || provider.name === modelId) return provider; }
    return undefined;
  }

  private ensureTables(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS llm_provider_metrics (id TEXT PRIMARY KEY, provider TEXT NOT NULL, task_type TEXT NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, cost_dollars REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_llm_metrics_provider ON llm_provider_metrics(provider); CREATE INDEX IF NOT EXISTS idx_llm_metrics_created_at ON llm_provider_metrics(created_at);");
  }
}
