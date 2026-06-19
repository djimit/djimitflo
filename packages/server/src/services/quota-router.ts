import type { Database } from 'better-sqlite3';
// import { randomUUID } from 'crypto';

export class QuotaRouter {
  constructor(private db: Database) {}

  selectProvider(task: { complexity: number; preferredProvider?: string }): {
    provider: string;
    model: string;
    remaining_quota_hourly: number | null;
    remaining_quota_daily: number | null;
    fallback_used: boolean;
    reason: string;
  } {
    const priorityOrder = [
      'ollama-cloud',
      'litellm',
      'anthropic',
      'opencode-zen',
      'opencode-go',
      'local',
    ];

    if (task.preferredProvider) {
      const idx = priorityOrder.indexOf(task.preferredProvider);
      if (idx > 0) {
        priorityOrder.splice(idx, 1);
        priorityOrder.unshift(task.preferredProvider);
      }
    }

    const tierModels: Record<number, Record<string, string>> = {
      1: { 'ollama-cloud': 'qwen3-coder:480b', 'litellm': 'qwen3-coder:480b', 'anthropic': 'claude-sonnet-4-6', 'opencode-zen': 'gpt-5.5', 'opencode-go': 'kimi-k2.6' },
      2: { 'ollama-cloud': 'deepseek-v4-flash', 'litellm': 'deepseek-v4-flash', 'anthropic': 'claude-sonnet-4-6', 'opencode-zen': 'claude-sonnet-4-6', 'opencode-go': 'glm-5.1' },
      3: { 'local': 'qwen2.5-coder-7b' },
    };

    const tier = task.complexity <= 3 ? 3 : task.complexity <= 6 ? 2 : 1;
    const models = tierModels[tier] || tierModels[2];

    for (const provider of priorityOrder) {
      const model = models[provider];
      if (!model) continue;

      const config = this.db.prepare(
        'SELECT * FROM provider_configs WHERE provider = ? AND is_active = 1'
      ).get(provider) as any;

      if (!config) continue;

      const usage = this.db.prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as hourly,
          COALESCE(SUM(CASE WHEN timestamp >= datetime('now', '-1 day') THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as daily
        FROM token_usage_log WHERE provider = ?`
      ).get(provider) as any;

      const hourlyPct = config.token_quota_hourly ? (usage.hourly / config.token_quota_hourly) * 100 : 0;
      const dailyPct = config.token_quota_daily ? (usage.daily / config.token_quota_daily) * 100 : 0;

      if (hourlyPct >= 80 || dailyPct >= 80) continue;

      return {
        provider,
        model,
        remaining_quota_hourly: config.token_quota_hourly ? config.token_quota_hourly - usage.hourly : null,
        remaining_quota_daily: config.token_quota_daily ? config.token_quota_daily - usage.daily : null,
        fallback_used: provider !== priorityOrder[0],
        reason: provider === priorityOrder[0]
          ? 'Primary provider selected'
          : `Fallback from ${priorityOrder[0]} (quota exceeded or unavailable)`,
      };
    }

    return {
      provider: 'local',
      model: 'qwen2.5-coder-7b',
      remaining_quota_hourly: null,
      remaining_quota_daily: null,
      fallback_used: true,
      reason: 'All cloud providers exhausted, using local fallback',
    };
  }
}
