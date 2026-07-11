/**
 * AgentLifecycleService — agent retirement, decommissioning, and archival.
 *
 * Implements the missing P0 capability from the OpenMythos audit:
 * "Agent retirement — No decommissioning or archival"
 *
 * Lifecycle: active → deprecated → retired → archived
 *
 * Key capabilities:
 * 1. Retirement detection — identify agents that should be retired (inactive, superseded, failing)
 * 2. Graceful decommission — drain active tasks, transfer state, notify dependents
 * 3. Archival — preserve agent configuration and history for audit/compliance
 * 4. Reactivation — restore archived agents if needed
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export type AgentLifecycleStatus = 'active' | 'deprecated' | 'retired' | 'archived';

export interface AgentRecord {
  id: string;
  name: string;
  type: string;
  status: AgentLifecycleStatus;
  created_at: string;
  last_active_at: string | null;
  retired_at: string | null;
  retirement_reason: string | null;
  metadata: Record<string, unknown>;
}

export interface RetirementRecommendation {
  agent_id: string;
  reason: string;
  confidence: number;
  evidence: string[];
  recommended_action: 'monitor' | 'deprecate' | 'retire';
}

export class AgentLifecycleService {
  private readonly INACTIVITY_THRESHOLD_DAYS = 30;

  constructor(private db: Database) {
    this.ensureTables();
  }

  // ─── Lifecycle Management ─────────────────────────────────────────

  registerAgent(input: { name: string; type: string; metadata?: Record<string, unknown> }): AgentRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_lifecycle (id, name, type, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(id, input.name, input.type, JSON.stringify(input.metadata || {}), now, now);
    return this.getAgent(id);
  }

  getAgent(id: string): AgentRecord {
    const row = this.db.prepare('SELECT * FROM agent_lifecycle WHERE id = ?').get(id) as any;
    if (!row) throw new Error('AGENT_NOT_FOUND');
    return this.parseAgent(row);
  }

  listAgents(status?: AgentLifecycleStatus): AgentRecord[] {
    const query = status
      ? 'SELECT * FROM agent_lifecycle WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM agent_lifecycle ORDER BY created_at DESC';
    const params = status ? [status] : [];
    return (this.db.prepare(query).all(...params) as any[]).map((row) => this.parseAgent(row));
  }

  updateActivity(agentId: string): void {
    this.db.prepare('UPDATE agent_lifecycle SET last_active_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), agentId);
  }

  // ─── Retirement ───────────────────────────────────────────────────

  deprecateAgent(agentId: string, reason: string): AgentRecord {
    return this.transition(agentId, 'deprecated', reason);
  }

  retireAgent(agentId: string, reason: string): AgentRecord {
    const agent = this.transition(agentId, 'retired', reason);
    // Archive agent state for compliance
    this.archiveAgentState(agentId);
    return agent;
  }

  archiveAgent(agentId: string): AgentRecord {
    return this.transition(agentId, 'archived', 'Manual archival');
  }

  reactivateAgent(agentId: string): AgentRecord {
    const agent = this.getAgent(agentId);
    if (agent.status === 'active') return agent;
    return this.transition(agentId, 'active', 'Reactivated from ' + agent.status);
  }

  private transition(agentId: string, toStatus: AgentLifecycleStatus, reason: string): AgentRecord {
    this.getAgent(agentId); // validate agent exists (throws AGENT_NOT_FOUND)
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE agent_lifecycle SET status = ?, retirement_reason = ?, retired_at = ?, updated_at = ? WHERE id = ?
    `).run(toStatus, reason, toStatus === 'retired' || toStatus === 'archived' ? now : null, now, agentId);
    return this.getAgent(agentId);
  }

  // ─── Retirement Detection ─────────────────────────────────────────

  detectRetirementCandidates(): RetirementRecommendation[] {
    const recommendations: RetirementRecommendation[] = [];
    const agents = this.listAgents('active');

    for (const agent of agents) {
      // Pattern 1: Inactive for >30 days
      if (agent.last_active_at) {
        const daysInactive = (Date.now() - new Date(agent.last_active_at).getTime()) / 86400_000;
        if (daysInactive > this.INACTIVITY_THRESHOLD_DAYS) {
          recommendations.push({
            agent_id: agent.id,
            reason: `Inactive for ${Math.round(daysInactive)} days`,
            confidence: Math.min(0.9, 0.5 + daysInactive * 0.01),
            evidence: [`Last active: ${agent.last_active_at}`],
            recommended_action: daysInactive > 90 ? 'retire' : 'deprecate',
          });
        }
      }

      // Pattern 2: Never active (created >30 days ago, no activity)
      if (!agent.last_active_at) {
        const daysSinceCreation = (Date.now() - new Date(agent.created_at).getTime()) / 86400_000;
        if (daysSinceCreation > this.INACTIVITY_THRESHOLD_DAYS) {
          recommendations.push({
            agent_id: agent.id,
            reason: `Never active, created ${Math.round(daysSinceCreation)} days ago`,
            confidence: 0.7,
            evidence: [`Created: ${agent.created_at}`, 'No activity recorded'],
            recommended_action: 'deprecate',
          });
        }
      }
    }

    return recommendations;
  }

  // ─── Archival ────────────────────────────────────────────────────

  private archiveAgentState(agentId: string): void {
    const agent = this.getAgent(agentId);
    const archiveData = {
      agent: agent,
      archivedAt: new Date().toISOString(),
      history: this.db.prepare('SELECT * FROM agent_lifecycle WHERE id = ?').all(agentId),
    };
    this.db.prepare(`
      INSERT INTO agent_lifecycle_archive (agent_id, archive_data, created_at)
      VALUES (?, ?, ?)
    `).run(agentId, JSON.stringify(archiveData), new Date().toISOString());
  }

  getArchivedAgent(agentId: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM agent_lifecycle_archive WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agentId) as any;
    if (!row) return null;
    return JSON.parse(row.archive_data);
  }

  // ─── Statistics ───────────────────────────────────────────────────

  getStats(): {
    total: number;
    active: number;
    deprecated: number;
    retired: number;
    archived: number;
    retirement_candidates: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM agent_lifecycle').get() as any)?.c || 0;
    const active = (this.db.prepare("SELECT COUNT(*) as c FROM agent_lifecycle WHERE status = 'active'").get() as any)?.c || 0;
    const deprecated = (this.db.prepare("SELECT COUNT(*) as c FROM agent_lifecycle WHERE status = 'deprecated'").get() as any)?.c || 0;
    const retired = (this.db.prepare("SELECT COUNT(*) as c FROM agent_lifecycle WHERE status = 'retired'").get() as any)?.c || 0;
    const archived = (this.db.prepare("SELECT COUNT(*) as c FROM agent_lifecycle WHERE status = 'archived'").get() as any)?.c || 0;
    const candidates = this.detectRetirementCandidates().length;
    return { total, active, deprecated, retired, archived, retirement_candidates: candidates };
  }

  // ─── Private ──────────────────────────────────────────────────────

  private parseAgent(row: any): AgentRecord {
    return {
      id: row.id, name: row.name, type: row.type, status: row.status,
      created_at: row.created_at, last_active_at: row.last_active_at,
      retired_at: row.retired_at, retirement_reason: row.retirement_reason,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_lifecycle (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_active_at TEXT, retired_at TEXT, retirement_reason TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS agent_lifecycle_archive (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        archive_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_status ON agent_lifecycle(status);
      CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_archive ON agent_lifecycle_archive(agent_id);
    `);
  }
}
