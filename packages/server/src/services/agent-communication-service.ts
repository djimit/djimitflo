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
import { AgentAssuranceService } from './agent-assurance-service';
import { redactSecrets } from './secret-patterns';

type MessageType = 'task' | 'result' | 'question' | 'alert' | 'handoff' | 'knowledge';
type Priority = 1 | 2 | 3 | 4 | 5; // 1=critical, 5=low
type EpistemicRole = BoardEpistemicRole;

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
    thread_id?: string;
    reply_to?: string;
    epistemic_role?: EpistemicRole;
  };
  timestamp: string;
  ttl: number;
  status: 'pending' | 'delivered' | 'read' | 'expired';
  deliveryLeaseToken?: string;
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
  delivery_lease_token?: string;
}

export interface SocialReplyResult {
  message: AgentMessage;
  reflection_id: string | null;
  duplicate: boolean;
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

  /** Open one bounded peer exchange between recently connected real runtimes. */
  socialize(cooldownMs = 6 * 3600_000): SocializationResult {
    this.cleanup();
    const cutoff = new Date(Date.now() - Math.max(0, cooldownMs)).toISOString();
    const recent = this.db.prepare(`
      SELECT payload_json FROM agent_messages
      WHERE json_extract(payload_json, '$.action') = 'social.question' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(cutoff) as { payload_json: string } | undefined;
    if (recent) {
      const payload = this.object(recent.payload_json);
      const params = this.object(payload.params);
      return { status: 'skipped', correlation_id: this.string(payload.thread_id) || null,
        topic: this.string(params.topic) || null, participants: [], messages: [], reason: 'cooldown_active' };
    }

    const heartbeatCutoff = new Date(Date.now() - 20 * 60_000).toISOString();
    const agents = this.db.prepare(`
      SELECT * FROM agents
      WHERE status IN ('active', 'idle')
        AND json_extract(COALESCE(metadata, '{}'), '$.social_runtime.enabled') = 1
        AND json_extract(COALESCE(metadata, '{}'), '$.social_runtime.last_heartbeat_at') >= ?
      ORDER BY id ASC
    `).all(heartbeatCutoff) as Array<Record<string, unknown>>;
    if (agents.length < 2) return { status: 'skipped', correlation_id: null, topic: null, participants: [], messages: [], reason: 'insufficient_agents' };

    // ponytail: O(n2) is clearer for the small registry; index pairings if the fleet grows beyond hundreds.
    let pair: [Record<string, unknown>, Record<string, unknown>] = [agents[0], agents[1]];
    let pairScore = -1;
    for (let left = 0; left < agents.length; left += 1) for (let right = left + 1; right < agents.length; right += 1) {
      const leftCapabilities = this.capabilities(agents[left]);
      const rightCapabilities = this.capabilities(agents[right]);
      const score = new Set([...leftCapabilities.filter((value) => !rightCapabilities.includes(value)), ...rightCapabilities.filter((value) => !leftCapabilities.includes(value))]).size;
      if (score > pairScore) { pair = [agents[left], agents[right]]; pairScore = score; }
    }

    const gap = this.db.prepare(`
      SELECT id, claim, evidence_refs_json FROM swarm_claims
      WHERE predicate = 'gap' AND status IN ('proposed', 'review_required', 'supported')
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; claim: string; evidence_refs_json: string } | undefined;
    const topic = this.cleanOptional(gap?.claim || 'cross-agent learning in the Djimit ecosystem', 1_000);
    const topicRef = gap ? `claim:${gap.id}` : 'ecosystem:cross-agent-learning';
    const evidence = (gap ? [topicRef, ...this.stringArray(gap.evidence_refs_json)] : [topicRef])
      .map((reference) => this.cleanOptional(reference, 200)).filter(Boolean).slice(0, 20);
    const correlationId = `social:${randomUUID()}`;
    const [first, second] = pair;
    const firstId = String(first.id);
    const secondId = String(second.id);
    const firstPerspective = this.uniquePerspective(first, second);
    const secondPerspective = this.uniquePerspective(second, first);
    const question = (from: string, to: string, context: string) => this.send({
      from, to, type: 'question', action: 'social.question', context, evidence, threadId: correlationId,
      epistemicRole: 'question', ttl: 86_400,
      params: { topic, topic_ref: topicRef, effect_scope: 'isolated', facilitated_by: 'continuous-learning-loop', board_summary: context },
    });
    const messages = this.db.transaction(() => [
      question(firstId, secondId, `How can your ${secondPerspective} perspective challenge "${topic}"? Share evidence, one uncertainty and a falsifiable next step.`),
      question(secondId, firstId, `What creative alternative would your ${firstPerspective} perspective test for "${topic}"? Include evidence and a stop condition.`),
    ])();
    return { status: 'started', correlation_id: correlationId, topic, participants: [firstId, secondId], messages, reason: null };
  }

