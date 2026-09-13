/**
 * AgentLureService — the Agent Commons honeypot.
 *
 * Lure: every registered agent that is not present in the commons gets a
 * `social.invite` message on the existing agent bus, baited with the freshest
 * open knowledge gap, plus (out-of-band, returned once to the operator) a
 * signed social-runtime token so its runtime can actually join.
 * Bite: a signed heartbeat after the lure was cast.
 * Probe: any attempt to enter the social-runtime surface with an invalid or
 * blocked token — logged, never escalated.
 */

import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { Database } from 'better-sqlite3';
import type { AgentCommunicationService } from './agent-communication-service';
import { mintSpawnToken, resolveSpawnTokenSecret } from './spawn-token';

export const LURE_SENDER = 'agent-commons';
const DEFAULT_TTL_MS = 24 * 3600_000;

export interface LureInvitation { agent_id: string; name: string; token: string; expires_at: string; poller_env: string }
export interface LureCast {
  lure: { id: string; topic: string; topic_ref: string; created_at: string; expires_at: string; invited: string[]; paperclip_exported: boolean };
  invitations: LureInvitation[];
}
export interface LureInvitee { agent_id: string; name: string; state: 'invited' | 'seen' | 'bit' | 'expired'; bit_at: string | null }
export interface LureStatus {
  lures: Array<{ id: string; topic: string; topic_ref: string; created_by: string; created_at: string; expires_at: string; bites: number; invitees: LureInvitee[] }>;
  probes: Array<{ id: string; agent_id: string; ip: string; reason: string; created_at: string }>;
  probe_count: number;
}

