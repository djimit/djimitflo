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
import { SelfImprovementService } from './self-improvement-service';
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
  interest?: string;
  ecosystem_component?: string;
  proposed_improvement?: string;
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

export interface SocialMessage {
  id: string;
  from: string;
  to: string;
  action: 'social.question' | 'social.response' | 'social.learning';
  timestamp: string;
  status: AgentMessage['status'];
  reply_to: string | null;
  text: string;
  evidence: string[];
  answer: string | null;
  uncertainty: string | null;
  falsifiable_next_step: string | null;
  creative_alternative: string | null;
  stop_condition: string | null;
  runtime: string | null;
  model_id: string | null;
  reflection_id: string | null;
  reflection_status: string | null;
  interest: string | null;
  ecosystem_component: string | null;
  proposed_improvement: string | null;
  improvement_id: string | null;
  improvement_status: string | null;
  runtime_run_id: string | null;
  provenance_status: string | null;
}

export interface SocialThread {
  id: string;
  topic: string;
  topic_ref: string | null;
  participants: string[];
  stage: 'asked' | 'responding' | 'learned';
  started_at: string;
  last_activity_at: string;
  learnings: number;
  messages: SocialMessage[];
}

export interface SocialCommons {
  agents: Array<{
    id: string; name: string; status: string; capabilities: string[]; model: string;
    runtime: string | null; last_heartbeat_at: string | null; present: boolean;
  }>;
  threads: SocialThread[];
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
  socialize(cooldownMs = 6 * 3600_000, facilitatorTrigger: 'autonomous' | 'operator' = 'autonomous', participantIds?: string[]): SocializationResult {
    this.cleanup();
    const cutoff = new Date(Date.now() - Math.max(0, cooldownMs)).toISOString();
    const participantScope = participantIds ? JSON.stringify(participantIds) : null;
    const recent = this.db.prepare(`
      SELECT payload_json FROM agent_messages
      WHERE json_extract(payload_json, '$.action') = 'social.question' AND timestamp >= ? AND status <> 'expired'
        AND (? IS NULL OR to_agent IN (SELECT value FROM json_each(?)))
      ORDER BY timestamp DESC LIMIT 1
    `).get(cutoff, participantScope, participantScope) as { payload_json: string } | undefined;
    if (cooldownMs > 0 && recent) {
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
        AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))
      ORDER BY id ASC
    `).all(heartbeatCutoff, participantScope, participantScope) as Array<Record<string, unknown>>;
    if (agents.length < 2) return { status: 'skipped', correlation_id: null, topic: null, participants: [], messages: [], reason: 'insufficient_agents' };

    // Curiosity first: prefer peers that have not met yet, then the largest capability distance.
    const met = new Map<string, number>();
    for (const row of this.db.prepare(`
      SELECT from_agent, to_agent, COUNT(DISTINCT json_extract(payload_json, '$.thread_id')) AS n FROM agent_messages
      WHERE json_extract(payload_json, '$.action') = 'social.question' GROUP BY from_agent, to_agent
    `).all() as Array<{ from_agent: string; to_agent: string; n: number }>) {
      const key = [row.from_agent, row.to_agent].sort().join('\u0000');
      met.set(key, (met.get(key) || 0) + row.n);
    }
    // ponytail: O(n2) is clearer for the small registry; index pairings if the fleet grows beyond hundreds.
    let pair: [Record<string, unknown>, Record<string, unknown>] = [agents[0], agents[1]];
    let pairScore = -Infinity;
    for (let left = 0; left < agents.length; left += 1) for (let right = left + 1; right < agents.length; right += 1) {
      const leftCapabilities = this.capabilities(agents[left]);
      const rightCapabilities = this.capabilities(agents[right]);
      const distance = new Set([...leftCapabilities.filter((value) => !rightCapabilities.includes(value)), ...rightCapabilities.filter((value) => !leftCapabilities.includes(value))]).size;
      const familiarity = met.get([String(agents[left].id), String(agents[right].id)].sort().join('\u0000')) || 0;
      const score = distance - familiarity * 1_000;
      if (score > pairScore) { pair = [agents[left], agents[right]]; pairScore = score; }
    }

    // Agent interests are messages, not a second task queue. Discuss each once before recycling gaps.
    const interest = this.db.prepare(`
      SELECT m.id, m.payload_json FROM agent_messages m
      WHERE json_extract(m.payload_json, '$.action') IN ('social.response', 'social.learning')
        AND length(trim(COALESCE(json_extract(m.payload_json, '$.params.interest'), ''))) > 0
        AND m.from_agent IN (?, ?)
        AND NOT EXISTS (SELECT 1 FROM agent_messages q
          WHERE json_extract(q.payload_json, '$.action') = 'social.question'
            AND json_extract(q.payload_json, '$.params.topic_ref') = 'message:' || m.id)
      ORDER BY m.timestamp ASC, m.rowid ASC LIMIT 1
    `).get(String(pair[0].id), String(pair[1].id)) as { id: string; payload_json: string } | undefined;
    const interestParams = this.object(this.object(interest?.payload_json).params);
    const picked = interest ? null : this.pickTopic();
    const topic = interest ? this.cleanOptional(interestParams.interest, 1_000) : picked!.topic;
    const ecosystemComponent = this.cleanOptional(interestParams.ecosystem_component, 200);
    const ecosystemContext = 'Djimitflo: agent runtime/orchestration; Paperclip: governed work coordination; DjimitKBWiki: knowledge cockpit; Qdrant/GraphStore: memory and causality. Treat component roles as orientation, verify current functionality before proposing changes.';
    const topicRef = interest ? `message:${interest.id}` : picked!.topicRef;
    const evidence = interest ? [topicRef] : picked!.evidence;
    const correlationId = `social:${randomUUID()}`;
    const [first, second] = pair;
    const firstId = String(first.id);
    const secondId = String(second.id);
    const firstPerspective = this.uniquePerspective(first, second);
    const secondPerspective = this.uniquePerspective(second, first);
    const question = (from: string, to: string, context: string) => this.send({
      from, to, type: 'question', action: 'social.question', context, evidence, threadId: correlationId,
      epistemicRole: 'question', ttl: 86_400,
      params: { topic, topic_ref: topicRef, ecosystem_component: ecosystemComponent, ecosystem_context: ecosystemContext, effect_scope: 'isolated', facilitated_by: facilitatorTrigger === 'operator' ? 'operator-socialize-route' : 'continuous-learning-loop', board_summary: context },
      facilitatorCommit: process.env.DJIMITFLO_COMMIT_SHA || '',
      facilitatorTrigger,
    });
    const messages = this.db.transaction(() => [
      question(firstId, secondId, `How can your ${secondPerspective} perspective challenge "${topic}"? Share evidence, one uncertainty and a falsifiable next step.`),
      question(secondId, firstId, `What creative alternative would your ${firstPerspective} perspective test for "${topic}"? Build on or dispute the peer idea, suggest an interest for a future round, and include evidence and a stop condition.`),
    ])();
    return { status: 'started', correlation_id: correlationId, topic, participants: [firstId, secondId], messages, reason: null };
  }

  /**
   * Operator read-model for the Agent Commons UI: who is present and every
   * social thread (question -> response -> learning) grouped by thread_id.
   * Content was redacted on write, so this is a plain projection.
   */
  listSocialCommons(limit = 50): SocialCommons {
    const heartbeatCutoff = Date.now() - 20 * 60_000;
    const agents = (this.db.prepare(`
      SELECT * FROM agents
      WHERE json_extract(COALESCE(metadata, '{}'), '$.social_runtime.enabled') = 1
      ORDER BY id ASC
    `).all() as Array<Record<string, unknown>>).map((row) => {
      const social = this.object(this.object(row.metadata).social_runtime);
      const lastHeartbeat = this.string(social.last_heartbeat_at) || null;
      return {
        id: String(row.id), name: String(row.name || row.id), status: String(row.status),
        capabilities: this.capabilities(row), model: this.string(social.model_id) || this.string(row.model),
        runtime: this.string(social.runtime) || null, last_heartbeat_at: lastHeartbeat,
        present: !!lastHeartbeat && Date.parse(lastHeartbeat) >= heartbeatCutoff,
      };
    });

    const rows = this.db.prepare(`
      SELECT * FROM agent_messages
      WHERE json_extract(payload_json, '$.action') IN ('social.question', 'social.response', 'social.learning')
        AND json_type(payload_json, '$.thread_id') = 'text'
      ORDER BY timestamp ASC
    `).all() as Array<Record<string, unknown>>;
    const reflections = new Map((this.db.prepare(`
      SELECT id, source_ref, status FROM reflection_candidates WHERE source_type = 'trace' AND source_ref LIKE 'message:%'
    `).all() as Array<{ id: string; source_ref: string; status: string }>).map((row) => [row.source_ref, row]));

    const stageRank = { asked: 0, responding: 1, learned: 2 } as const;
    const threads = new Map<string, SocialThread>();
    for (const row of rows) {
      const message = this.messageFromRow(row);
      const threadId = this.string(message.payload.thread_id);
      const params = this.object(message.payload.params);
      const reflection = reflections.get(`message:${message.id}`);
      const improvement = this.string(params.improvement_id)
        ? this.db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(params.improvement_id) as { status: string } | undefined
        : undefined;
      const thread = threads.get(threadId) || {
        id: threadId, topic: this.string(params.topic) || 'cross-agent learning', topic_ref: this.string(params.topic_ref) || null,
        participants: [], stage: 'asked' as SocialThread['stage'], started_at: message.timestamp, last_activity_at: message.timestamp,
        learnings: 0, messages: [],
      };
      const messageStage: SocialThread['stage'] = message.payload.action === 'social.learning' ? 'learned' : message.payload.action === 'social.response' ? 'responding' : 'asked';
      if (stageRank[messageStage] > stageRank[thread.stage]) thread.stage = messageStage;
      thread.participants = [...new Set([...thread.participants, message.from, message.to])].sort();
      if (message.timestamp > thread.last_activity_at) thread.last_activity_at = message.timestamp;
      if (messageStage === 'learned') thread.learnings += 1;
      thread.messages.push({
        id: message.id, from: message.from, to: message.to, action: message.payload.action as SocialMessage['action'],
        timestamp: message.timestamp, status: message.status, reply_to: this.string(message.payload.reply_to) || null,
        text: this.string(message.payload.context), evidence: this.stringArray(message.payload.evidence),
        answer: this.string(params.answer) || null, uncertainty: this.string(params.uncertainty) || null,
        falsifiable_next_step: this.string(params.falsifiable_next_step) || null,
        creative_alternative: this.string(params.creative_alternative) || null,
        stop_condition: this.string(params.stop_condition) || null,
        runtime: this.string(params.runtime) || null, model_id: this.string(params.model_id) || null,
        reflection_id: reflection?.id || null, reflection_status: reflection?.status || null,
        interest: this.string(params.interest) || null, ecosystem_component: this.string(params.ecosystem_component) || null,
        proposed_improvement: this.string(params.proposed_improvement) || null, improvement_id: this.string(params.improvement_id) || null,
        improvement_status: improvement?.status || null, runtime_run_id: this.string(params.runtime_run_id) || null,
        provenance_status: this.string(params.provenance_status) || null,
      });
      threads.set(threadId, thread);
    }
    return {
      agents,
      threads: [...threads.values()].sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at)).slice(0, Math.max(1, limit)),
    };
  }

  /**
   * What the next round is about, in order of curiosity: an open knowledge gap,
   * then the newest candidate lesson nobody has challenged yet, then a rotating
   * ecosystem question so consecutive rounds do not repeat the same prompt.
   */
  private pickTopic(): { topic: string; topicRef: string; evidence: string[] } {
    const clean = (references: string[]) => references.map((reference) => this.cleanOptional(reference, 200)).filter(Boolean).slice(0, 20);
    const gap = this.db.prepare(`
      SELECT id, claim, evidence_refs_json FROM swarm_claims
      WHERE predicate = 'gap' AND status IN ('proposed', 'review_required', 'supported')
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; claim: string; evidence_refs_json: string } | undefined;
    if (gap) {
      const topicRef = `claim:${gap.id}`;
      return { topic: this.cleanOptional(gap.claim, 1_000), topicRef, evidence: clean([topicRef, ...this.stringArray(gap.evidence_refs_json)]) };
    }
    const lesson = this.db.prepare(`
      SELECT id, lesson FROM reflection_candidates
      WHERE status IN ('candidate', 'promoted')
        AND ('reflection:' || id) NOT IN (
          SELECT json_extract(payload_json, '$.params.topic_ref') FROM agent_messages
          WHERE json_extract(payload_json, '$.action') = 'social.question' AND json_type(payload_json, '$.params.topic_ref') = 'text'
        )
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; lesson: string } | undefined;
    if (lesson) {
      const topicRef = `reflection:${lesson.id}`;
      return { topic: this.cleanOptional(`Challenge this candidate lesson: ${lesson.lesson}`, 1_000), topicRef, evidence: [topicRef] };
    }
    // ponytail: static curiosity seeds; replace with OKF/knowledge-drift signals once those emit gap claims.
    const seeds = [
      'cross-agent learning in the Djimit ecosystem',
      'what evidence a Paperclip task must carry before an agent may act on it',
      'when a reflection candidate deserves promotion and who may decide',
      'which signals reveal an agent drifting from its declared capabilities',
      'how repeated roborev findings should turn into a reusable skill',
      'what makes a knowledge gap worth a peer exchange instead of a lookup',
      'explore a Djimit ecosystem component: propose a useful feature, challenge a peer assumption, or invent an experiment together',
    ];
    const rounds = (this.db.prepare("SELECT COUNT(DISTINCT json_extract(payload_json, '$.thread_id')) AS n FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.question'").get() as { n: number }).n;
    const index = rounds % seeds.length;
    return { topic: seeds[index], topicRef: index === 0 ? 'ecosystem:cross-agent-learning' : `ecosystem:curiosity-seed-${index}`, evidence: [index === 0 ? 'ecosystem:cross-agent-learning' : `ecosystem:curiosity-seed-${index}`] };
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
    const interest = this.cleanOptional(typeof input.interest === 'string' ? input.interest : '', 1_000);
    const ecosystemComponent = this.cleanOptional(typeof input.ecosystem_component === 'string' ? input.ecosystem_component : original.payload.params?.ecosystem_component, 200);
    const improvement = this.cleanOptional(typeof input.proposed_improvement === 'string' ? input.proposed_improvement : '', 2_000);
    if (improvement && !ecosystemComponent) throw new Error('SOCIAL_COMPONENT_REQUIRED');
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
        params: { topic: this.string(original.payload.params?.topic), topic_ref: this.string(original.payload.params?.topic_ref), ecosystem_context: this.string(original.payload.params?.ecosystem_context), interest, ecosystem_component: ecosystemComponent, proposed_improvement: improvement, answer, uncertainty, falsifiable_next_step: nextStep, creative_alternative: alternative, stop_condition: stopCondition, runtime, model_id: modelId, runtime_run_id: runtimeRunId, usage, response_kind: 'actual_runtime', provenance_status: 'runtime_reported', external_side_effects: false, effect_scope: 'isolated', board_summary: summary.slice(0, 500) } });
      this.acknowledge(original.id, agentId, this.cleanRequired(input.delivery_lease_token, 'SOCIAL_LEASE_REQUIRED', 200));
      let reflectionId: string | null = null;
      if (action === 'social.learning') {
        this.db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(message.id);
        message.status = 'read';
        reflectionId = new AgentAssuranceService(this.db).createReflection({ source_type: 'trace', source_ref: `message:${message.id}`, lesson: answer, evidence_refs: evidence, metadata: { correlation_id: threadId, agent_id: agentId, peer_agent_id: original.from, empirical_status: 'UNDETERMINED', promotion_allowed: false, actual_runtime: true, ecosystem_component: ecosystemComponent, falsifiable_next_step: nextStep, uncertainty, stop_condition: stopCondition } }).id;
        if (improvement) {
          const [proposal] = new SelfImprovementService(this.db).generateFromReflection({
            whatFailed: [], lessonsLearned: [`Unverified peer proposal: ${answer}`, `Uncertainty: ${uncertainty}`],
            proposedImprovements: [`${ecosystemComponent}: ${improvement}\nTest: ${nextStep}\nStop condition: ${stopCondition}`],
            reflectionId,
          }, true);
          if (proposal) {
            message.payload.params.improvement_id = proposal.id;
            this.db.prepare('UPDATE agent_messages SET payload_json = ? WHERE id = ?').run(JSON.stringify(message.payload), message.id);
          }
        }
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
    facilitatorCommit?: string;
    facilitatorTrigger?: 'autonomous' | 'operator';
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
    const { facilitator_commit: _untrustedFacilitatorCommit, facilitator_trigger: _untrustedFacilitatorTrigger, ...inputParams } = input.params || {};
    const facilitatorCommit = input.facilitatorCommit?.trim();
    if (facilitatorCommit && !/^[0-9a-f]{40}$/i.test(facilitatorCommit)) throw new Error('SOCIAL_FACILITATOR_COMMIT_INVALID');
    const params = { ...inputParams, ...(input.facilitatorCommit !== undefined ? { facilitator_commit: facilitatorCommit || '' } : {}), ...(input.facilitatorTrigger ? { facilitator_trigger: input.facilitatorTrigger } : {}) };
    const fingerprint = boardMessageFingerprint({
      from: input.from, to: input.to, type: input.type, priority: input.priority || 3,
      action: input.action, params, context: input.context,
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
        params,
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
    const allowedParams = ['interest', 'ecosystem_component', 'ecosystem_context', 'proposed_improvement', 'topic', 'topic_ref', 'answer', 'uncertainty', 'falsifiable_next_step', 'creative_alternative', 'stop_condition', 'runtime', 'model_id', 'runtime_run_id', 'facilitator_commit', 'facilitator_trigger'];
    return { ...message, payload: {
      action: message.payload.action,
      context: this.cleanOptional(message.payload.context, 4_000),
      evidence: this.stringArray(message.payload.evidence).map((item) => this.cleanOptional(item, 200)).filter(Boolean).slice(0, 20),
      thread_id: this.cleanOptional(message.payload.thread_id, 200), reply_to: this.cleanOptional(message.payload.reply_to, 200),
      epistemic_role: message.payload.epistemic_role,
      params: Object.fromEntries(allowedParams.filter((key) => typeof params[key] === 'string').map((key) => [key, key === 'facilitator_commit' && /^[0-9a-f]{40}$/i.test(String(params[key])) ? params[key] : this.cleanOptional(params[key], key === 'answer' ? 3_000 : 1_000)])),
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
