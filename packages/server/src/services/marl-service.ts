import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AgentPolicy {
  agentId: string;
  policy: Record<string, number>;
  reward: number;
  updatedAt: string;
}

export interface RewardSignal {
  fromAgent: string;
  toAgent: string;
  reward: number;
  reason: string;
  timestamp: string;
}

interface PolicyRow {
  agent_id: string;
  policy_json: string;
  reward: number;
  updated_at: string;
}

interface RewardRow {
  id: string;
  from_agent: string;
  to_agent: string;
  reward: number;
  reason: string;
  created_at: string;
}

export class MARLService {
  private learningRate = 0.1;
  private discountFactor = 0.95;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS marl_policies (
        agent_id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL DEFAULT '{}',
        reward REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_rewards (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        reward REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  updatePolicy(agentId: string, action: string, reward: number): AgentPolicy {
    const existing = this.db.prepare('SELECT * FROM marl_policies WHERE agent_id = ?').get(agentId) as PolicyRow | undefined;

    const policy = existing ? JSON.parse(existing.policy_json) as Record<string, number> : {};
    const currentValue = policy[action] ?? 0.5;
    const newValue = currentValue + this.learningRate * (reward + this.discountFactor * currentValue - currentValue);
    policy[action] = Math.max(0, Math.min(1, newValue));

    const totalReward = (existing?.reward ?? 0) + reward;

    this.db.prepare(`
      INSERT OR REPLACE INTO marl_policies (agent_id, policy_json, reward, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(agentId, JSON.stringify(policy), totalReward);

    return { agentId, policy, reward: totalReward, updatedAt: new Date().toISOString() };
  }

  giveReward(fromAgent: string, toAgent: string, reward: number, reason: string): RewardSignal {
    const clamped = Math.max(-1, Math.min(1, reward));
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO agent_rewards (id, from_agent, to_agent, reward, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, fromAgent, toAgent, clamped, reason);

    this.updatePolicy(toAgent, `from_${fromAgent}`, clamped);

    return { fromAgent, toAgent, reward: clamped, reason, timestamp: now };
  }

  getPolicy(agentId: string): AgentPolicy | null {
    const row = this.db.prepare('SELECT * FROM marl_policies WHERE agent_id = ?').get(agentId) as PolicyRow | undefined;
    if (!row) return null;
    return { agentId: row.agent_id, policy: JSON.parse(row.policy_json) as Record<string, number>, reward: row.reward, updatedAt: row.updated_at };
  }

  getAllPolicies(): AgentPolicy[] {
    const rows = this.db.prepare('SELECT * FROM marl_policies ORDER BY reward DESC').all() as PolicyRow[];
    return rows.map(row => ({ agentId: row.agent_id, policy: JSON.parse(row.policy_json) as Record<string, number>, reward: row.reward, updatedAt: row.updated_at }));
  }

  getRewardHistory(agentId: string, limit: number = 20): RewardSignal[] {
    const rows = this.db.prepare(
      "SELECT * FROM agent_rewards WHERE to_agent = ? ORDER BY created_at DESC LIMIT ?"
    ).all(agentId, limit) as RewardRow[];
    return rows.map(r => ({ fromAgent: r.from_agent, toAgent: r.to_agent, reward: r.reward, reason: r.reason, timestamp: r.created_at }));
  }

  getTopAgents(limit: number = 5): AgentPolicy[] {
    const policies = this.getAllPolicies();
    return policies.slice(0, limit);
  }

  detectSpecialization(): Array<{ agentId: string; specialty: string; score: number }> {
    const policies = this.getAllPolicies();
    const specializations: Array<{ agentId: string; specialty: string; score: number }> = [];

    for (const policy of policies) {
      const entries = Object.entries(policy.policy);
      if (entries.length === 0) continue;

      const sorted = entries.sort((a, b) => b[1] - a[1]);
      const [topAction, topValue] = sorted[0];

      if (topValue > 0.6) {
        specializations.push({ agentId: policy.agentId, specialty: topAction, score: topValue });
      }
    }

    return specializations;
  }
}
