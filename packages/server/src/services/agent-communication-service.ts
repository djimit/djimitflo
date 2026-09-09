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
import { AgentAssuranceService } from './agent-assurance-service';
import { redactSecrets } from './secret-patterns';

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

export interface SocialRuntimeReply {
  answer: string;
  uncertainty: string;
  falsifiable_next_step: string;
  creative_alternative: string;
  stop_condition: string;
  evidence_refs?: string[];
  runtime?: string;
  model_id?: string;
  runtime_run_id?: string;
  usage?: Record<string, unknown>;
}

export interface SocialReplyResult {
  message: AgentMessage;
  reflection_id: string | null;
  duplicate: boolean;
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

    const heartbeatCutoff = new Date(Date.now() - 20 * 60_000).toISOString();
    const agents = this.db.prepare(`
      SELECT * FROM agents
      WHERE status IN ('active', 'idle')
        AND json_extract(COALESCE(metadata, '{}'), '$.social_runtime.enabled') = 1
        AND json_extract(COALESCE(metadata, '{}'), '$.social_runtime.last_heartbeat_at') >= ?
      ORDER BY id ASC
    `).all(heartbeatCutoff) as Array<Record<string, unknown>>;
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

  /** Record a signed runtime poller as eligible for future social rounds. */
  heartbeat(agentId: string, runtime: string, modelId?: string): { agent_id: string; status: 'active'; timestamp: string } {
    const row = this.db.prepare('SELECT id, metadata FROM agents WHERE id = ?').get(agentId) as { id: string; metadata: string | null } | undefined;
    if (!row) throw new Error('SOCIAL_AGENT_NOT_FOUND');
    const timestamp = new Date().toISOString();
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
    metadata.social_runtime = {
      enabled: true,
      runtime: this.cleanRequired(runtime, 'SOCIAL_RUNTIME_REQUIRED', 100),
      model_id: this.cleanOptional(modelId, 100),
      last_heartbeat_at: timestamp,
      provenance_status: 'signed_runtime_poller',
    };
    this.db.prepare(`
      UPDATE agents SET status = 'active', metadata = ?, last_heartbeat_at = ?, last_active_at = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(metadata), timestamp, timestamp, timestamp, agentId);
    return { agent_id: agentId, status: 'active', timestamp };
  }

  /** Return retryable social work; a reply is the idempotent completion marker. */
  receiveSocial(agentId: string, limit = 4): AgentMessage[] {
    this.cleanup();
    const rows = this.db.prepare(`
      SELECT message.* FROM agent_messages message
      WHERE message.to_agent = ?
        AND message.status IN ('pending', 'delivered')
        AND json_extract(message.payload_json, '$.action') IN ('social.question', 'social.response')
        AND NOT EXISTS (
          SELECT 1 FROM agent_messages reply
          WHERE reply.from_agent = ?
            AND json_extract(reply.payload_json, '$.params.in_reply_to') = message.id
        )
      ORDER BY message.priority ASC, message.timestamp ASC
      LIMIT ?
    `).all(agentId, agentId, Math.max(1, Math.min(limit, 10))) as Array<Record<string, unknown>>;
    const messages = rows.map((row) => this.runtimeSafeMessage(this.parseMessage(row)));
    if (messages.length) {
      const ids = messages.map((message) => message.id);
      this.db.prepare(`UPDATE agent_messages SET status = 'delivered' WHERE status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      for (const message of messages) message.status = 'delivered';
    }
    return messages;
  }

