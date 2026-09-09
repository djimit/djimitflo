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
import { boardMessageFingerprint, boardProtocolError, boardReplyTargetError, type BoardEpistemicRole } from './board-protocol';

type MessageType = 'task' | 'result' | 'question' | 'alert' | 'handoff' | 'knowledge';
type Priority = 1 | 2 | 3 | 4 | 5; // 1=critical, 5=low
type EpistemicRole = BoardEpistemicRole;

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
    thread_id?: string;
    reply_to?: string;
    epistemic_role?: EpistemicRole;
  };
  timestamp: string;
  ttl: number;
  status: 'pending' | 'delivered' | 'read' | 'expired';
  deliveryLeaseToken?: string;
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
    threadId?: string;
    replyTo?: string;
    epistemicRole?: EpistemicRole;
    idempotencyKey?: string;
  }): AgentMessage {
    const validTypes: MessageType[] = ['task', 'result', 'question', 'alert', 'handoff', 'knowledge'];
    if (!validTypes.includes(input.type)) throw new Error('BOARD_MESSAGE_TYPE_INVALID');
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)) {
      throw new Error('BOARD_MESSAGE_PRIORITY_INVALID');
    }
    if (input.ttl !== undefined && (!Number.isFinite(input.ttl) || input.ttl < 0)) {
      throw new Error('BOARD_MESSAGE_TTL_INVALID');
    }
    const protocolError = boardProtocolError(input.epistemicRole, input.evidence, input.threadId, input.replyTo);
    if (protocolError) throw new Error(protocolError);
    const replyError = boardReplyTargetError(this.db, input.replyTo, input.threadId, input.from, input.to);
    if (replyError) throw new Error(replyError);
    const idempotencyKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : undefined;
    const fingerprint = boardMessageFingerprint({
      from: input.from, to: input.to, type: input.type, priority: input.priority || 3,
      action: input.action, params: input.params || {}, context: input.context,
      evidence: input.evidence, ttl: input.ttl === undefined ? 300 : input.ttl,
      threadId: input.threadId, replyTo: input.replyTo, epistemicRole: input.epistemicRole,
    });
    if (idempotencyKey) {
      const existing = this.findByIdempotency(input.from, input.to, input.type, idempotencyKey);
      if (existing) {
        if (this.fingerprintForRow(existing) !== fingerprint) throw new Error('BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT');
        return this.messageFromRow(existing);
      }
    }
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
        thread_id: input.threadId,
        reply_to: input.replyTo,
        epistemic_role: input.epistemicRole,
      },
      timestamp: new Date().toISOString(),
      ttl: input.ttl === undefined ? 300 : input.ttl, // 5 minutes default
      status: 'pending',
    };

    const recipients = message.to === 'broadcast' ? this.broadcastRecipients() : [];
    if (message.to === 'broadcast' && recipients.length === 0) {
      throw new Error('BOARD_BROADCAST_NO_RECIPIENTS');
    }

    let replay: AgentMessage | undefined;
    try {
      this.db.transaction(() => {
        if (idempotencyKey) {
          const reservation = this.db.prepare(`
            INSERT OR IGNORE INTO board_idempotency_keys
              (sender, recipient, message_type, idempotency_key, store, message_id)
            VALUES (?, ?, ?, ?, 'agent_messages', ?)
          `).run(message.from, message.to, message.type, idempotencyKey, message.id);
          if (reservation.changes !== 1) {
            const owner = this.db.prepare(`
              SELECT store, message_id FROM board_idempotency_keys
              WHERE sender = ? AND recipient = ? AND message_type = ? AND idempotency_key = ?
            `).get(message.from, message.to, message.type, idempotencyKey) as { store?: string; message_id?: string } | undefined;
            if (owner?.store !== 'agent_messages') throw new Error('BOARD_IDEMPOTENCY_SCOPE_CONFLICT');
            const existing = owner.message_id ? this.db.prepare('SELECT id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status FROM agent_messages WHERE id = ?').get(owner.message_id) : undefined;
            if (existing) {
              if (this.fingerprintForRow(existing) !== fingerprint) throw new Error('BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT');
              replay = this.messageFromRow(existing);
              return;
            }
            throw new Error('BOARD_IDEMPOTENCY_ORPHANED');
          }
        }
        this.db.prepare(`
          INSERT INTO agent_messages (id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status, idempotency_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          message.id, message.from, message.to, message.type, message.priority,
          JSON.stringify(message.payload), message.timestamp, message.ttl, idempotencyKey || null
        );
        if (message.to === 'broadcast') {
          const insertDelivery = this.db.prepare(`
            INSERT INTO agent_message_deliveries (message_id, agent_id, status)
            VALUES (?, ?, 'pending')
          `);
          for (const recipient of recipients) insertDelivery.run(message.id, recipient);
        }
      })();
      if (replay) return replay;
    } catch (error) {
      const code = (error as { code?: string }).code || '';
      if (idempotencyKey && code.startsWith('SQLITE_CONSTRAINT')) {
        const existing = this.findByIdempotency(input.from, input.to, input.type, idempotencyKey);
        if (existing) {
          if (this.fingerprintForRow(existing) !== fingerprint) throw new Error('BOARD_IDEMPOTENCY_PAYLOAD_CONFLICT');
          return this.messageFromRow(existing);
        }
      }
      throw error;
    }

    // Insert in priority order after durable persistence succeeds.
    const insertIndex = this.messageQueue.findIndex((m) => m.priority > message.priority);
    if (insertIndex === -1) this.messageQueue.push(message);
    else this.messageQueue.splice(insertIndex, 0, message);

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
    threadId?: string;
    replyTo?: string;
    epistemicRole?: EpistemicRole;
    idempotencyKey?: string;
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
    this.backfillBroadcastDeliveries();

    // SQLite is authoritative. The in-memory queue is only a hot-path cache;
    // reading it exclusively loses messages after a process restart.
    const claimPending = this.db.transaction((max: number) => {
      const rows = this.db.prepare(`
        SELECT m.id, m.from_agent, m.to_agent, m.type, m.priority, m.payload_json, m.timestamp, m.ttl, m.status
        FROM agent_messages m
        LEFT JOIN agent_message_deliveries d ON d.message_id = m.id AND d.agent_id = ?
        WHERE (m.to_agent = ? AND (m.status = 'pending' OR (m.status = 'delivered' AND (m.delivery_lease_until <= ? OR m.delivery_lease_until IS NULL))))
          OR (m.to_agent = 'broadcast' AND (d.status = 'pending' OR (d.status = 'delivered' AND (d.delivery_lease_until <= ? OR d.delivery_lease_until IS NULL))))
        ORDER BY m.priority ASC, m.timestamp ASC
        LIMIT ?
      `).all(agentId, agentId, now, now, max) as any[];
      const claimed: Array<{ message: AgentMessage; age: number }> = [];
      const expire = this.db.prepare("UPDATE agent_messages SET status = 'expired', delivery_lease_until = NULL WHERE id = ? AND status IN ('pending', 'delivered')");
      const leaseUntil = now + 60_000;
      const deliver = this.db.prepare("UPDATE agent_messages SET status = 'delivered', delivery_lease_until = ?, delivery_lease_token = ? WHERE id = ? AND to_agent = ? AND (status = 'pending' OR (status = 'delivered' AND (delivery_lease_until <= ? OR delivery_lease_until IS NULL)))");
      const expireDelivery = this.db.prepare("UPDATE agent_message_deliveries SET status = 'expired', delivery_lease_until = NULL, delivery_lease_token = NULL WHERE message_id = ? AND agent_id = ? AND status IN ('pending', 'delivered')");
      const deliverDelivery = this.db.prepare("UPDATE agent_message_deliveries SET status = 'delivered', delivery_lease_until = ?, delivery_lease_token = ? WHERE message_id = ? AND agent_id = ? AND (status = 'pending' OR (status = 'delivered' AND (delivery_lease_until <= ? OR delivery_lease_until IS NULL)))");
      const finishBroadcast = this.db.prepare("UPDATE agent_messages SET status = CASE WHEN EXISTS (SELECT 1 FROM agent_message_deliveries WHERE message_id = ? AND status = 'delivered') THEN 'delivered' ELSE 'expired' END WHERE id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM agent_message_deliveries WHERE message_id = ? AND status = 'pending')");
      for (const row of rows) {
        const message = this.messageFromRow(row);
        const messageAge = now - new Date(message.timestamp).getTime();
        if (messageAge > message.ttl * 1000) {
          if (message.to === 'broadcast') {
            expireDelivery.run(message.id, agentId);
            finishBroadcast.run(message.id, message.id, message.id);
          } else expire.run(message.id);
          continue;
        }
        if (message.to === 'broadcast') {
          const leaseToken = randomUUID();
          const claimed = deliverDelivery.run(leaseUntil, leaseToken, message.id, agentId, now);
          if (claimed.changes !== 1) continue;
          message.deliveryLeaseToken = leaseToken;
          finishBroadcast.run(message.id, message.id, message.id);
        } else {
          const leaseToken = randomUUID();
          const claimed = deliver.run(leaseUntil, leaseToken, message.id, agentId, now);
          if (claimed.changes !== 1) continue;
          message.deliveryLeaseToken = leaseToken;
        }
        message.status = 'delivered';
        claimed.push({ message, age: messageAge });
      }
      return claimed;
    })(Math.max(1, Math.min(Number(limit) || 10, 100)));

    for (const { message, age } of claimPending) {
      if (!this.messageQueue.some((queued) => queued.id === message.id)) this.messageQueue.push(message);
      messages.push(message);
      this.deliveryLog.push({ messageId: message.id, deliveredAt: new Date().toISOString(), latencyMs: age });
    }

    return messages;
  }

  /**
   * Acknowledge message receipt.
   */
  acknowledge(messageId: string, agentId?: string, leaseToken?: string): void {
    if (!agentId) {
      const broadcast = this.db.prepare("SELECT 1 FROM agent_message_deliveries WHERE message_id = ? LIMIT 1").get(messageId);
      throw new Error(broadcast ? 'BOARD_BROADCAST_ACK_AGENT_REQUIRED' : 'BOARD_ACK_AGENT_REQUIRED');
    }
    const message = this.messageQueue.find((m) => m.id === messageId);
    const broadcast = this.db.prepare("SELECT 1 FROM agent_message_deliveries WHERE message_id = ? LIMIT 1").get(messageId);
    const durable = this.db.prepare('SELECT to_agent, status, delivery_lease_until, delivery_lease_token FROM agent_messages WHERE id = ?').get(messageId) as { to_agent?: string; status?: string; delivery_lease_until?: number | null; delivery_lease_token?: string | null } | undefined;
    if (!durable) throw new Error('BOARD_MESSAGE_NOT_FOUND');
    if (durable && !broadcast && durable.to_agent !== agentId) throw new Error('BOARD_ACK_AGENT_INVALID');
    const delivery = broadcast
      ? this.db.prepare('SELECT status, delivery_lease_until, delivery_lease_token FROM agent_message_deliveries WHERE message_id = ? AND agent_id = ?').get(messageId, agentId) as { status?: string; delivery_lease_until?: number | null; delivery_lease_token?: string | null } | undefined
      : undefined;
    if (broadcast && !delivery) {
      throw new Error('BOARD_BROADCAST_ACK_AGENT_INVALID');
    }
    if ((broadcast ? delivery?.status : durable?.status) === 'read') return;
    const expectedToken = broadcast ? delivery?.delivery_lease_token : durable?.delivery_lease_token;
    const leaseUntil = broadcast ? delivery?.delivery_lease_until : durable?.delivery_lease_until;
    if ((broadcast ? delivery?.status : durable?.status) === 'delivered') {
      if (!expectedToken || !leaseToken) throw new Error('BOARD_ACK_LEASE_REQUIRED');
      if (leaseUntil !== null && leaseUntil !== undefined && leaseUntil <= Date.now()) throw new Error('BOARD_ACK_LEASE_EXPIRED');
      if (expectedToken !== leaseToken) throw new Error('BOARD_ACK_LEASE_INVALID');
    }
    if (message) message.status = 'read';
    const now = Date.now();
    if (broadcast) {
      const result = this.db.prepare("UPDATE agent_message_deliveries SET status = 'read', delivery_lease_until = NULL, delivery_lease_token = NULL WHERE message_id = ? AND agent_id = ? AND status IN ('pending', 'delivered') AND (status = 'pending' OR (delivery_lease_token = ? AND (delivery_lease_until IS NULL OR delivery_lease_until > ?)))").run(messageId, agentId, leaseToken || null, now);
      if (result.changes === 0) throw new Error('BOARD_ACK_LEASE_EXPIRED');
    }
    const result = broadcast
      ? this.db.prepare("UPDATE agent_messages SET status = 'read', delivery_lease_until = NULL, delivery_lease_token = NULL WHERE id = ? AND status IN ('pending', 'delivered') AND NOT EXISTS (SELECT 1 FROM agent_message_deliveries WHERE message_id = ? AND status IN ('pending', 'delivered'))").run(messageId, messageId)
      : this.db.prepare("UPDATE agent_messages SET status = 'read', delivery_lease_until = NULL, delivery_lease_token = NULL WHERE id = ? AND status IN ('pending', 'delivered') AND to_agent = ? AND (status = 'pending' OR (delivery_lease_token = ? AND (delivery_lease_until IS NULL OR delivery_lease_until > ?)))").run(messageId, agentId, leaseToken || null, now);
    if (!broadcast && result.changes === 0) throw new Error('BOARD_ACK_LEASE_EXPIRED');
  }

  /**
   * Get communication statistics.
   */
  getStats(): CommunicationStats {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('delivered', 'read') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired
      FROM agent_messages
    `).get() as any;

    const avgLatency = this.deliveryLog.length > 0
      ? this.deliveryLog.reduce((sum, d) => sum + d.latencyMs, 0) / this.deliveryLog.length
      : 0;

    return {
      totalMessages: Number(counts?.total || 0),
      pendingMessages: Number(counts?.pending || 0),
      deliveredMessages: Number(counts?.delivered || 0),
      expiredMessages: Number(counts?.expired || 0),
      avgDeliveryTimeMs: Math.round(avgLatency),
    };
  }

  /**
   * Clean up expired messages.
   */
  cleanup(): number {
    const now = Date.now();
    const pending = this.db.prepare("SELECT id, to_agent, timestamp, ttl FROM agent_messages WHERE status IN ('pending', 'delivered')").all() as Array<{ id: string; to_agent: string; timestamp: string; ttl: number }>;
    const expire = this.db.prepare("UPDATE agent_messages SET status = 'expired', delivery_lease_until = NULL WHERE id = ? AND status IN ('pending', 'delivered')");
    const expireDeliveries = this.db.prepare("UPDATE agent_message_deliveries SET status = 'expired', delivery_lease_until = NULL WHERE message_id = ? AND status IN ('pending', 'delivered')");
    const expireBroadcast = this.db.prepare("UPDATE agent_messages SET status = 'expired' WHERE id = ? AND status IN ('pending', 'delivered') AND NOT EXISTS (SELECT 1 FROM agent_message_deliveries WHERE message_id = ? AND status IN ('pending', 'delivered'))");
    let cleaned = 0;
    for (const message of pending) {
      if (now - new Date(message.timestamp).getTime() > message.ttl * 1000) {
        if (message.to_agent === 'broadcast') {
          expireDeliveries.run(message.id);
          cleaned += expireBroadcast.run(message.id, message.id).changes;
        } else cleaned += expire.run(message.id).changes;
      }
    }
    this.messageQueue = this.messageQueue.filter((message) => message.status !== 'expired');
    return cleaned;
  }

  private messageFromRow(row: any): AgentMessage {
    let payload: AgentMessage['payload'] = { action: '', params: {} };
    try {
      const parsed = JSON.parse(row.payload_json || '{}');
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch {
      // Keep corrupt durable records visible instead of silently dropping them.
    }
    return {
      id: row.id,
      from: row.from_agent,
      to: row.to_agent,
      type: row.type,
      priority: Number(row.priority) as Priority,
      payload,
      timestamp: row.timestamp,
      ttl: Number(row.ttl),
      status: row.status,
      deliveryLeaseToken: row.delivery_lease_token || undefined,
    };
  }

  private fingerprintForRow(row: any): string {
    const payload = this.messageFromRow(row).payload;
    return boardMessageFingerprint({
      from: row.from_agent, to: row.to_agent, type: row.type, priority: Number(row.priority),
      action: payload.action, params: payload.params || {}, context: payload.context,
      evidence: payload.evidence, ttl: Number(row.ttl), threadId: payload.thread_id,
      replyTo: payload.reply_to, epistemicRole: payload.epistemic_role,
    });
  }

  private findByIdempotency(from: string, to: string, type: MessageType, key: string): any | undefined {
    return this.db.prepare(`
      SELECT id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status
      FROM agent_messages WHERE from_agent = ? AND to_agent = ? AND type = ? AND idempotency_key = ?
    `).get(from, to, type, key) as any;
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
        delivery_lease_until INTEGER,
        delivery_lease_token TEXT,
        idempotency_key TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_messages_to_agent ON agent_messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_priority ON agent_messages(priority);

      CREATE TABLE IF NOT EXISTS agent_message_deliveries (
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        delivery_lease_until INTEGER,
        delivery_lease_token TEXT,
        PRIMARY KEY (message_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_message_deliveries_agent ON agent_message_deliveries(agent_id, status);

      CREATE TABLE IF NOT EXISTS board_idempotency_keys (
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        message_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        store TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (sender, recipient, message_type, idempotency_key)
      );
    `);
    try {
      this.db.exec('ALTER TABLE agent_messages ADD COLUMN delivery_lease_until INTEGER');
    } catch {
      // Existing databases already have the delivery lease migration column.
    }
    try {
      this.db.exec('ALTER TABLE agent_messages ADD COLUMN delivery_lease_token TEXT');
    } catch {
      // Existing databases already have the fencing token migration column.
    }
    try {
      this.db.exec('ALTER TABLE agent_message_deliveries ADD COLUMN delivery_lease_token TEXT');
    } catch {
      // Existing databases already have the fencing token migration column.
    }
    try {
      this.db.exec('ALTER TABLE agent_message_deliveries ADD COLUMN delivery_lease_until INTEGER');
    } catch {
      // Existing databases already have the delivery lease migration column.
    }
    try {
      this.db.exec('ALTER TABLE agent_messages ADD COLUMN idempotency_key TEXT');
    } catch {
      // Existing databases already have the migration column.
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_idempotency
        ON agent_messages(from_agent, to_agent, type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    this.backfillBroadcastDeliveries();
    this.backfillIdempotencyKeys();
  }

  private backfillBroadcastDeliveries(): void {
    const hasAgents = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get();
    if (!hasAgents) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO agent_message_deliveries (message_id, agent_id, status)
      SELECT m.id, a.id, 'pending'
      FROM agent_messages m CROSS JOIN agents a
      WHERE m.to_agent = 'broadcast'
    `).run();
  }

  private backfillIdempotencyKeys(): void {
    const hasTable = (name: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const hasColumn = (table: string, column: string) => Boolean(this.db.prepare(`PRAGMA table_info(${table})`).all().find((row: any) => row.name === column));
    if (hasTable('agent_messages')) {
      this.db.prepare(`
        INSERT OR IGNORE INTO board_idempotency_keys
          (sender, recipient, message_type, idempotency_key, store, message_id)
        SELECT from_agent, to_agent, type, idempotency_key, 'agent_messages', id
        FROM agent_messages WHERE idempotency_key IS NOT NULL
      `).run();
    }
    if (hasTable('messages') && hasColumn('messages', 'idempotency_key')) {
      this.db.prepare(`
        INSERT OR IGNORE INTO board_idempotency_keys
          (sender, recipient, message_type, idempotency_key, store, message_id)
        SELECT from_agent_id, to_agent_id, type, idempotency_key, 'messages', id
        FROM messages WHERE idempotency_key IS NOT NULL
      `).run();
    }
  }

  private broadcastRecipients(): string[] {
    return (this.db.prepare("SELECT id FROM agents ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
  }
}
