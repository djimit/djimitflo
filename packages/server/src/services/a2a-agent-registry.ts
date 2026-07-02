import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface AgentCard {
  id: string; name: string; endpoint: string; capabilities: string[]; memoryScope: string[];
  trustLevel: number; status: 'active' | 'inactive' | 'unreachable'; lastSeen: string | null; createdAt: string;
}

export interface HandoffRequest {
  id: string; fromAgent: string; toAgent: string; context: Record<string, unknown>;
  memoryRefs: string[]; status: 'pending' | 'accepted' | 'rejected' | 'completed'; createdAt: string;
}

export class A2AAgentRegistry {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_agent_cards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]', memory_scope_json TEXT NOT NULL DEFAULT '[]',
        trust_level REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'inactive',
        last_seen TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_handoffs (
        id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}', memory_refs_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  registerAgent(card: Omit<AgentCard, 'id' | 'createdAt' | 'lastSeen'>): AgentCard {
    const id = randomUUID();
    this.db.prepare('INSERT INTO a2a_agent_cards (id, name, endpoint, capabilities_json, memory_scope_json, trust_level, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, card.name, card.endpoint, JSON.stringify(card.capabilities), JSON.stringify(card.memoryScope), card.trustLevel, card.status);
    return { ...card, id, lastSeen: null, createdAt: new Date().toISOString() };
  }

  updateAgentStatus(agentId: string, status: AgentCard['status']): void {
    this.db.prepare("UPDATE a2a_agent_cards SET status = ?, last_seen = datetime('now') WHERE id = ?").run(status, agentId);
  }

  getActiveAgents(): AgentCard[] {
    const rows = this.db.prepare("SELECT * FROM a2a_agent_cards WHERE status = 'active' ORDER BY trust_level DESC").all() as Array<{
      id: string; name: string; endpoint: string; capabilities_json: string; memory_scope_json: string; trust_level: number; status: string; last_seen: string | null; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, name: r.name, endpoint: r.endpoint,
      capabilities: JSON.parse(r.capabilities_json), memoryScope: JSON.parse(r.memory_scope_json),
      trustLevel: r.trust_level, status: r.status as AgentCard['status'], lastSeen: r.last_seen, createdAt: r.created_at,
    }));
  }

  findAgentsByCapability(capability: string): AgentCard[] {
    return this.getActiveAgents().filter(a => a.capabilities.includes(capability));
  }

  createHandoff(fromAgent: string, toAgent: string, context: Record<string, unknown>, memoryRefs: string[] = []): HandoffRequest {
    const id = randomUUID();
    this.db.prepare('INSERT INTO a2a_handoffs (id, from_agent, to_agent, context_json, memory_refs_json) VALUES (?, ?, ?, ?, ?)')
      .run(id, fromAgent, toAgent, JSON.stringify(context), JSON.stringify(memoryRefs));
    return { id, fromAgent, toAgent, context, memoryRefs, status: 'pending', createdAt: new Date().toISOString() };
  }

  updateHandoffStatus(handoffId: string, status: HandoffRequest['status']): void {
    this.db.prepare('UPDATE a2a_handoffs SET status = ? WHERE id = ?').run(status, handoffId);
  }

  getPendingHandoffs(agentId: string): HandoffRequest[] {
    const rows = this.db.prepare("SELECT * FROM a2a_handoffs WHERE to_agent = ? AND status = 'pending' ORDER BY created_at ASC").all(agentId) as Array<{
      id: string; from_agent: string; to_agent: string; context_json: string; memory_refs_json: string; status: string; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, fromAgent: r.from_agent, toAgent: r.to_agent,
      context: JSON.parse(r.context_json), memoryRefs: JSON.parse(r.memory_refs_json),
      status: r.status as HandoffRequest['status'], createdAt: r.created_at,
    }));
  }
}
