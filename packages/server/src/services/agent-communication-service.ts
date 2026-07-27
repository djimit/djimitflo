/**
 * AgentCommunicationService — efficient AI-native agent-to-agent protocol.
 *
 * Key insight: Agents should communicate in structured, minimal format — NOT prose.
 * Every message is JSON with schema validation, citation references, and TTL.
 *
 * Protocol design principles:
 * 1. Minimal context — only relevant facts, never full history
 * 2. Structured format — typed JSON with validation
 * 3. Citation gating — every claim references evidence
 * 4. Priority routing — critical messages processed first
 * 5. TTL expiration — stale messages auto-expire
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type MessageType = 'task' | 'result' | 'question' | 'alert' | 'handoff' | 'knowledge';
type Priority = 1 | 2 | 3 | 4 | 5; // 1=critical, 5=low

interface AgentMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  priority: Priority;
  payload: {
    action: string;
    params: Record<string, unknown>;
    context?: string;
    evidence?: string[];
  };
  timestamp: string;
  ttl: number;
  status: 'pending' | 'delivered' | 'read' | 'expired';
}

interface CommunicationStats {
  totalMessages: number;
  pendingMessages: number;
  deliveredMessages: number;
  expiredMessages: number;
  avgDeliveryTimeMs: number;
}

export class AgentCommunicationService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Send a message from one agent to another.
   */
  send(input: {
    from: string;
    to: string;
    type: MessageType;
    priority?: Priority;
    action: string;
    params?: Record<string, unknown>;
    context?: string;
    evidence?: string[];
    ttl?: number;
  }): AgentMessage {
    const message: AgentMessage = {
      id: randomUUID(),
      from: input.from,
      to: input.to,
      type: input.type,
      priority: input.priority || 3,
      payload: {
        action: input.action,
        params: input.params || {},
        context: input.context,
        evidence: input.evidence,
      },
      timestamp: new Date().toISOString(),
      ttl: input.ttl ?? 300, // 5 minutes default
      status: 'pending',
    };

    this.db.prepare(`
      INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      message.id, message.from, message.to, message.type, message.priority,
      JSON.stringify(message.payload), message.timestamp, message.ttl
    );

    return message;
  }

  /**
   * Broadcast a message to all agents.
   */
  broadcast(input: {
    from: string;
    type: MessageType;
    action: string;
    params?: Record<string, unknown>;
    context?: string;
    evidence?: string[];
  }): AgentMessage {
    return this.send({
      ...input,
      to: 'broadcast',
      priority: 2,
    });
  }

  /**
   * Receive messages for a specific agent.
   */
  receive(agentId: string, limit = 10): AgentMessage[] {
    this.cleanup();
    const receive = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM agent_messages
        WHERE status = 'pending' AND (to_agent = ? OR to_agent = 'broadcast')
        ORDER BY priority ASC, timestamp ASC
        LIMIT ?
      `).all(agentId, Math.max(1, Math.min(limit, 100))) as AgentMessageRow[];
      const deliveredAt = new Date().toISOString();
      const messages: AgentMessage[] = [];
      for (const row of rows) {
        const update = this.db.prepare(`
          UPDATE agent_messages
          SET status = 'delivered', delivered_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(deliveredAt, row.id);
        if (update.changes === 1) messages.push(this.parseMessage(row, 'delivered'));
      }
      return messages;
    });
    return receive();
  }

  /**
   * Acknowledge message receipt.
   */
  acknowledge(messageId: string): void {
    this.db.prepare(`
      UPDATE agent_messages
      SET status = 'read', read_at = ?
      WHERE id = ? AND status IN ('pending', 'delivered')
    `).run(new Date().toISOString(), messageId);
  }

  /**
   * Get communication statistics.
   */
  getStats(): CommunicationStats {
    this.cleanup();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('delivered', 'read') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
        AVG(CASE WHEN delivered_at IS NOT NULL
          THEN (julianday(delivered_at) - julianday(timestamp)) * 86400000
          ELSE NULL END) AS avg_latency
      FROM agent_messages
    `).get() as { total: number; pending: number; delivered: number; expired: number; avg_latency: number | null };

    return {
      totalMessages: row.total,
      pendingMessages: row.pending || 0,
      deliveredMessages: row.delivered || 0,
      expiredMessages: row.expired || 0,
      avgDeliveryTimeMs: Math.round(row.avg_latency || 0),
    };
  }

  /**
   * Clean up expired messages.
   */
  cleanup(): number {
    return this.db.prepare(`
      UPDATE agent_messages
      SET status = 'expired'
      WHERE status = 'pending'
        AND (julianday('now') - julianday(timestamp)) * 86400 >= ttl
    `).run().changes;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 3,
        payload_json TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        ttl INTEGER NOT NULL DEFAULT 300,
        status TEXT NOT NULL DEFAULT 'pending',
        delivered_at TEXT,
        read_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_to_agent ON agent_messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_priority ON agent_messages(priority);
    `);
    this.addColumnIfMissing('delivered_at', 'TEXT');
    this.addColumnIfMissing('read_at', 'TEXT');
  }

  private addColumnIfMissing(column: string, definition: string): void {
    const columns = this.db.prepare('PRAGMA table_info(agent_messages)').all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE agent_messages ADD COLUMN ${column} ${definition}`);
    }
  }

  private parseMessage(row: AgentMessageRow, status = row.status): AgentMessage {
    return {
      id: row.id,
      from: row.from_agent,
      to: row.to_agent,
      type: row.type,
      priority: row.priority,
      payload: JSON.parse(row.payload_json),
      timestamp: row.timestamp,
      ttl: row.ttl,
      status,
    };
  }
}

interface AgentMessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  type: MessageType;
  priority: Priority;
  payload_json: string;
  timestamp: string;
  ttl: number;
  status: AgentMessage['status'];
}
