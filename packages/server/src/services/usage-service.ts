import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export class UsageService {
  constructor(private db: Database) {}

  getTokenUsage(params: {
    provider?: string;
    model?: string;
    agent_id?: string;
    from?: string;
    to?: string;
    group_by?: string;
  }) {
    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (params.provider) { conditions.push('provider = ?'); queryParams.push(params.provider); }
    if (params.model) { conditions.push('model = ?'); queryParams.push(params.model); }
    if (params.agent_id) { conditions.push('agent_id = ?'); queryParams.push(params.agent_id); }
    if (params.from) { conditions.push('timestamp >= ?'); queryParams.push(params.from); }
    if (params.to) { conditions.push('timestamp <= ?'); queryParams.push(params.to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = this.db.prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens, COALESCE(SUM(cost), 0) as total_cost FROM token_usage_log ${where}`
    ).get(...queryParams) as { total_tokens: number; total_cost: number };

    let breakdown: any[] = [];
    if (params.group_by === 'day') {
      breakdown = this.db.prepare(
        `SELECT date(timestamp) as date, SUM(prompt_tokens + completion_tokens) as tokens, SUM(cost) as cost FROM token_usage_log ${where} GROUP BY date(timestamp) ORDER BY date DESC LIMIT 30`
      ).all(...queryParams);
    } else if (params.group_by === 'provider') {
      breakdown = this.db.prepare(
        `SELECT provider, SUM(prompt_tokens + completion_tokens) as tokens, SUM(cost) as cost, COUNT(*) as requests FROM token_usage_log ${where} GROUP BY provider ORDER BY tokens DESC`
      ).all(...queryParams);
    } else if (params.group_by === 'model') {
      breakdown = this.db.prepare(
        `SELECT model, provider, SUM(prompt_tokens + completion_tokens) as tokens, SUM(cost) as cost FROM token_usage_log ${where} GROUP BY model, provider ORDER BY tokens DESC`
      ).all(...queryParams);
    }

    return { total_tokens: totalRow.total_tokens, total_cost: totalRow.total_cost, breakdown };
  }

  getCosts(params: { provider?: string; from?: string; to?: string }) {
    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (params.provider) { conditions.push('provider = ?'); queryParams.push(params.provider); }
    if (params.from) { conditions.push('timestamp >= ?'); queryParams.push(params.from); }
    if (params.to) { conditions.push('timestamp <= ?'); queryParams.push(params.to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = this.db.prepare(
      `SELECT COALESCE(SUM(cost), 0) as total_cost FROM token_usage_log ${where}`
    ).get(...queryParams) as { total_cost: number };

    const byProvider = this.db.prepare(
      `SELECT provider, SUM(cost) as cost, SUM(prompt_tokens + completion_tokens) as tokens FROM token_usage_log ${where} GROUP BY provider ORDER BY cost DESC`
    ).all(...queryParams);

    return { total_cost: totalRow.total_cost, by_provider: byProvider };
  }

  getQuotas() {
    const providers = this.db.prepare(
      'SELECT * FROM provider_configs WHERE is_active = 1 ORDER BY provider'
    ).all() as any[];

    return providers.map((p: any) => {
      const usage = this.db.prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN timestamp >= datetime('now', '-1 hour') THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as hourly,
          COALESCE(SUM(CASE WHEN timestamp >= datetime('now', '-1 day') THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as daily,
          COALESCE(SUM(CASE WHEN timestamp >= datetime('now', '-7 days') THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as weekly,
          COALESCE(SUM(CASE WHEN timestamp >= datetime('now', '-30 days') THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as monthly,
          COALESCE(SUM(cost), 0) as total_cost
        FROM token_usage_log WHERE provider = ?`,
      ).get(p.provider) as any;

      return {
        provider: p.provider,
        tier: p.subscription_tier,
        is_active: !!p.is_active,
        tokens_used_hourly: usage.hourly,
        tokens_used_daily: usage.daily,
        tokens_used_weekly: usage.weekly,
        tokens_used_monthly: usage.monthly,
        quota_hourly: p.token_quota_hourly,
        quota_daily: p.token_quota_daily,
        quota_weekly: p.token_quota_weekly,
        quota_monthly: p.token_quota_monthly,
        cost_total: usage.total_cost,
        cost_per_1k_prompt: p.cost_per_1k_prompt_tokens,
        cost_per_1k_completion: p.cost_per_1k_completion_tokens,
        rate_limit_rpm: p.rate_limit_rpm,
        rate_limit_rpd: p.rate_limit_rpd,
      };
    });
  }

  getAvailableModels() {
    const providers = this.db.prepare(
      'SELECT * FROM provider_configs WHERE is_active = 1 ORDER BY provider'
    ).all() as any[];

    return providers.map((p: any) => ({
      provider: p.provider,
      tier: p.subscription_tier,
      base_url: p.base_url,
      quota_hourly: p.token_quota_hourly,
      quota_daily: p.token_quota_daily,
      quota_weekly: p.token_quota_weekly,
      quota_monthly: p.token_quota_monthly,
      rate_limit_rpm: p.rate_limit_rpm,
      rate_limit_rpd: p.rate_limit_rpd,
      cost_per_1k_prompt: p.cost_per_1k_prompt_tokens,
      cost_per_1k_completion: p.cost_per_1k_completion_tokens,
    }));
  }

  getRecentLogs(limit: number = 20) {
    return this.db.prepare(
      'SELECT * FROM token_usage_log ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
  }

  logUsage(input: {
    task_id?: string;
    agent_id?: string;
    provider: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens?: number;
    cache_create_tokens?: number;
    cost: number;
    duration_ms?: number;
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO token_usage_log (id, task_id, discussion_id, agent_id, model, task_type, prompt_tokens, completion_tokens, total_tokens, cost_estimate, metadata, created_at, updated_at, provider, cache_read_tokens, cache_create_tokens, cost, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.task_id || null,
      null,
      input.agent_id || null,
      input.model,
      'task',
      input.prompt_tokens,
      input.completion_tokens,
      input.prompt_tokens + input.completion_tokens,
      input.cost,
      null,
      now,
      now,
      input.provider,
      input.cache_read_tokens || 0,
      input.cache_create_tokens || 0,
      input.cost,
      input.duration_ms || null,
      now
    );

    return id;
  }

  batchInsertLogs(logs: Array<{
    id: string;
    task_id?: string;
    agent_id?: string;
    model?: string;
    task_type?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    latency_ms?: number;
    created_at?: string;
  }>) {
    const stmt = this.db.prepare(`
      INSERT INTO token_usage_log (
        id, task_id, discussion_id, agent_id, model, task_type,
        prompt_tokens, completion_tokens, total_tokens,
        cost_estimate, metadata, created_at, updated_at,
        provider, cache_read_tokens, cache_create_tokens, cost, duration_ms, timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);

    let count = 0;
    const now = new Date().toISOString();

    const insert = this.db.transaction((items) => {
      for (const log of items) {
        try {
          stmt.run(
            log.id,
            null,
            null,  // discussion_id
            null,  // agent_id
            log.model || 'unknown',
            (log.task_type && log.task_type !== 'default') ? log.task_type : 'task',
            log.prompt_tokens || 0,
            log.completion_tokens || 0,
            log.total_tokens || 0,
            0.0,   // cost_estimate
            null,  // metadata
            log.created_at || now,
            now,   // updated_at
            (log.task_type && log.task_type !== 'default') ? log.task_type : 'swarm',  // provider
            0,     // cache_read_tokens
            0,     // cache_create_tokens
            0,     // cost
            log.latency_ms || null,    // duration_ms
            log.created_at || now,     // timestamp
          );
          count++;
        } catch (e) {
          console.error('Insert error:', e);
        }
      }
    });

    insert(logs);
    return count;
  }
}