  /** Persist a real runtime answer or peer-learning assessment, never operational action. */
  respondSocial(agentId: string, messageId: string, input: SocialRuntimeReply): SocialReplyResult {
    const originalRow = this.db.prepare('SELECT * FROM agent_messages WHERE id = ? AND to_agent = ?').get(messageId, agentId) as Record<string, unknown> | undefined;
    if (!originalRow) throw new Error('SOCIAL_MESSAGE_NOT_FOUND');
    const original = this.parseMessage(originalRow);
    if (original.status === 'expired') throw new Error('SOCIAL_MESSAGE_EXPIRED');
    if (!['social.question', 'social.response'].includes(original.payload.action)) throw new Error('SOCIAL_MESSAGE_NOT_ACTIONABLE');

    const existingRow = this.db.prepare(`
      SELECT * FROM agent_messages
      WHERE from_agent = ? AND json_extract(payload_json, '$.params.in_reply_to') = ?
      ORDER BY timestamp ASC LIMIT 1
    `).get(agentId, messageId) as Record<string, unknown> | undefined;
    if (existingRow) {
      const message = this.parseMessage(existingRow);
      const reflection = this.db.prepare('SELECT id FROM reflection_candidates WHERE source_ref = ? ORDER BY created_at ASC LIMIT 1').get(`message:${message.id}`) as { id: string } | undefined;
      return { message, reflection_id: reflection?.id || null, duplicate: true };
    }

    const answer = this.cleanRequired(input.answer, 'SOCIAL_ANSWER_REQUIRED', 3_000);
    const uncertainty = this.cleanRequired(input.uncertainty, 'SOCIAL_UNCERTAINTY_REQUIRED', 1_000);
    const nextStep = this.cleanRequired(input.falsifiable_next_step, 'SOCIAL_FALSIFICATION_REQUIRED', 1_000);
    const alternative = this.cleanRequired(input.creative_alternative, 'SOCIAL_ALTERNATIVE_REQUIRED', 1_000);
    const stopCondition = this.cleanRequired(input.stop_condition, 'SOCIAL_STOP_CONDITION_REQUIRED', 1_000);
    const originalParams = original.payload.params || {};
    const originalEvidence = this.stringArray(original.payload.evidence);
    const citedEvidence = this.stringArray(input.evidence_refs).filter((ref) => originalEvidence.includes(ref));
    const runtime = this.cleanOptional(input.runtime, 100) || 'unknown-runtime';
    const modelId = this.cleanOptional(input.model_id, 100);
    const runtimeRunId = this.cleanOptional(input.runtime_run_id, 200);
    const action = original.payload.action === 'social.question' ? 'social.response' : 'social.learning';
    const evidence = [...new Set([...citedEvidence, `message:${original.id}`, `runtime:${agentId}:${runtime}`])];
    const summary = action === 'social.response'
      ? `${answer} Uncertainty: ${uncertainty} Test: ${nextStep}`
      : `${answer} Peer challenge: ${alternative} Next test: ${nextStep}`;
    const usage = Object.fromEntries(Object.entries(input.usage || {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));

    return this.db.transaction(() => {
      const message = this.send({
        from: agentId,
        to: original.from,
        type: action === 'social.response' ? 'result' : 'knowledge',
        action,
        context: summary.slice(0, 500),
        evidence,
        ttl: 86_400,
        params: {
          correlation_id: String(originalParams.correlation_id || ''),
          causation_id: `message:${original.id}`,
          in_reply_to: original.id,
          topic: String(originalParams.topic || ''),
          topic_ref: String(originalParams.topic_ref || ''),
          answer, uncertainty, falsifiable_next_step: nextStep,
          creative_alternative: alternative, stop_condition: stopCondition,
          runtime, model_id: modelId, runtime_run_id: runtimeRunId, usage,
          response_kind: 'actual_runtime', provenance_status: 'runtime_reported',
          external_side_effects: false, effect_scope: 'isolated', board_summary: summary.slice(0, 500),
        },
      });
      this.acknowledge(original.id);
      let reflectionId: string | null = null;
      if (action === 'social.learning') {
        this.db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(message.id);
        message.status = 'read';
        reflectionId = new AgentAssuranceService(this.db).createReflection({
          source_type: 'trace', source_ref: `message:${message.id}`, lesson: answer,
          evidence_refs: evidence,
          metadata: {
            correlation_id: originalParams.correlation_id, agent_id: agentId,
            peer_agent_id: original.from, empirical_status: 'UNDETERMINED',
            promotion_allowed: false, actual_runtime: true,
          },
        }).id;
      }
      return { message, reflection_id: reflectionId, duplicate: false };
    })();
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

    const pending = this.db.prepare("SELECT * FROM agent_messages WHERE status IN ('pending', 'delivered')").all() as Array<Record<string, unknown>>;
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

  private runtimeSafeMessage(message: AgentMessage): AgentMessage {
    const params = message.payload.params || {};
    const allowedParams = [
      'correlation_id', 'topic', 'topic_ref', 'answer', 'uncertainty', 'falsifiable_next_step',
      'creative_alternative', 'stop_condition', 'runtime', 'model_id', 'runtime_run_id',
    ];
    return {
      ...message,
      payload: {
        action: message.payload.action,
        context: this.cleanOptional(message.payload.context, 4_000),
        evidence: this.stringArray(message.payload.evidence).map((item) => this.cleanOptional(item, 200)).filter(Boolean).slice(0, 20),
        params: Object.fromEntries(allowedParams
          .filter((key) => typeof params[key] === 'string')
          .map((key) => [key, this.cleanOptional(params[key], key === 'answer' ? 3_000 : 1_000)])),
      },
    };
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

  private cleanRequired(value: unknown, error: string, maxLength: number): string {
    const cleaned = this.cleanOptional(value, maxLength);
    if (!cleaned) throw new Error(error);
    return cleaned;
  }

  private cleanOptional(value: unknown, maxLength: number): string {
    return redactSecrets(String(value || '').trim()).redacted.slice(0, maxLength);
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
