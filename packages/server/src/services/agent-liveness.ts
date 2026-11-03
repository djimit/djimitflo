/**
 * Plan I0: whether an agent is actually alive. `agents.status` is set once and never decays — prod 2026-09-27 showed
 * 23 of 24 agents 'active', several with a last heartbeat 74 days old — while the registry mirror (registry_agents)
 * knows which nodes are ONLINE right now. Live = seen in the last 24 h, or ONLINE in a registry sync of the last hour.
 */
export type Liveness = 'live' | 'stale' | 'unknown';
export interface RegistryNode { name: string; raw_json: string; synced_at: string }

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function agentLiveness(
  agent: { id: string; name?: string | null; last_heartbeat_at?: string | null; last_active_at?: string | null },
  registry: Map<string, RegistryNode>, now = Date.now(),
): { liveness: Liveness; last_seen_at: string | null; source: 'activity' | 'registry' | null } {
  const seen = [agent.last_heartbeat_at, agent.last_active_at].filter((t): t is string => Boolean(t)).sort().pop() ?? null;
  if (seen && now - Date.parse(seen) <= DAY) return { liveness: 'live', last_seen_at: seen, source: 'activity' };
  const node = registry.get(agent.id) ?? (agent.name ? registry.get(agent.name) : undefined);
  if (node && now - Date.parse(node.synced_at) <= HOUR) {
    let status = '';
    try { status = String((JSON.parse(node.raw_json) as { status?: unknown }).status ?? '').toUpperCase(); } catch { /* unreadable */ }
    if (status === 'ONLINE') return { liveness: 'live', last_seen_at: node.synced_at, source: 'registry' };
  }
  return { liveness: seen ? 'stale' : 'unknown', last_seen_at: seen, source: seen ? 'activity' : null };
}