  /** Record a signed runtime poller as eligible for future social rounds. */
  heartbeat(agentId: string, runtime: string, modelId?: string): { agent_id: string; status: 'active'; timestamp: string } {
    const row = this.db.prepare('SELECT id, status, metadata FROM agents WHERE id = ?').get(agentId) as { id: string; status: string; metadata: string | null } | undefined;
    if (!row) throw new Error('SOCIAL_AGENT_NOT_FOUND');
    if (!new Set(['active', 'idle']).has(row.status)) throw new Error(`SOCIAL_AGENT_NOT_ELIGIBLE: agent ${agentId} has status '${row.status}'`);
    const timestamp = new Date().toISOString();
    const metadata = this.object(row.metadata);
    metadata.social_runtime = { enabled: true, runtime: this.cleanRequired(runtime, 'SOCIAL_RUNTIME_REQUIRED', 100), model_id: this.cleanOptional(modelId, 100), last_heartbeat_at: timestamp, provenance_status: 'signed_runtime_poller' };
    this.db.prepare(`UPDATE agents SET status = 'active', metadata = ?, last_active_at = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'idle')`).run(JSON.stringify(metadata), timestamp, timestamp, agentId);
    return { agent_id: agentId, status: 'active', timestamp };
  }

  /** Claim only social work, leaving unrelated agent messages untouched. */
  receiveSocial(agentId: string, limit = 4): AgentMessage[] {
    this.cleanup();
    const now = Date.now();
    return this.db.transaction((max: number) => {
      const candidates = this.db.prepare(`SELECT * FROM agent_messages message
        WHERE message.to_agent = ? AND json_extract(message.payload_json, '$.action') IN ('social.question', 'social.response')
          AND json_type(message.payload_json, '$.thread_id') = 'text'
          AND (message.status = 'pending' OR (message.status = 'delivered' AND (message.delivery_lease_until <= ? OR message.delivery_lease_until IS NULL)))
          AND NOT EXISTS (SELECT 1 FROM agent_messages reply WHERE reply.from_agent = ? AND json_extract(reply.payload_json, '$.reply_to') = message.id)
        ORDER BY message.priority ASC, message.timestamp ASC LIMIT ?`).all(agentId, now, agentId, max) as Array<Record<string, unknown>>;
      const claimed: AgentMessage[] = [];
      const leaseUntil = now + 5 * 60_000;
      const deliver = this.db.prepare(`UPDATE agent_messages SET status = 'delivered', delivery_lease_until = ?, delivery_lease_token = ? WHERE id = ? AND to_agent = ? AND (status = 'pending' OR (status = 'delivered' AND (delivery_lease_until <= ? OR delivery_lease_until IS NULL)))`);
      for (const row of candidates) {
        const token = randomUUID();
        if (deliver.run(leaseUntil, token, row.id, agentId, now).changes === 1) claimed.push(this.runtimeSafeMessage({ ...this.messageFromRow(row), status: 'delivered', deliveryLeaseToken: token }));
      }
      return claimed;
    })(Math.max(1, Math.min(Number(limit) || 4, 10)));
  }

