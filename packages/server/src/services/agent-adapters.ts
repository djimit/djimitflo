import { randomUUID } from 'crypto';

export interface TraceSpan {
  span_id: string; agent_id: string; agent_type: string; content: string;
  memory_type: 'operational_memory' | 'engineering_rule' | 'policy_rule';
  source_ref: string; metadata: Record<string, unknown>; created_at: string;
}

export function hermesAdapter(checkpoints: any[]): TraceSpan[] {
  return (checkpoints || []).map((cp: any) => ({
    span_id: randomUUID(), agent_id: cp.agent_id || 'hermes', agent_type: 'hermes',
    content: (cp.messages || []).filter((m: any) => m.role === 'assistant').slice(-3).map((m: any) => m.content).join('\n---\n').slice(0, 2000),
    memory_type: 'operational_memory' as const, source_ref: 'hermes:checkpoint:' + cp.session_id,
    metadata: { session_id: cp.session_id, outcome: cp.outcome }, created_at: cp.timestamp || new Date().toISOString(),
  })).filter(s => s.content.length > 0);
}

export function openclawAdapter(sessions: any[]): TraceSpan[] {
  return (sessions || []).map((s: any) => ({
    span_id: randomUUID(), agent_id: s.agent_id || 'openclaw', agent_type: 'openclaw',
    content: (s.transcript || []).filter((m: any) => m.role === 'assistant').slice(-5).map((m: any) => m.content).join('\n---\n').slice(0, 2000),
    memory_type: 'operational_memory' as const, source_ref: 'openclaw:session:' + s.session_id,
    metadata: { turns: s.transcript?.length, status: s.status }, created_at: s.transcript?.[s.transcript.length-1]?.timestamp || new Date().toISOString(),
  })).filter(s => s.content.length > 0);
}

export function deerflowAdapter(facts: any[]): TraceSpan[] {
  return (facts || []).map((f: any) => ({
    span_id: randomUUID(), agent_id: 'deerflow:' + (f.scope || 'unknown'), agent_type: 'deerflow',
    content: f.content, memory_type: 'engineering_rule' as const, source_ref: 'deerflow:fact:' + f.fact_id,
    metadata: { confidence: f.confidence, source: f.source, tags: f.tags }, created_at: f.created_at || new Date().toISOString(),
  }));
}

export function scallopAdapter(dreams: any[]): TraceSpan[] {
  return (dreams || []).map((d: any) => ({
    span_id: randomUUID(), agent_id: 'scallopbot', agent_type: 'scallopbot',
    content: d.dream_text?.slice(0, 2000), memory_type: 'operational_memory',
    source_ref: 'scallop:dream:' + d.cycle_id, metadata: { eval_score: d.eval_score, concepts: d.concepts },
    created_at: d.timestamp || new Date().toISOString(),
  }));
}

export function researchAgentAdapter(entries: any[]): TraceSpan[] {
  return (entries || []).map((e: any) => ({
    span_id: randomUUID(), agent_id: e.agent_id || 'research_agent', agent_type: 'research_agent',
    content: e.content, memory_type: e.memory_type === 'policy_rule' ? 'policy_rule' as const : e.memory_type === 'engineering_rule' ? 'engineering_rule' as const : 'operational_memory' as const,
    source_ref: 'research_agent:entry:' + e.id, metadata: { topic: e.topic, backfilled: true },
    created_at: e.created_at || new Date().toISOString(),
  }));
}

export function overwatchAdapter(reports: any[]): TraceSpan[] {
  return (reports || []).map((r: any) => ({
    span_id: randomUUID(), agent_id: 'overwatch:' + r.service_name, agent_type: 'overwatch',
    content: r.status + ': ' + r.details + ' (latency=' + r.latency_ms + 'ms)', memory_type: 'operational_memory',
    source_ref: 'overwatch:check:' + r.check_id, metadata: { service: r.service_name, status: r.status, latency_ms: r.latency_ms },
    created_at: r.checked_at || new Date().toISOString(),
  }));
}

export function adaptSpans(type: string, data: any[]): TraceSpan[] {
  switch (type) {
    case 'hermes': return hermesAdapter(data);
    case 'openclaw': return openclawAdapter(data);
    case 'deerflow': return deerflowAdapter(data);
    case 'scallop': return scallopAdapter(data);
    case 'research_agent': return researchAgentAdapter(data);
    case 'overwatch': return overwatchAdapter(data);
    default: return [];
  }
}
