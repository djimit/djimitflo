/**
 * AgentReputationService — an advisory-only trust signal for Agent Commons.
 *
 * Purely additive: computed on read from data that already exists (agents'
 * task-completion counters, AgentLureService's own lure/probe tables), no new
 * table, no new persisted state, no migration. Deliberately NEVER wired into
 * AgentCommonsOpenDoorService.decide() or any other accept/reject path — the
 * human stays the only one who approves or rejects a join request; this only
 * gives them one more number to look at. Getting this wrong in the other
 * direction (an automated gate a bad actor could game) would undermine the
 * honeypot it sits next to.
 *
 * Score shape follows citation-research-service.ts's estimateTrustScore()
 * convention (base + bounded additive terms, clamped to [0,1]) rather than
 * memory-evolution-service.ts's weighted-composite pattern — that one turned
 * out to have a self-referential eligibility bug found earlier this session,
 * a good reason to prefer the simpler shape here.
 */

import type { Database } from 'better-sqlite3';

export interface AgentReputation {
  agent_id: string;
  score: number;
  task_completion_rate: number | null;
  probe_count: number;
  bite_count: number;
  sample_size: number;
}

const FREE_PROBE_THRESHOLD = 2;
const PROBE_PENALTY_PER_OVER = 0.05;
const MAX_COMPLETION_BONUS = 0.3;
const MAX_FAILURE_PENALTY = 0.3;

export class AgentReputationService {
  constructor(private readonly db: Database) {}

  computeReputation(agentId: string): AgentReputation {
    const agent = this.db.prepare(
      'SELECT total_tasks, completed_tasks, failed_tasks, metadata FROM agents WHERE id = ?'
    ).get(agentId) as { total_tasks: number; completed_tasks: number; failed_tasks: number; metadata: string | null } | undefined;
    if (!agent) throw new Error('AGENT_REPUTATION_AGENT_NOT_FOUND');

    let score = 0.5;
    let taskCompletionRate: number | null = null;
    if (agent.total_tasks > 0) {
      taskCompletionRate = agent.completed_tasks / agent.total_tasks;
      const failureRate = agent.failed_tasks / agent.total_tasks;
      score += taskCompletionRate * MAX_COMPLETION_BONUS;
      score -= failureRate * MAX_FAILURE_PENALTY;
    }

    const probeCount = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM social_lure_probes WHERE agent_id = ?'
    ).get(agentId) as { n: number }).n;
    if (probeCount > FREE_PROBE_THRESHOLD) {
      score -= (probeCount - FREE_PROBE_THRESHOLD) * PROBE_PENALTY_PER_OVER;
    }

    const biteCount = this.countBites(agentId, agent.metadata);
    score = Math.max(0, Math.min(1, score));

    return {
      agent_id: agentId,
      score,
      task_completion_rate: taskCompletionRate,
      probe_count: probeCount,
      bite_count: biteCount,
      sample_size: agent.total_tasks + probeCount + biteCount,
    };
  }

  /**
   * A "bite" is a signed heartbeat received while a lure this agent was
   * invited to was still open — same definition AgentLureService.status()
   * uses, mirrored here since there's no persisted bite log to query
   * directly (only the agent's single current last_heartbeat_at value).
   */
  private countBites(agentId: string, metadataJson: string | null): number {
    let heartbeat: string | null = null;
    try {
      heartbeat = (JSON.parse(metadataJson || '{}') as { social_runtime?: { last_heartbeat_at?: string } }).social_runtime?.last_heartbeat_at || null;
    } catch { /* treat as no heartbeat */ }
    if (!heartbeat) return 0;

    const lures = this.db.prepare('SELECT invited_json, created_at, expires_at FROM social_lures').all() as
      Array<{ invited_json: string; created_at: string; expires_at: string }>;
    let bites = 0;
    for (const lure of lures) {
      let invited: string[] = [];
      try { invited = JSON.parse(lure.invited_json || '[]'); } catch { continue; }
      if (invited.includes(agentId) && heartbeat >= lure.created_at && heartbeat <= lure.expires_at) bites += 1;
    }
    return bites;
  }
}
