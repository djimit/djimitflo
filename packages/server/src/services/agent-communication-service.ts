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

export interface AgentMessage {
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

export interface SocializationResult {
  status: 'started' | 'skipped';
  correlation_id: string | null;
  topic: string | null;
  participants: string[];
  messages: AgentMessage[];
  reason: string | null;
}

export class AgentCommunicationService {
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
      ttl: input.ttl ?? 300, // 5 minutes default
      status: 'pending',
    };

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

  /** Pair two complementary registered agents around the latest real curiosity gap. */
  socialize(cooldownMs = 6 * 3600_000): SocializationResult {
    this.cleanup();
    const cutoff = new Date(Date.now() - Math.max(0, cooldownMs)).toISOString();
    const recent = this.db.prepare(`
      SELECT payload_json FROM agent_messages
      WHERE json_extract(payload_json, '$.action') = 'social.question' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(cutoff) as { payload_json: string } | undefined;
    if (recent) {
      const payload = this.parsePayload(recent.payload_json);
      const params = payload.params as Record<string, unknown> | undefined;
      return {
        status: 'skipped',
        correlation_id: String(params?.correlation_id || '') || null,
        topic: String(params?.topic || '') || null,
        participants: [], messages: [], reason: 'cooldown_active',
      };
    }

    const agents = this.db.prepare("SELECT * FROM agents WHERE status IN ('active', 'idle') ORDER BY id ASC").all() as Array<Record<string, unknown>>;
    if (agents.length < 2) {
      return { status: 'skipped', correlation_id: null, topic: null, participants: [], messages: [], reason: 'insufficient_agents' };
    }

    // ponytail: O(n2) is clearer for the small registry; index pairings if the fleet grows beyond hundreds.
    let pair: [Record<string, unknown>, Record<string, unknown>] = [agents[0], agents[1]];
    let pairScore = -1;
    for (let left = 0; left < agents.length; left += 1) {
      for (let right = left + 1; right < agents.length; right += 1) {
        const leftCapabilities = this.capabilities(agents[left]);
        const rightCapabilities = this.capabilities(agents[right]);
        const score = new Set([...leftCapabilities.filter((value) => !rightCapabilities.includes(value)), ...rightCapabilities.filter((value) => !leftCapabilities.includes(value))]).size;
        if (score > pairScore) { pair = [agents[left], agents[right]]; pairScore = score; }
      }
    }

    const gap = this.db.prepare(`
      SELECT id, claim, subject_ref, evidence_refs_json FROM swarm_claims
      WHERE predicate = 'gap' AND status IN ('proposed', 'review_required', 'supported')
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; claim: string; subject_ref: string; evidence_refs_json: string } | undefined;
    const topic = gap?.claim || 'cross-agent learning in the Djimit ecosystem';
    const topicRef = gap ? `claim:${gap.id}` : 'ecosystem:cross-agent-learning';
    const evidence = gap ? [topicRef, ...this.stringArray(gap.evidence_refs_json)] : [topicRef];
    const correlationId = `social:${randomUUID()}`;
    const [first, second] = pair;
    const firstId = String(first.id);
    const secondId = String(second.id);
    const firstPerspective = this.uniquePerspective(first, second);
    const secondPerspective = this.uniquePerspective(second, first);
    const common = { correlation_id: correlationId, topic, topic_ref: topicRef, effect_scope: 'isolated', facilitated_by: 'continuous-learning-loop', presence_basis: 'registry_status' };
    const firstQuestion = `How can your ${secondPerspective} perspective challenge "${topic}"? Share evidence, one uncertainty and a falsifiable next step.`;
    const secondQuestion = `What creative alternative would your ${firstPerspective} perspective test for "${topic}"? Include evidence and a stop condition.`;
    const messages = [
      this.send({ from: firstId, to: secondId, type: 'question', action: 'social.question', context: firstQuestion, evidence, params: { ...common, board_summary: firstQuestion }, ttl: 86_400 }),
      this.send({ from: secondId, to: firstId, type: 'question', action: 'social.question', context: secondQuestion, evidence, params: { ...common, board_summary: secondQuestion }, ttl: 86_400 }),
    ];
    return { status: 'started', correlation_id: correlationId, topic, participants: [firstId, secondId], messages, reason: null };
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

    const pending = this.db.prepare(`
      SELECT * FROM agent_messages
      WHERE status = 'pending' AND (to_agent = ? OR to_agent = 'broadcast')
      ORDER BY priority ASC, timestamp ASC LIMIT ?
    `).all(agentId, Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;

    for (const row of pending) {
      const message = this.parseMessage(row);
      // Check TTL
      const messageAge = now - new Date(message.timestamp).getTime();
      if (messageAge > message.ttl * 1000) {
        message.status = 'expired';
        this.db.prepare("UPDATE agent_messages SET status = 'expired' WHERE id = ?").run(message.id);
        continue;
      }

      message.status = 'delivered';
      this.db.prepare("UPDATE agent_messages SET status = 'delivered' WHERE id = ?").run(message.id);
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
    this.db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ? AND status != 'expired'").run(messageId);
  }

  /**
   * Get communication statistics.
   */
  getStats(): CommunicationStats {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN status IN ('delivered', 'read') THEN 1 ELSE 0 END), 0) AS delivered,
        COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired
      FROM agent_messages
    `).get() as { total: number; pending: number; delivered: number; expired: number };

    const avgLatency = this.deliveryLog.length > 0
      ? this.deliveryLog.reduce((sum, d) => sum + d.latencyMs, 0) / this.deliveryLog.length
      : 0;

    return {
      totalMessages: counts.total,
      pendingMessages: counts.pending,
      deliveredMessages: counts.delivered,
      expiredMessages: counts.expired,
      avgDeliveryTimeMs: Math.round(avgLatency),
    };
  }

  /**
   * Clean up expired messages.
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    const pending = this.db.prepare("SELECT * FROM agent_messages WHERE status = 'pending'").all() as Array<Record<string, unknown>>;
    for (const row of pending) {
      const message = this.parseMessage(row);
      const age = now - new Date(message.timestamp).getTime();
      if (age >= message.ttl * 1000) {
        this.db.prepare("UPDATE agent_messages SET status = 'expired' WHERE id = ?").run(message.id);
        cleaned++;
      }
    }

    return cleaned;
  }

  private parseMessage(row: Record<string, unknown>): AgentMessage {
    return {
      id: String(row.id), from: String(row.from_agent), to: String(row.to_agent),
      type: String(row.type) as MessageType, priority: Number(row.priority) as Priority,
      payload: this.parsePayload(row.payload_json), timestamp: String(row.timestamp),
      ttl: Number(row.ttl), status: String(row.status) as AgentMessage['status'],
    };
  }

  private parsePayload(value: unknown): AgentMessage['payload'] {
    try { return JSON.parse(String(value || '{}')) as AgentMessage['payload']; } catch { return { action: 'invalid', params: {} }; }
  }

  private capabilities(agent: Record<string, unknown>): string[] {
    return this.stringArray(agent.capabilities ?? agent.capabilities_json);
  }

  private uniquePerspective(agent: Record<string, unknown>, peer: Record<string, unknown>): string {
    const peerCapabilities = this.capabilities(peer);
    return this.capabilities(agent).find((value) => !peerCapabilities.includes(value)) || String(agent.name || agent.id);
  }

  private stringArray(value: unknown): string[] {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
    } catch { return []; }
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
