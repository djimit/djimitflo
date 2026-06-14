import type BetterSqlite3 from 'better-sqlite3';
export function createPhase56Tables(db: BetterSqlite3.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      api_key_encrypted TEXT,
      base_url TEXT,
      subscription_tier TEXT NOT NULL DEFAULT 'free',
      token_quota_hourly INTEGER,
      token_quota_daily INTEGER,
      token_quota_weekly INTEGER,
      token_quota_monthly INTEGER,
      rate_limit_rpm INTEGER,
      rate_limit_rpd INTEGER,
      cost_per_1k_prompt_tokens REAL,
      cost_per_1k_completion_tokens REAL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_configs_provider ON provider_configs(provider);

    CREATE TABLE IF NOT EXISTS token_usage_log (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage_log(agent_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage_log(provider);
    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage_log(timestamp);
  `);

  const { randomUUID } = require('crypto');
  const now = new Date().toISOString();

  const providers = [
    { provider: 'ollama-cloud', tier: 'beta', hourly: null, daily: null, weekly: null, monthly: null, rpm: null, rpd: null, cost_prompt: null, cost_completion: null, base_url: 'https://ollama.com/v1' },
    { provider: 'litellm', tier: 'internal', hourly: null, daily: null, weekly: null, monthly: null, rpm: null, rpd: null, cost_prompt: null, cost_completion: null, base_url: 'http://127.0.0.1:4000/v1' },
    { provider: 'anthropic', tier: 'pay-as-you-go', hourly: null, daily: 2000000, weekly: null, monthly: null, rpm: 50, rpd: 1000, cost_prompt: 3.0, cost_completion: 15.0, base_url: 'https://api.anthropic.com/v1' },
    { provider: 'opencode-zen', tier: 'pay-as-you-go', hourly: null, daily: null, weekly: null, monthly: null, rpm: null, rpd: null, cost_prompt: null, cost_completion: null, base_url: 'https://opencode.ai/zen/v1' },
    { provider: 'opencode-go', tier: 'pro', hourly: null, daily: null, weekly: null, monthly: 10000000, rpm: null, rpd: null, cost_prompt: null, cost_completion: null, base_url: 'https://opencode.ai/zen/go/v1' },
    { provider: 'local', tier: 'free', hourly: null, daily: null, weekly: null, monthly: null, rpm: null, rpd: null, cost_prompt: 0, cost_completion: 0, base_url: 'http://127.0.0.1:11434/v1' },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO provider_configs (id, provider, base_url, subscription_tier, token_quota_hourly, token_quota_daily, token_quota_weekly, token_quota_monthly, rate_limit_rpm, rate_limit_rpd, cost_per_1k_prompt_tokens, cost_per_1k_completion_tokens, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  for (const p of providers) {
    insert.run(randomUUID(), p.provider, p.base_url, p.tier, p.hourly, p.daily, p.weekly, p.monthly, p.rpm, p.rpd, p.cost_prompt, p.cost_completion, now, now);
  }
}
