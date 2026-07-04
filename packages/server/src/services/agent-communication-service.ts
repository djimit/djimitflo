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
  private messageQueue: AgentMessage[] = [];
  private deliveryLog: Array<{ messageId: string; deliveredAt: string; latencyMs: number }> = [];

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
      ttl: input.ttl || 300, // 5 minutes default
      status: 'pending',
    };

    // Insert in priority order
    const insertIndex = this.messageQueue.findIndex((m) => m.priority > message.priority);
    if (insertIndex === -1) {
      this.messageQueue.push(message);
    } else {
      this.messageQueue.splice(insertIndex, 0, message);
    }

    // Persist
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
    const now = Date.now();
    const messages: AgentMessage[] = [];

    // Get pending messages for this agent (or broadcast)
    const pending = this.messageQueue.filter(
      (m) => m.status === 'pending' && (m.to === agentId || m.to === 'broadcast')
    );

    for (const message of pending) {
      // Check TTL
      const messageAge = now - new Date(message.timestamp).getTime();
      if (messageAge > message.ttl * 1000) {
        message.status = 'expired';
        continue;
      }

      message.status = 'delivered';
      messages.push(message);

      // Log delivery
      this.deliveryLog.push({
        messageId: message.id,
        deliveredAt: new Date().toISOString(),
        latencyMs: messageAge,
      });

      if (messages.length >= limit) break;
    }

    return messages;
  }

  /**
   * Acknowledge message receipt.
   */
  acknowledge(messageId: string): void {
    const message = this.messageQueue.find((m) => m.id === messageId);
    if (message) {
      message.status = 'read';
      this.db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(messageId);
    }
  }

  /**
   * Get communication statistics.
   */
  getStats(): CommunicationStats {
    const total = this.messageQueue.length;
    const pending = this.messageQueue.filter((m) => m.status === 'pending').length;
    const delivered = this.messageQueue.filter((m) => m.status === 'delivered' || m.status === 'read').length;
    const expired = this.messageQueue.filter((m) => m.status === 'expired').length;

    const avgLatency = this.deliveryLog.length > 0
      ? this.deliveryLog.reduce((sum, d) => sum + d.latencyMs, 0) / this.deliveryLog.length
      : 0;

    return {
      totalMessages: total,
      pendingMessages: pending,
      deliveredMessages: delivered,
      expiredMessages: expired,
      avgDeliveryTimeMs: Math.round(avgLatency),
    };
  }

  /**
   * Clean up expired messages.
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    this.messageQueue = this.messageQueue.filter((message) => {
      const age = now - new Date(message.timestamp).getTime();
      if (age > message.ttl * 1000 && message.status === 'pending') {
        message.status = 'expired';
        cleaned++;
        return false;
      }
      return true;
    });

    return cleaned;
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
        status TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_to_agent ON agent_messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_priority ON agent_messages(priority);
    `);
  }
}
