import type { Database } from 'better-sqlite3';
import { redactSecrets } from './secret-patterns';

export type InteractionEffectScope = 'simulated' | 'isolated' | 'production';

export interface AgentInteractionRecord {
  id: string;
  timestamp: string;
  correlation_id: string | null;
  causation_id: string | null;
  actor: { type: string; id: string; role: string | null; runtime: string | null; model: string | null };
  action: string;
  target: { type: string; id: string } | null;
  capability_id: string | null;
  decision: string | null;
  status: string;
  evidence_refs: string[];
  effect_scope: InteractionEffectScope;
  source: string;
  summary: string;
}

export interface AgentInteractionFilter {
  agent_id?: string;
  correlation_id?: string;
  status?: string;
  source?: string;
  limit?: number;
}

export class AgentInteractionLedgerService {
  constructor(private readonly db: Database) {}

  list(filter: AgentInteractionFilter = {}): AgentInteractionRecord[] {
    const limit = Math.max(1, Math.min(Number(filter.limit || 100), 500));
    const fetchLimit = Math.min(1000, limit * 3);
    const interactions = [
      ...this.messages(fetchLimit),
      ...this.agentMessages(fetchLimit),
      ...this.leases(fetchLimit),
      ...this.spawns(fetchLimit),
      ...this.traceSpans(fetchLimit),
      ...this.decisions(fetchLimit),
      ...this.evidenceEdges(fetchLimit),
      ...this.claims(fetchLimit),
      ...this.specialistReviews(fetchLimit),
      ...this.reflections(fetchLimit),
      ...this.dreams(fetchLimit),
      ...this.specializations(fetchLimit),
      ...this.learningCycles(fetchLimit),
      ...this.executionEvents(fetchLimit),
      ...this.externalEvents(fetchLimit),
    ];
    return interactions
      .filter((item) => !filter.agent_id || item.actor.id === filter.agent_id || item.target?.id === filter.agent_id)
      .filter((item) => !filter.correlation_id || item.correlation_id === filter.correlation_id)
      .filter((item) => !filter.status || item.status === filter.status)
      .filter((item) => !filter.source || item.source === filter.source)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id))
      .slice(0, limit);
  }

  private messages(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, from_agent_id, to_agent_id, type, payload, read_at, created_at FROM messages ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.payload);
        return this.record({
          id: `messages:${row.id}`, timestamp: row.created_at, correlationId: this.string(metadata.correlation_id) || row.id,
          causationId: this.string(metadata.causation_id), actorId: row.from_agent_id, actorType: 'agent',
          actorRole: this.string(metadata.actor_role), runtime: this.string(metadata.runtime), model: this.string(metadata.model_id),
          action: `message.${row.type}`, targetType: 'agent', targetId: row.to_agent_id,
          capabilityId: this.string(metadata.capability_id), decision: null, status: row.read_at ? 'read' : 'unread',
          evidenceRefs: this.stringArray(metadata.evidence_refs), effectScope: this.scope(metadata.effect_scope, 'isolated'),
          source: 'messages', summary: `${row.from_agent_id} sent ${row.type} to ${row.to_agent_id}`,
        });
      });
  }

  private agentMessages(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, from_agent, to_agent, type, payload_json, status, timestamp FROM agent_messages ORDER BY timestamp DESC LIMIT ?`, limit)
      .map((row) => {
        const payload = this.object(row.payload_json);
        const params = this.object(payload.params);
        const social = this.string(payload.action)?.startsWith('social.') === true;
        const summary = social
          ? redactSecrets(this.string(params.board_summary) || this.string(payload.context) || `${row.from_agent} sent ${this.string(payload.action)} to ${row.to_agent}`).redacted.slice(0, 500)
          : `${row.from_agent} sent ${row.type} to ${row.to_agent}`;
        return this.record({
          id: `agent_messages:${row.id}`, timestamp: row.timestamp,
          correlationId: this.string(params.correlation_id) || row.id,
          causationId: this.string(params.causation_id) || this.string(params.reply_to),
          actorId: row.from_agent, actorType: 'agent', actorRole: social && params.facilitated_by ? 'facilitated_peer' : social ? 'peer' : null,
          runtime: this.string(params.runtime), model: this.string(params.model_id),
          action: social ? this.string(payload.action)! : `message.${row.type}`,
          targetType: 'agent', targetId: row.to_agent,
          capabilityId: this.string(params.capability_id), decision: null, status: row.status,
          evidenceRefs: this.stringArray(payload.evidence),
          effectScope: social ? 'isolated' : this.scope(params.effect_scope, 'isolated'), source: 'agent_messages', summary,
        });
      });
  }

  private leases(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, loop_run_id, role, runtime, status, capability_id, parent_lease_id, spawned_by_agent_id, metadata, created_at, updated_at FROM worker_leases ORDER BY updated_at DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.metadata);
        const actorId = this.string(metadata.agent_id) || row.spawned_by_agent_id || `lease:${row.id}`;
        return this.record({
          id: `worker_leases:${row.id}`, timestamp: row.updated_at || row.created_at, correlationId: row.loop_run_id,
          causationId: row.parent_lease_id, actorId, actorType: row.spawned_by_agent_id || metadata.agent_id ? 'agent' : 'lease',
          actorRole: row.role, runtime: row.runtime, model: this.string(metadata.model_id) || this.string(metadata.model),
          action: `lease.${row.status}`, targetType: 'loop', targetId: row.loop_run_id,
          capabilityId: row.capability_id, decision: this.string(metadata.authorization_decision), status: row.status,
          evidenceRefs: this.evidence(metadata), effectScope: this.scope(metadata.effect_scope, 'isolated'), source: 'worker_leases',
          summary: `${row.role} lease ${row.id} is ${row.status}`,
        });
      });
  }

  private spawns(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, spawn_tree_id, parent_lease_id, child_lease_id, requested_by_lease_id, runtime, requested_role, status, reject_reason, created_at FROM sub_agent_spawns ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => this.record({
        id: `sub_agent_spawns:${row.id}`, timestamp: row.created_at, correlationId: row.spawn_tree_id,
        causationId: row.parent_lease_id, actorId: row.requested_by_lease_id, actorType: 'lease', actorRole: 'delegator',
        runtime: row.runtime, model: null, action: 'agent.spawn', targetType: row.child_lease_id ? 'lease' : 'spawn_request',
        targetId: row.child_lease_id || row.id, capabilityId: null, decision: row.reject_reason ? 'denied' : 'allowed',
        status: row.status, evidenceRefs: [`spawn:${row.id}`], effectScope: 'isolated', source: 'sub_agent_spawns',
        summary: `${row.requested_by_lease_id} requested ${row.requested_role} via ${row.runtime}: ${row.status}`,
      }));
  }

  private traceSpans(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, trace_id, parent_span_id, loop_run_id, work_item_id, span_type, name, status, evidence_ref, metadata, started_at, ended_at, created_at FROM agent_trace_spans ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.metadata);
        return this.record({
          id: `agent_trace_spans:${row.id}`, timestamp: row.ended_at || row.started_at || row.created_at,
          correlationId: row.trace_id, causationId: row.parent_span_id, actorId: this.string(metadata.agent_id) || `trace:${row.trace_id}`,
          actorType: this.string(metadata.agent_id) ? 'agent' : 'trace', actorRole: row.span_type,
          runtime: this.string(metadata.runtime), model: this.string(metadata.model_id), action: `trace.${row.name}`,
          targetType: row.work_item_id ? 'work_item' : 'loop', targetId: row.work_item_id || row.loop_run_id,
          capabilityId: this.string(metadata.capability_id), decision: this.string(metadata.decision), status: row.status,
          evidenceRefs: [row.evidence_ref, ...this.stringArray(metadata.evidence_refs)].filter(Boolean),
          effectScope: this.scope(metadata.effect_scope, 'isolated'), source: 'agent_trace_spans', summary: `${row.span_type} ${row.name}: ${row.status}`,
        });
      });
  }

  private decisions(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, mission_id, task_id, decision_type, decision, actor, evidence_refs_json, gate_refs_json, blocked_reasons_json, metadata, created_at FROM swarm_decisions ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.metadata);
        const blocked = this.stringArray(row.blocked_reasons_json);
        return this.record({
          id: `swarm_decisions:${row.id}`, timestamp: row.created_at, correlationId: row.mission_id || row.task_id || this.string(metadata.correlation_id),
          causationId: this.string(metadata.causation_id), actorId: row.actor, actorType: 'actor', actorRole: this.string(metadata.role),
          runtime: this.string(metadata.runtime), model: this.string(metadata.model_id), action: `decision.${row.decision_type}`,
          targetType: row.task_id ? 'task' : row.mission_id ? 'mission' : this.string(metadata.interaction_id) ? 'interaction' : 'record',
          targetId: row.task_id || row.mission_id || this.string(metadata.interaction_id), capabilityId: this.string(metadata.capability_id),
          decision: row.decision, status: blocked.length ? 'blocked' : 'recorded',
          evidenceRefs: [...this.stringArray(row.evidence_refs_json), ...this.stringArray(row.gate_refs_json)],
          effectScope: this.scope(metadata.effect_scope, 'isolated'), source: 'swarm_decisions', summary: `${row.actor} decided ${row.decision}`,
        });
      });
  }

  private evidenceEdges(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, from_ref, to_ref, relation, metadata, created_at FROM swarm_evidence_edges ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.metadata);
        return this.record({
          id: `swarm_evidence_edges:${row.id}`, timestamp: row.created_at, correlationId: this.string(metadata.correlation_id),
          causationId: this.string(metadata.causation_id), actorId: row.from_ref, actorType: 'evidence_ref', actorRole: null,
          runtime: null, model: null, action: `evidence.${row.relation}`, targetType: 'evidence_ref', targetId: row.to_ref,
          capabilityId: this.string(metadata.capability_id), decision: null, status: 'recorded', evidenceRefs: [row.from_ref, row.to_ref],
          effectScope: this.scope(metadata.effect_scope, 'isolated'), source: 'swarm_evidence_edges', summary: `${row.from_ref} ${row.relation} ${row.to_ref}`,
        });
      });
  }

  private claims(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, claim_type, predicate, subject_ref, status, confidence, evidence_refs_json, created_from, metadata, created_at FROM swarm_claims ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.metadata);
        return this.record({
          id: `swarm_claims:${row.id}`, timestamp: row.created_at, correlationId: this.string(metadata.provenance_run) || row.id,
          causationId: this.string(metadata.causation_id), actorId: row.created_from, actorType: 'agent', actorRole: row.claim_type,
          runtime: this.string(metadata.runtime), model: this.string(metadata.model_id), action: `claim.${row.predicate || row.claim_type}`,
          targetType: 'subject', targetId: row.subject_ref, capabilityId: this.string(metadata.capability_id),
          decision: null, status: row.status, evidenceRefs: this.stringArray(row.evidence_refs_json),
          effectScope: this.scope(metadata.effect_scope, 'isolated'), source: 'swarm_claims',
          summary: `${row.created_from} recorded ${row.predicate || row.claim_type} about ${row.subject_ref} (confidence ${Number(row.confidence).toFixed(2)})`,
        });
      });
  }

  private specialistReviews(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, panel_id, specialist_id, stance, confidence, evidence_refs_json, reviewer_actor, status, created_at FROM specialist_reviews ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => this.record({
        id: `specialist_reviews:${row.id}`, timestamp: row.created_at, correlationId: row.panel_id, causationId: null,
        actorId: row.reviewer_actor || row.specialist_id, actorType: 'agent', actorRole: row.specialist_id,
        runtime: null, model: null, action: 'evaluation.review', targetType: 'panel', targetId: row.panel_id,
        capabilityId: null, decision: row.stance, status: row.status,
        evidenceRefs: this.stringArray(row.evidence_refs_json), effectScope: 'isolated', source: 'specialist_reviews',
        summary: `${row.reviewer_actor || row.specialist_id} reviewed ${row.panel_id}: ${row.stance} (confidence ${Number(row.confidence).toFixed(2)})`,
      }));
  }

  private reflections(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, loop_run_id, lessons_learned_json, proposed_improvements_json, created_at FROM reflections ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const lessons = this.stringArray(row.lessons_learned_json);
        const improvements = this.stringArray(row.proposed_improvements_json);
        return this.record({
          id: `reflections:${row.id}`, timestamp: row.created_at, correlationId: row.loop_run_id, causationId: null,
          actorId: 'continuous-learning-loop', actorType: 'system', actorRole: 'reflector', runtime: null, model: null,
          action: 'learning.reflection', targetType: 'loop', targetId: row.loop_run_id, capabilityId: null,
          decision: improvements.length ? 'improvement_proposed' : null, status: 'recorded', evidenceRefs: [`reflection:${row.id}`],
          effectScope: 'isolated', source: 'reflections', summary: `Reflection recorded ${lessons.length} lesson(s) and ${improvements.length} improvement proposal(s)`,
        });
      });
  }

  private dreams(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, capability_id, kind, score, status, created_at FROM dream_opportunities ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => this.record({
        id: `dream_opportunities:${row.id}`, timestamp: row.created_at, correlationId: row.id, causationId: null,
        actorId: 'dream-cycle', actorType: 'system', actorRole: 'creative-proposer', runtime: null, model: null,
        action: `alternative.${row.kind}`, targetType: 'capability', targetId: row.capability_id, capabilityId: row.capability_id,
        decision: null, status: row.status, evidenceRefs: [`dream:${row.id}`], effectScope: 'isolated', source: 'dream_opportunities',
        summary: `Dream cycle proposed ${row.kind} for ${row.capability_id} (score ${Number(row.score).toFixed(3)})`,
      }));
  }

  private specializations(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, agent_id, domain, sub_domain, n_runs, success_rate, status, last_activity FROM agent_specializations ORDER BY last_activity DESC LIMIT ?`, limit)
      .map((row) => this.record({
        id: `agent_specializations:${row.id}`, timestamp: row.last_activity, correlationId: null, causationId: null,
        actorId: row.agent_id, actorType: 'agent', actorRole: 'specialist', runtime: null, model: null,
        action: `specialization.${row.status}`, targetType: 'domain', targetId: row.domain, capabilityId: row.domain,
        decision: row.status, status: row.status, evidenceRefs: [`specialization:${row.id}`], effectScope: 'isolated', source: 'agent_specializations',
        summary: `${row.agent_id} ${row.status} in ${row.domain}/${row.sub_domain} after ${row.n_runs} run(s), success ${Number(row.success_rate).toFixed(2)}`,
      }));
  }

  private learningCycles(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, result_json, created_at FROM learning_cycles ORDER BY created_at DESC LIMIT ?`, limit)
      .map((row) => {
        const result = this.object(row.result_json);
        return this.record({
          id: `learning_cycles:${row.id}`, timestamp: this.string(result.timestamp) || row.created_at, correlationId: row.id, causationId: null,
          actorId: this.string(result.producer) || 'continuous-learning-loop', actorType: 'system', actorRole: 'learner', runtime: null, model: null,
          action: 'learning.cycle', targetType: 'evidence', targetId: row.id, capabilityId: null, decision: null, status: 'recorded',
          evidenceRefs: [`learning-cycle:${row.id}`], effectScope: 'isolated', source: 'learning_cycles',
          summary: `Learning cycle ingested ${Number(result.episodesIngested || 0)} episode(s), reflected on ${Number(result.reflectionsGenerated || 0)} run(s), proposed ${Number(result.proposalsGenerated || 0)} improvement(s), and opened ${Number(result.socialExchangesStarted || 0)} peer question(s)`,
        });
      });
  }

  private executionEvents(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, task_id, event_type, timestamp, level, tool_name, tool_error, approval_id, artifact_id, metadata FROM execution_events ORDER BY timestamp DESC LIMIT ?`, limit)
      .map((row) => {
        const metadata = this.object(row.metadata);
        return this.record({
          id: `execution_events:${row.id}`, timestamp: row.timestamp, correlationId: row.task_id,
          causationId: this.string(metadata.causation_id), actorId: this.string(metadata.agent_id) || 'execution-engine', actorType: 'agent',
          actorRole: this.string(metadata.role), runtime: this.string(metadata.runtime), model: this.string(metadata.model_id),
          action: row.tool_name ? 'tool.invocation' : `execution.${row.event_type}`, targetType: row.tool_name ? 'tool' : 'task',
          targetId: row.tool_name || row.task_id, capabilityId: this.string(metadata.capability_id),
          decision: row.approval_id ? 'approved' : this.string(metadata.authorization_decision), status: row.tool_error || row.level === 'error' ? 'error' : 'recorded',
          evidenceRefs: [`task:${row.task_id}`, row.approval_id && `approval:${row.approval_id}`, row.artifact_id && `artifact:${row.artifact_id}`, ...this.evidence(metadata)].filter(Boolean),
          effectScope: this.scope(metadata.effect_scope, 'production'), source: 'execution_events',
          summary: row.tool_name ? `${this.string(metadata.agent_id) || 'execution-engine'} invoked ${row.tool_name}` : `${row.event_type} for ${row.task_id}`,
        });
      });
  }

  private externalEvents(limit: number): AgentInteractionRecord[] {
    return this.query(`SELECT id, event_type, source, correlation_id, causation_id, aggregate_id, occurred_at, payload FROM external_events ORDER BY occurred_at DESC LIMIT ?`, limit)
      .map((row) => {
        const payload = this.object(row.payload);
        return this.record({
          id: `external_events:${row.id}`, timestamp: row.occurred_at, correlationId: row.correlation_id,
          causationId: row.causation_id, actorId: row.source, actorType: 'system', actorRole: null,
          runtime: this.string(payload.runtime_identity), model: this.string(payload.model_id), action: row.event_type,
          targetType: this.string(payload.subject_type) || 'aggregate', targetId: this.string(payload.subject_id) || row.aggregate_id,
          capabilityId: this.string(payload.capability_id), decision: this.string(payload.causal_status), status: 'observed',
          evidenceRefs: [`external-event:${row.id}`, ...this.stringArray(payload.evidence_refs)],
          effectScope: row.event_type.startsWith('worldlab.') || row.source.includes('worldlab') || payload.exploratory === true
            ? 'simulated' : this.scope(payload.effect_scope, 'isolated'), source: 'external_events',
          summary: `${row.source} emitted ${row.event_type}`,
        });
      });
  }

  private query(sql: string, limit: number): any[] {
    try { return this.db.prepare(sql).all(limit) as any[]; } catch { return []; }
  }

  private record(input: {
    id: string; timestamp: unknown; correlationId: unknown; causationId: unknown; actorId: unknown; actorType: string;
    actorRole: unknown; runtime: unknown; model: unknown; action: string; targetType: string; targetId: unknown;
    capabilityId: unknown; decision: unknown; status: string; evidenceRefs: unknown[]; effectScope: InteractionEffectScope;
    source: string; summary: string;
  }): AgentInteractionRecord {
    return {
      id: input.id,
      timestamp: this.timestamp(input.timestamp),
      correlation_id: this.string(input.correlationId),
      causation_id: this.string(input.causationId),
      actor: { type: input.actorType, id: this.string(input.actorId) || 'unknown', role: this.string(input.actorRole), runtime: this.string(input.runtime), model: this.string(input.model) },
      action: input.action,
      target: this.string(input.targetId) ? { type: input.targetType, id: this.string(input.targetId)! } : null,
      capability_id: this.string(input.capabilityId),
      decision: this.string(input.decision),
      status: input.status,
      evidence_refs: [...new Set(input.evidenceRefs.map((value) => this.string(value)).filter((value): value is string => Boolean(value)))],
      effect_scope: input.effectScope,
      source: input.source,
      summary: input.summary,
    };
  }

  private evidence(metadata: Record<string, unknown>): string[] {
    return [
      ...this.stringArray(metadata.evidence_refs),
      this.string(metadata.stdout_path), this.string(metadata.stderr_path), this.string(metadata.manifest_ref),
    ].filter((value): value is string => Boolean(value));
  }

  private object(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }

  private stringArray(value: unknown): string[] {
    const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
    return Array.isArray(parsed) ? parsed.map((item) => this.string(item)).filter((item): item is string => Boolean(item)) : [];
  }

  private string(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private timestamp(value: unknown): string {
    const raw = this.string(value) || new Date(0).toISOString();
    const parsed = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
  }

  private scope(value: unknown, fallback: InteractionEffectScope): InteractionEffectScope {
    return ['simulated', 'isolated', 'production'].includes(String(value)) ? String(value) as InteractionEffectScope : fallback;
  }
}
