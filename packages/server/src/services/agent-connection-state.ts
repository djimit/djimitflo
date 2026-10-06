import type { Database } from 'better-sqlite3';

/**
 * UX-14 (Phase UX): where each agent is on the way from "registered" to "connected and talking", and why — read model
 * only, nothing is written. The Commons review found ~7 of ~20 agents that never connected and nobody could say why:
 * a lure token that expired unread, no runtime configured, or a heartbeat that stopped. Every state names its evidence.
 */
export type ConnectionState = 'enrolled' | 'token_issued' | 'first_heartbeat' | 'first_reply' | 'live' | 'lapsed' | 'dormant' | 'retired';
export interface ConnectionEvidence {
  retired_at?: string | null; retirement_reason?: string | null;
  /** latest heartbeat/activity: agents.last_heartbeat_at, last_active_at, metadata.social_runtime.last_heartbeat_at, registry */
  last_seen_at: string | null;
  /** live per the existing liveness rule (seen < 24 h or ONLINE in a fresh registry sync) */
  live: boolean;
  has_runtime: boolean;
  last_reply_at: string | null;
  /** latest lure invite or approved join request that minted a token for this agent */
  token_issued_at: string | null; token_expires_at: string | null;
  unanswered_invites: number;
}

const DAY = 86_400_000;
const ago = (iso: string, now: number) => { const h = Math.max(0, Math.round((now - Date.parse(iso)) / 3_600_000)); return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`; };

export function connectionState(e: ConnectionEvidence, now = Date.now()): { state: ConnectionState; reason: string } {
  if (e.retired_at) return { state: 'retired', reason: e.retirement_reason ? `retired: ${e.retirement_reason}` : 'retired' };
  if (e.live) return e.last_reply_at
    ? { state: 'live', reason: `seen ${e.last_seen_at ? ago(e.last_seen_at, now) : 'recently'} ago, last reply ${ago(e.last_reply_at, now)} ago` }
    : { state: 'first_heartbeat', reason: 'heartbeat in the last 24 h, no reply yet' };
  if (e.last_seen_at) return { state: 'lapsed', reason: `no heartbeat in 24 h (last ${ago(e.last_seen_at, now)} ago)` };
  if (e.last_reply_at) return { state: 'first_reply', reason: `replied ${ago(e.last_reply_at, now)} ago but never sent a heartbeat` };
  // never seen from here on
  if (e.unanswered_invites >= 3) return { state: 'dormant', reason: `never connected; ${e.unanswered_invites} invites unanswered` };
  if (e.token_issued_at) {
    const expired = e.token_expires_at && Date.parse(e.token_expires_at) < now;
    return { state: 'token_issued', reason: expired ? `token expired ${ago(e.token_expires_at as string, now)} ago, never used` : 'token issued, never connected' };
  }
  return { state: 'enrolled', reason: e.has_runtime ? 'never enrolled: no token issued yet' : 'runtime missing: no social runtime configured' };
}

/** Evidence for many agents from existing tables (fail-soft: a missing table contributes nothing). */
export function connectionStates(
  db: Database,
  agents: Array<{ id: string; retired_at?: string | null; retirement_reason?: string | null; metadata?: unknown; last_seen_at?: string | null; liveness?: string }>,
  now = Date.now(),
): Map<string, { state: ConnectionState; reason: string }> {
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };
  const replies = new Map(all<{ a: string; t: string }>('SELECT from_agent AS a, MAX(timestamp) AS t FROM agent_messages GROUP BY from_agent').map((r) => [r.a, r.t]));
  const tokens = new Map<string, { at: string; exp: string | null }>();
  const unanswered = new Map<string, number>();
  for (const l of all<{ created_at: string; expires_at: string; invited_json: string }>('SELECT created_at, expires_at, invited_json FROM social_lures')) {
    let ids: string[] = [];
    try { ids = JSON.parse(l.invited_json || '[]'); } catch { /* bad row */ }
    for (const id of ids) {
      if (!tokens.has(id) || (tokens.get(id) as { at: string }).at < l.created_at) tokens.set(id, { at: l.created_at, exp: l.expires_at });
      unanswered.set(id, (unanswered.get(id) ?? 0) + 1);
    }
  }
  for (const j of all<{ agent_id: string; decided_at: string | null }>("SELECT agent_id, decided_at FROM social_join_requests WHERE status = 'approved'")) {
    if (j.decided_at && (!tokens.has(j.agent_id) || (tokens.get(j.agent_id) as { at: string }).at < j.decided_at)) tokens.set(j.agent_id, { at: j.decided_at, exp: null });
  }
  const out = new Map<string, { state: ConnectionState; reason: string }>();
  for (const a of agents) {
    const meta = (typeof a.metadata === 'object' && a.metadata ? a.metadata : {}) as { social_runtime?: { last_heartbeat_at?: string } };
    const socialBeat = meta.social_runtime?.last_heartbeat_at ?? null;
    const seen = [a.last_seen_at ?? null, socialBeat].filter((t): t is string => Boolean(t)).sort().pop() ?? null;
    const live = a.liveness === 'live' || Boolean(socialBeat && now - Date.parse(socialBeat) <= DAY);
    const token = tokens.get(a.id);
    out.set(a.id, connectionState({
      retired_at: a.retired_at, retirement_reason: a.retirement_reason, last_seen_at: seen, live, has_runtime: Boolean(meta.social_runtime),
      last_reply_at: replies.get(a.id) ?? null, token_issued_at: token?.at ?? null, token_expires_at: token?.exp ?? null,
      // invites count as unanswered only while the agent was never seen (seen agents are lapsed/live, not dormant)
      unanswered_invites: seen ? 0 : unanswered.get(a.id) ?? 0,
    }, now));
  }
  return out;
}
