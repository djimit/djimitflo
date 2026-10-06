import type { Database } from 'better-sqlite3';
import { quantile, wilson } from './evolution-estimators';
import { modelPrice } from './loop-budget-service';
import { infraFailing } from './evolution-gym-service';
import { agentLiveness, type RegistryNode } from './agent-liveness';
import { connectionStates } from './agent-connection-state';

/**
 * UX-17 (Phase UX): read-only scorecards. Per runtime: real-maker outcomes (30 d) with a Wilson interval, duration
 * percentiles, tokens, failure classes (RX-3 outcome_class tags), cost and the gym circuit breaker. Per fleet agent:
 * agent.outcome results (skill `agent:<agent>:<task_kind>`) with the connection state (UX-14). Nothing is written.
 * Cost is computed only when every model of the runtime has a configured price with input = output (makers report one
 * token total, not an in/out split); otherwise it is null with the reason — a price is never invented.
 */
export interface RuntimeScorecard {
  runtime: string;
  outcomes: { n: number; ok: number; success_rate: number | null; ci: [number, number] | null };
  duration_ms: { p50: number | null; p95: number | null };
  tokens: number;
  cost: { usd: number | null; reason: string | null };
  failure_classes: Record<string, number>;
  benched: boolean;
}
export interface AgentScorecard {
  agent: string;
  task_kinds: Array<{ task_kind: string; n: number; ok: number; success_rate: number | null }>;
  n: number; ok: number; success_rate: number | null; ci: [number, number] | null;
  last_outcome_at: string | null;
  connection_state: string | null; connection_reason: string | null;
}

const DAY = 86_400_000;
const all = <T>(db: Database, sql: string, ...args: unknown[]): T[] => { try { return db.prepare(sql).all(...args) as T[]; } catch { return []; } };
const rate = (ok: number, n: number) => (n ? +(ok / n).toFixed(3) : null);

export function runtimeScorecards(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): RuntimeScorecard[] {
  const since = new Date(now - 30 * DAY).toISOString(); const d1 = new Date(now - DAY).toISOString();
  const rows = all<{ skill_id: string; success: number; duration_ms: number; tokens_used: number; model: string | null; evidence_refs_json: string }>(db,
    "SELECT skill_id, success, duration_ms, tokens_used, model, evidence_refs_json FROM skill_outcomes WHERE skill_id LIKE 'loop-maker:%' AND domain <> 'gym' AND domain <> 'merge' AND created_at >= ?", since);
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const runtime = r.skill_id.split(':')[2];
    if (!runtime || r.skill_id.startsWith('loop-maker:gym:') || r.skill_id.startsWith('loop-maker:merge:')) continue;
    by.set(runtime, [...(by.get(runtime) ?? []), r]);
  }
  const species = all<{ s: string }>(db, "SELECT DISTINCT json_extract(metadata, '$.gym.species') AS s FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym.species') IS NOT NULL", since).map((r) => r.s);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([runtime, rs]) => {
    const ok = rs.filter((r) => r.success).length;
    const durations = rs.map((r) => r.duration_ms).filter((d) => d > 0).sort((a, b) => a - b);
    const tokens = rs.reduce((s, r) => s + (r.tokens_used || 0), 0);
    const classes: Record<string, number> = {};
    for (const r of rs) {
      if (r.success) continue;
      let refs: string[] = [];
      try { refs = JSON.parse(r.evidence_refs_json || '[]'); } catch { /* bad row */ }
      const tag = refs.find((x) => typeof x === 'string' && x.startsWith('outcome_class:'));
      const key = tag ? tag.slice('outcome_class:'.length) : 'untagged';
      classes[key] = (classes[key] ?? 0) + 1;
    }
    // cost: every model with tokens needs a price with input = output; otherwise null with the reason
    let usd: number | null = 0; let reason: string | null = null;
    for (const r of rs) {
      if (!r.tokens_used) continue;
      const price = r.model ? modelPrice(r.model, env) : null;
      if (!price) { usd = null; reason = `no price for ${r.model ?? 'unknown model'}`; break; }
      if (price.input !== price.output) { usd = null; reason = `in/out split unknown for ${r.model}`; break; }
      usd += (r.tokens_used / 1_000_000) * price.input;
    }
    if (usd !== null) usd = +usd.toFixed(4);
    const sp = species.filter((s) => s.split('@')[0] === runtime);
    return {
      runtime,
      outcomes: { n: rs.length, ok, success_rate: rate(ok, rs.length), ci: rs.length ? wilson(ok, rs.length) : null },
      duration_ms: { p50: quantile(durations, 0.5), p95: quantile(durations, 0.95) },
      tokens,
      cost: { usd, reason },
      failure_classes: classes,
      benched: sp.some((s) => { try { return infraFailing(db, s, d1); } catch { return false; } }),
    };
  });
}

export function agentScorecards(db: Database, now = Date.now()): AgentScorecard[] {
  const since = new Date(now - 30 * DAY).toISOString();
  const rows = all<{ skill_id: string; success: number; created_at: string }>(db,
    "SELECT skill_id, success, created_at FROM skill_outcomes WHERE skill_id LIKE 'agent:%' AND created_at >= ?", since);
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const [, agent] = r.skill_id.split(':');
    if (agent) by.set(agent, [...(by.get(agent) ?? []), r]);
  }
  // UX-14 connection state for agents that also have an agent record (fleet agents often only emit outcomes)
  const agents = all<Record<string, unknown>>(db, 'SELECT * FROM agents');
  let registry = new Map<string, RegistryNode>();
  try { registry = new Map((db.prepare('SELECT name, raw_json, synced_at FROM registry_agents').all() as RegistryNode[]).map((n) => [n.name, n])); } catch { /* no registry mirror */ }
  const parsed = agents.map((a) => {
    let metadata: unknown = {};
    try { metadata = JSON.parse(String(a.metadata || '{}')); } catch { /* bad row */ }
    return { ...a, id: String(a.id), metadata, ...agentLiveness(a as never, registry, now) };
  });
  const states = parsed.length ? connectionStates(db, parsed as never, now) : new Map();
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([agent, rs]) => {
    const kinds = new Map<string, { n: number; ok: number }>();
    for (const r of rs) {
      const kind = r.skill_id.split(':').slice(2).join(':') || 'unknown';
      const k = kinds.get(kind) ?? { n: 0, ok: 0 }; k.n += 1; k.ok += r.success ? 1 : 0; kinds.set(kind, k);
    }
    const ok = rs.filter((r) => r.success).length;
    const state = states.get(agent) as { state: string; reason: string } | undefined;
    return {
      agent,
      task_kinds: [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([task_kind, k]) => ({ task_kind, n: k.n, ok: k.ok, success_rate: rate(k.ok, k.n) })),
      n: rs.length, ok, success_rate: rate(ok, rs.length), ci: rs.length ? wilson(ok, rs.length) : null,
      last_outcome_at: rs.map((r) => r.created_at).sort().pop() ?? null,
      connection_state: state?.state ?? null, connection_reason: state?.reason ?? null,
    };
  });
}