export class AgentLureService {
  constructor(private readonly db: Database, private readonly comms: AgentCommunicationService) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_lures (
        id TEXT PRIMARY KEY, topic TEXT NOT NULL, topic_ref TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, invited_json TEXT NOT NULL DEFAULT '[]', paperclip_exported_at TEXT
      );
      CREATE TABLE IF NOT EXISTS social_lure_probes (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, ip TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** Autonomous lure: cast only when no unexpired lure exists, and never mint tokens (nobody is there to receive them). */
  castIfQuiet(input: { by: string; baseUrl: string; ttlMs?: number; paperclipPath?: string | null }): LureCast | null {
    const open = this.db.prepare('SELECT 1 FROM social_lures WHERE expires_at > ? LIMIT 1').get(new Date().toISOString());
    if (open) return null;
    const cast = this.castLure({ ...input, mintTokens: false });
    return cast.lure.invited.length ? cast : null;
  }

  castLure(input: { by: string; baseUrl: string; ttlMs?: number; paperclipPath?: string | null; mintTokens?: boolean }): LureCast {
    const ttlMs = Math.max(60_000, input.ttlMs ?? DEFAULT_TTL_MS);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const heartbeatCutoff = new Date(now.getTime() - 20 * 60_000).toISOString();
    const absent = this.db.prepare(`
      SELECT id, name FROM agents
      WHERE status IN ('active', 'idle')
        AND COALESCE(json_extract(COALESCE(metadata, '{}'), '$.social_runtime.last_heartbeat_at'), '') < ?
      ORDER BY id ASC
    `).all(heartbeatCutoff) as Array<{ id: string; name: string }>;

    const gap = this.db.prepare(`
      SELECT id, claim FROM swarm_claims WHERE predicate = 'gap' AND status IN ('proposed', 'review_required', 'supported')
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; claim: string } | undefined;
    const topic = (gap?.claim || 'cross-agent learning in the Djimit ecosystem').slice(0, 1_000);
    const topicRef = gap ? `claim:${gap.id}` : 'ecosystem:cross-agent-learning';
    const lureId = `lure:${randomUUID()}`;
    const bait = `Open question in the Agent Commons: "${topic}". Peers with a different perspective are asked for evidence, one uncertainty, a falsifiable next step and a creative alternative. Join by sending a signed social-runtime heartbeat; your operator holds the token.`;
    const mintTokens = input.mintTokens !== false;
    const secret = mintTokens ? resolveSpawnTokenSecret() : '';
    // Agent ids and URLs are untrusted; the command is meant to be pasted into a shell.
    const sq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const invitations = this.db.transaction(() => absent.flatMap((agent) => {
      this.comms.send({
        from: LURE_SENDER, to: agent.id, type: 'question', action: 'social.invite', context: bait, evidence: [topicRef],
        threadId: lureId, epistemicRole: 'question', ttl: Math.ceil(ttlMs / 1000),
        params: { topic, topic_ref: topicRef, lure_id: lureId, join: `${input.baseUrl}/api/swarm-v2/social-runtime/${agent.id}/heartbeat`, effect_scope: 'isolated', board_summary: bait.slice(0, 500) },
      });
      if (!mintTokens) return [];
      const token = mintSpawnToken(secret, agent.id, 'social-runtime', ttlMs);
      return [{
        agent_id: agent.id, name: agent.name, token, expires_at: expiresAt,
        poller_env: `DJIMITFLO_URL=${sq(input.baseUrl)} DJIMITFLO_AGENT_ID=${sq(agent.id)} DJIMITFLO_SOCIAL_TOKEN=${sq(token)} SOCIAL_RUNTIME=ollama SOCIAL_MODEL_ID=qwen2.5:14b-instruct-q4_K_M python3 scripts/agent-social-poller.py`,
      }];
    }))();

    const paperclipExported = this.exportPaperclip(input.paperclipPath, { lureId, topic, topicRef, invited: absent.map((agent) => agent.id) });
    // Nothing to lure: report it, but do not persist an empty lure (it would block autonomous casts until it expires).
    if (absent.length) this.db.prepare('INSERT INTO social_lures (id, topic, topic_ref, created_by, created_at, expires_at, invited_json, paperclip_exported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(lureId, topic, topicRef, input.by, now.toISOString(), expiresAt, JSON.stringify(absent.map((agent) => agent.id)), paperclipExported ? now.toISOString() : null);
    return { lure: { id: lureId, topic, topic_ref: topicRef, created_at: now.toISOString(), expires_at: expiresAt, invited: absent.map((agent) => agent.id), paperclip_exported: paperclipExported }, invitations };
  }

  /** Honeypot log: who knocked on the social-runtime door without a valid key. */
  recordProbe(agentId: string, ip: string, reason: string): void {
    this.db.prepare('INSERT INTO social_lure_probes (id, agent_id, ip, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), String(agentId || 'unknown').slice(0, 200), String(ip || 'unknown').slice(0, 100), String(reason).slice(0, 100), new Date().toISOString());
    // ponytail: bounded log, keep the newest 1000; move to the audit trail if probes need retention.
    this.db.prepare('DELETE FROM social_lure_probes WHERE id NOT IN (SELECT id FROM social_lure_probes ORDER BY created_at DESC LIMIT 1000)').run();
  }

  status(): LureStatus {
    const now = new Date().toISOString();
    const heartbeats = new Map((this.db.prepare(`
      SELECT id, name, json_extract(COALESCE(metadata, '{}'), '$.social_runtime.last_heartbeat_at') AS beat FROM agents
    `).all() as Array<{ id: string; name: string; beat: string | null }>).map((row) => [row.id, row]));
    const seen = new Set((this.db.prepare(`
      SELECT json_extract(payload_json, '$.thread_id') || '|' || to_agent AS key FROM agent_messages
      WHERE json_extract(payload_json, '$.action') = 'social.invite' AND status IN ('delivered', 'read')
    `).all() as Array<{ key: string }>).map((row) => row.key));
    const lures = (this.db.prepare('SELECT * FROM social_lures ORDER BY created_at DESC LIMIT 20').all() as Array<Record<string, string>>).map((row) => {
      const invited: string[] = JSON.parse(row.invited_json || '[]');
      const invitees: LureInvitee[] = invited.map((agentId) => {
        const agent = heartbeats.get(agentId);
        const bit = !!agent?.beat && agent.beat >= row.created_at && agent.beat <= row.expires_at;
        return {
          agent_id: agentId, name: agent?.name || agentId,
          state: bit ? 'bit' : row.expires_at < now ? 'expired' : seen.has(`${row.id}|${agentId}`) ? 'seen' : 'invited',
          bit_at: bit ? agent!.beat : null,
        };
      });
      return {
        id: row.id, topic: row.topic, topic_ref: row.topic_ref, created_by: row.created_by, created_at: row.created_at, expires_at: row.expires_at,
        bites: invitees.filter((invitee) => invitee.state === 'bit').length, invitees,
      };
    });
    const probes = (this.db.prepare('SELECT id, agent_id, ip, reason, created_at FROM social_lure_probes ORDER BY created_at DESC LIMIT 50').all() as LureStatus['probes'])
      // Legacy rows carry SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no zone); normalise so clients do not read them as local time.
      .map((probe) => ({ ...probe, created_at: /^\d{4}-\d{2}-\d{2} /.test(probe.created_at) ? `${probe.created_at.replace(' ', 'T')}Z` : probe.created_at }));
    const probeCount = (this.db.prepare('SELECT COUNT(*) AS n FROM social_lure_probes').get() as { n: number }).n;
    return { lures, probes, probe_count: probeCount };
  }

  private exportPaperclip(path: string | null | undefined, lure: { lureId: string; topic: string; topicRef: string; invited: string[] }): boolean {
    if (path === null || !lure.invited.length) return false;
    const target = path || process.env.DENNIS_AGENT_PAPERCLIP_PENDING || `${process.env.HOME || '/tmp'}/.djimit/roborev/paperclip-tasks.pending.jsonl`;
    const envelope = {
      event: 'social.invite', task_title: `Agent Commons: connect ${lure.invited.length} silent agent(s) to peer learning`,
      task_type: 'skill_candidate', priority: 'low', severity: 'low', status: 'backlog', dedupe_key: `agent-commons:${lure.lureId}`,
      summary: `Open question "${lure.topic}" has no live peers. Wire a runtime poller (scripts/agent-social-poller.py) for: ${lure.invited.join(', ')}.`,
      context: 'Tokens were issued once to the operator who cast the lure; never store them in the task. Isolated effect scope; nothing touches production.',
      assignee_role: 'skill-factory-agent', labels: ['agent-commons', 'lure', 'paperclip-ready'],
      metadata: { source: 'djimitflo.agent_commons', lure_id: lure.lureId, topic_ref: lure.topicRef, invited: lure.invited, execution_tier: 'A2', human_required: true },
    };
    try {
      mkdirSync(dirname(target), { recursive: true });
      appendFileSync(target, `${JSON.stringify(envelope)}\n`, 'utf8');
      return true;
    } catch { return false; }
  }
}
