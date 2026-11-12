import type { Database } from 'better-sqlite3';

/**
 * Plan I0: whether an agent is actually alive. `agents.status` is set once and never decays — prod 2026-09-27 showed
 * 23 of 24 agents 'active', several with a last heartbeat 74 days old — while the registry mirror (registry_agents)
 * knows which nodes are ONLINE right now. Live = seen in the last 24 h, or ONLINE in a registry sync of the last hour.
 *
 * Truth audit 2026-11-12: "seen" is evidence, not only the heartbeat column. The 8 imported fleet agents kept a
 * heartbeat frozen at 2026-07-14 and showed "lapsed 121 d" while hermes-workstation logged 48 outcomes in 30 d and its
 * host reported hermes-gateway running every minute. Seen = the latest of heartbeat, last_active, agent outcome
 * (skill_outcomes.agent_id) and task (tasks.agent_id); failing that, a matching component running on a fleet host that
 * checked in within the hour, or an ONLINE registry node. Every answer names its signal ("outcome 5 h ago").
 * This is the one "live agent" definition: /agents, /swarm, /swarm-resources and Mission Control all read it.
 */
export type Liveness = 'live' | 'stale' | 'unknown';
export type LivenessSource = 'heartbeat' | 'activity' | 'outcome' | 'task' | 'host_component' | 'registry';
export interface RegistryNode { name: string; raw_json: string; synced_at: string }
export interface FleetHost { host: string; last_seen: string; components: string[] }
export interface LivenessEvidence {
  registry: Map<string, RegistryNode>;
  /** agent_id → latest skill_outcomes.created_at */
  outcomes?: Map<string, string>;
  /** agent_id → latest tasks.updated_at */
  tasks?: Map<string, string>;
  hosts?: FleetHost[];
}
export interface AgentLivenessResult { liveness: Liveness; last_seen_at: string | null; source: LivenessSource | null; liveness_signal: string | null }
type LivenessAgent = { id: string; name?: string | null; agent_type?: string | null; last_heartbeat_at?: string | null; last_active_at?: string | null };

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** sqlite datetime('now') has no zone and is UTC; Date.parse would read it as local time */
const ms = (t: string) => Date.parse(/^\d{4}-\d\d-\d\d \d/.test(t) ? `${t.replace(' ', 'T')}Z` : t);
const ago = (t: string, now: number) => {
  const m = Math.max(0, Math.round((now - ms(t)) / 60_000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A component named after the agent type (hermes → user:hermes-gateway / launchd:ai.hermes.gateway) on a host that
 *  checked in within the hour; an id suffix after the type (hermes-macmini → macmini) pins the host. */
export function runningHostComponent(agent: LivenessAgent, hosts: FleetHost[], now = Date.now()): { host: string; component: string; last_seen: string } | null {
  if (!agent.agent_type) return null;
  const type = norm(agent.agent_type);
  if (!type) return null;
  const id = agent.id.toLowerCase();
  const hint = id.startsWith(agent.agent_type.toLowerCase()) ? norm(id.slice(agent.agent_type.length)) : '';
  for (const h of hosts) {
    if (!(now - ms(h.last_seen) <= HOUR)) continue;
    if (hint && !norm(h.host).includes(hint)) continue;
    // shortest match: user:openclaw-gateway rather than docker:openclaw-sbx-workspace-<hash>
    const component = h.components.filter((c) => norm(c.slice(c.indexOf(':') + 1)).includes(type)).sort((a, b) => a.length - b.length)[0];
    if (component) return { host: h.host, component, last_seen: h.last_seen };
  }
  return null;
}

export function agentLiveness(agent: LivenessAgent, evidence: LivenessEvidence | Map<string, RegistryNode>, now = Date.now()): AgentLivenessResult {
  const ev: LivenessEvidence = evidence instanceof Map ? { registry: evidence } : evidence;
  const signals: Array<[LivenessSource, string | null | undefined]> = [
    ['heartbeat', agent.last_heartbeat_at], ['activity', agent.last_active_at], ['outcome', ev.outcomes?.get(agent.id)], ['task', ev.tasks?.get(agent.id)],
  ];
  let best: [LivenessSource, string] | null = null;
  for (const [source, t] of signals) if (t && Number.isFinite(ms(t)) && (!best || ms(t) > ms(best[1]))) best = [source, t];
  if (best && now - ms(best[1]) <= DAY) return { liveness: 'live', last_seen_at: best[1], source: best[0], liveness_signal: `${best[0]} ${ago(best[1], now)} ago` };
  const running = runningHostComponent(agent, ev.hosts ?? [], now);
  if (running) return { liveness: 'live', last_seen_at: running.last_seen, source: 'host_component', liveness_signal: `host component running: ${running.component} on ${running.host}` };
  const node = ev.registry.get(agent.id) ?? (agent.name ? ev.registry.get(agent.name) : undefined);
  if (node && now - Date.parse(node.synced_at) <= HOUR) {
    let status = '';
    try { status = String((JSON.parse(node.raw_json) as { status?: unknown }).status ?? '').toUpperCase(); } catch { /* unreadable */ }
    if (status === 'ONLINE') return { liveness: 'live', last_seen_at: node.synced_at, source: 'registry', liveness_signal: 'registry node ONLINE' };
  }
  return best
    ? { liveness: 'stale', last_seen_at: best[1], source: best[0], liveness_signal: `last ${best[0]} ${ago(best[1], now)} ago` }
    : { liveness: 'unknown', last_seen_at: null, source: null, liveness_signal: null };
}

/** The evidence tables, read once per request (fail-soft: a missing table contributes nothing). */
export function livenessEvidence(db: Database): LivenessEvidence {
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };
  const latest = (sql: string) => new Map(all<{ a: string; t: string }>(sql).filter((r) => r.a && r.t).map((r) => [r.a, r.t]));
  return {
    registry: new Map(all<RegistryNode>('SELECT name, raw_json, synced_at FROM registry_agents').map((n) => [n.name, n])),
    outcomes: latest('SELECT agent_id AS a, MAX(created_at) AS t FROM skill_outcomes WHERE agent_id IS NOT NULL GROUP BY agent_id'),
    tasks: latest('SELECT agent_id AS a, MAX(updated_at) AS t FROM tasks WHERE agent_id IS NOT NULL GROUP BY agent_id'),
    hosts: all<{ host: string; last_seen: string; info_json: string }>('SELECT host, last_seen, info_json FROM fleet_hosts').map((h) => {
      let components: unknown = [];
      try { components = (JSON.parse(h.info_json || '{}') as { components?: unknown }).components; } catch { /* bad row */ }
      return { host: h.host, last_seen: h.last_seen, components: Array.isArray(components) ? components.filter((c): c is string => typeof c === 'string') : [] };
    }),
  };
}

/** Every agent row with its liveness — the shared input for any "live agents" count. */
export function agentsWithLiveness<T extends LivenessAgent>(db: Database, agents: T[], now = Date.now()): Array<T & AgentLivenessResult> {
  const evidence = livenessEvidence(db);
  return agents.map((a) => ({ ...a, ...agentLiveness(a, evidence, now) }));
}

/**
 * Truth audit 2026-11-12: agents.total_tasks/completed_tasks/failed_tasks are a frozen import (only POST/PATCH write
 * them) — opencode-maker showed 0 with 479 task rows, Overwatch 10000. Displayed counters are these 30-day aggregates
 * of tasks.agent_id (worker leases carry no agent id; each maker/checker lease has its task row) plus the agent's
 * outcomes; the stored columns are left untouched.
 */
export interface AgentCounters30d { window_days: 30; tasks: number; completed: number; failed: number; outcomes: number; outcomes_ok: number }
export function agentCounters30d(db: Database, now = Date.now()): Map<string, AgentCounters30d> {
  const since = new Date(now - 30 * DAY).toISOString();
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all(since) as T[]; } catch { return []; } };
  const out = new Map<string, AgentCounters30d>();
  const get = (id: string) => out.get(id) ?? (out.set(id, { window_days: 30, tasks: 0, completed: 0, failed: 0, outcomes: 0, outcomes_ok: 0 }).get(id) as AgentCounters30d);
  for (const r of all<{ a: string; n: number; c: number; f: number }>(`SELECT agent_id AS a, COUNT(*) AS n, SUM(status = 'completed') AS c, SUM(status = 'failed') AS f
    FROM tasks WHERE agent_id IS NOT NULL AND created_at >= ? GROUP BY agent_id`)) Object.assign(get(r.a), { tasks: r.n, completed: r.c ?? 0, failed: r.f ?? 0 });
  for (const r of all<{ a: string; n: number; ok: number }>(`SELECT agent_id AS a, COUNT(*) AS n, SUM(success) AS ok
    FROM skill_outcomes WHERE agent_id IS NOT NULL AND created_at >= ? GROUP BY agent_id`)) Object.assign(get(r.a), { outcomes: r.n, outcomes_ok: r.ok ?? 0 });
  return out;
}