  /** Persist an isolated runtime reply or candidate learning; never promote it. */
  respondSocial(agentId: string, messageId: string, input: SocialRuntimeReply): SocialReplyResult {
    const originalRow = this.db.prepare('SELECT * FROM agent_messages WHERE id = ? AND to_agent = ?').get(messageId, agentId) as Record<string, unknown> | undefined;
    if (!originalRow) throw new Error('SOCIAL_MESSAGE_NOT_FOUND');
    const original = this.messageFromRow(originalRow);
    if (original.status === 'expired') throw new Error('SOCIAL_MESSAGE_EXPIRED');
    if (!['social.question', 'social.response'].includes(original.payload.action)) throw new Error('SOCIAL_MESSAGE_NOT_ACTIONABLE');
    const existing = this.db.prepare(`SELECT * FROM agent_messages WHERE from_agent = ? AND json_extract(payload_json, '$.reply_to') = ? ORDER BY timestamp ASC LIMIT 1`).get(agentId, messageId) as Record<string, unknown> | undefined;
    if (existing) {
      const message = this.messageFromRow(existing);
      const reflection = this.db.prepare('SELECT id FROM reflection_candidates WHERE source_ref = ? ORDER BY created_at ASC LIMIT 1').get(`message:${message.id}`) as { id: string } | undefined;
      return { message, reflection_id: reflection?.id || null, duplicate: true };
    }
    const answer = this.cleanRequired(input.answer, 'SOCIAL_ANSWER_REQUIRED', 3_000);
    const uncertainty = this.cleanRequired(input.uncertainty, 'SOCIAL_UNCERTAINTY_REQUIRED', 1_000);
    const nextStep = this.cleanRequired(input.falsifiable_next_step, 'SOCIAL_FALSIFICATION_REQUIRED', 1_000);
    const alternative = this.cleanRequired(input.creative_alternative, 'SOCIAL_ALTERNATIVE_REQUIRED', 1_000);
    const stopCondition = this.cleanRequired(input.stop_condition, 'SOCIAL_STOP_CONDITION_REQUIRED', 1_000);
    const originalEvidence = this.stringArray(original.payload.evidence);
    const citedEvidence = this.stringArray(input.evidence_refs).filter((ref) => originalEvidence.includes(ref));
    const runtime = this.cleanOptional(input.runtime, 100) || 'unknown-runtime';
    const modelId = this.cleanOptional(input.model_id, 100);
    const runtimeRunId = this.cleanOptional(input.runtime_run_id, 200);
    const threadId = this.cleanRequired(original.payload.thread_id, 'SOCIAL_THREAD_REQUIRED', 200);
    const action = original.payload.action === 'social.question' ? 'social.response' : 'social.learning';
    const evidence = [...new Set([...citedEvidence, `message:${original.id}`, `runtime:${agentId}:${runtime}`])];
    const summary = action === 'social.response' ? `${answer} Uncertainty: ${uncertainty} Test: ${nextStep}` : `${answer} Peer challenge: ${alternative} Next test: ${nextStep}`;
    const usage = Object.fromEntries(Object.entries(input.usage || {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)));
    return this.db.transaction(() => {
      const message = this.send({ from: agentId, to: original.from, type: action === 'social.response' ? 'result' : 'knowledge', action, context: summary.slice(0, 500), evidence, threadId, replyTo: original.id, epistemicRole: action === 'social.response' ? 'proposal' : 'outcome', ttl: 86_400,
        params: { topic: this.string(original.payload.params?.topic), answer, uncertainty, falsifiable_next_step: nextStep, creative_alternative: alternative, stop_condition: stopCondition, runtime, model_id: modelId, runtime_run_id: runtimeRunId, usage, response_kind: 'actual_runtime', provenance_status: 'runtime_reported', external_side_effects: false, effect_scope: 'isolated', board_summary: summary.slice(0, 500) } });
      this.acknowledge(original.id, agentId, this.cleanRequired(input.delivery_lease_token, 'SOCIAL_LEASE_REQUIRED', 200));
      let reflectionId: string | null = null;
      if (action === 'social.learning') {
        this.db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(message.id);
        message.status = 'read';
        reflectionId = new AgentAssuranceService(this.db).createReflection({ source_type: 'trace', source_ref: `message:${message.id}`, lesson: answer, evidence_refs: evidence, metadata: { correlation_id: threadId, agent_id: agentId, peer_agent_id: original.from, empirical_status: 'UNDETERMINED', promotion_allowed: false, actual_runtime: true } }).id;
      }
      return { message, reflection_id: reflectionId, duplicate: false };
    })();
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
    // Apply the same durable ownership boundary to fast replay and the
    // constraint-retry path. Backfilled rows in a losing store are not owners.
    return this.db.prepare(`
      SELECT id, from_agent, to_agent, type, priority, payload_json, timestamp, ttl, status
      FROM agent_messages WHERE from_agent = ? AND to_agent = ? AND type = ? AND idempotency_key = ?
        AND EXISTS (
          SELECT 1 FROM board_idempotency_keys AS owner
          WHERE owner.sender = agent_messages.from_agent AND owner.recipient = agent_messages.to_agent
            AND owner.message_type = agent_messages.type AND owner.idempotency_key = agent_messages.idempotency_key
            AND owner.store = 'agent_messages' AND owner.message_id = agent_messages.id
        )
    `).get(from, to, type, key) as any;
  }

  private runtimeSafeMessage(message: AgentMessage): AgentMessage {
    const params = message.payload.params || {};
    const allowedParams = ['topic', 'topic_ref', 'answer', 'uncertainty', 'falsifiable_next_step', 'creative_alternative', 'stop_condition', 'runtime', 'model_id', 'runtime_run_id'];
    return { ...message, payload: {
      action: message.payload.action,
      context: this.cleanOptional(message.payload.context, 4_000),
      evidence: this.stringArray(message.payload.evidence).map((item) => this.cleanOptional(item, 200)).filter(Boolean).slice(0, 20),
      thread_id: this.cleanOptional(message.payload.thread_id, 200), reply_to: this.cleanOptional(message.payload.reply_to, 200),
      epistemic_role: message.payload.epistemic_role,
      params: Object.fromEntries(allowedParams.filter((key) => typeof params[key] === 'string').map((key) => [key, this.cleanOptional(params[key], key === 'answer' ? 3_000 : 1_000)])),
    } };
  }

  private capabilities(agent: Record<string, unknown>): string[] { return this.stringArray(agent.capabilities ?? agent.capabilities_json); }

  private uniquePerspective(agent: Record<string, unknown>, peer: Record<string, unknown>): string {
    const peerCapabilities = this.capabilities(peer);
    return this.capabilities(agent).find((value) => !peerCapabilities.includes(value)) || String(agent.name || agent.id);
  }

  private object(value: unknown): Record<string, unknown> {
    try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
  }

  private string(value: unknown): string { return typeof value === 'string' ? value : ''; }

  private stringArray(value: unknown): string[] {
    try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : []; } catch { return []; }
  }

  private cleanRequired(value: unknown, error: string, maxLength: number): string {
    const cleaned = this.cleanOptional(value, maxLength); if (!cleaned) throw new Error(error); return cleaned;
  }

  private cleanOptional(value: unknown, maxLength: number): string { return redactSecrets(String(value || '').trim()).redacted.slice(0, maxLength); }

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
