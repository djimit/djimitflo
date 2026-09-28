import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { prepareState } from './typesafe-client';

/**
 * Fleet host agent (operator decision 2026-09-29: "root, per-command approval"). Djimitflo never connects to a host — every
 * host runs scripts/djimit-host-agent.py, which polls (heartbeat), receives commands and reports results.
 * - diagnostics: a fixed set of read-only names the agent maps to its own commands (no operator text reaches a shell)
 * - shell: any command, executed by the agent as root (sudo -n), only after a human with approve:task approved exactly that
 *   text: the approval is bound to the command's sha256 and must be picked up within 15 minutes
 * Output is capped (64 KiB) and passed through the same secret scrubber as judgments before it is stored.
 */
export const DIAGNOSTICS = ['ping', 'uptime', 'disk', 'failed-services', 'top'] as const;
const APPROVAL_WINDOW_MS = 15 * 60_000;
const MAX_OUTPUT = 64 * 1024;
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const now = () => new Date().toISOString();

export interface FleetCommand { id: string; host: string; kind: 'diagnostic' | 'shell'; command: string; command_sha256: string; status: string; requested_by: string;
  approved_by: string | null; approved_at: string | null; expires_at: string | null; decided_reason: string | null; started_at: string | null;
  finished_at: string | null; exit_code: number | null; output: string | null; created_at: string }

export class FleetCommands {
  constructor(private readonly db: Database) {}

  request(host: string, command: string, requestedBy: string): FleetCommand {
    const text = String(command ?? '').trim();
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(host)) throw new Error('FLEET_HOST_INVALID');
    if (!text || text.length > 4_000) throw new Error('FLEET_COMMAND_INVALID');
    if (!requestedBy.trim()) throw new Error('FLEET_ACTOR_REQUIRED');
    const kind = (DIAGNOSTICS as readonly string[]).includes(text) ? 'diagnostic' : 'shell';
    const id = randomUUID();
    this.db.prepare(`INSERT INTO fleet_commands (id, host, kind, command, command_sha256, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, host, kind, text, sha256(text), kind === 'diagnostic' ? 'queued' : 'pending_approval', requestedBy, now());
    return this.get(id)!;
  }

  /** A human approves exactly the command text they saw (its sha256); the host must pick it up within 15 minutes. */
  approve(id: string, approver: string, sha: string): FleetCommand {
    const c = this.get(id);
    if (!c) throw new Error('FLEET_COMMAND_NOT_FOUND');
    if (c.status !== 'pending_approval') throw new Error('FLEET_COMMAND_NOT_PENDING');
    if (!approver.trim()) throw new Error('FLEET_ACTOR_REQUIRED');
    if (sha !== c.command_sha256 || sha256(c.command) !== c.command_sha256) throw new Error('FLEET_COMMAND_HASH_MISMATCH');
    const at = now();
    this.db.prepare(`UPDATE fleet_commands SET status = 'queued', approved_by = ?, approved_at = ?, expires_at = ? WHERE id = ? AND status = 'pending_approval'`)
      .run(approver, at, new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString(), id);
    return this.get(id)!;
  }

  deny(id: string, actor: string, reason = ''): FleetCommand {
    const c = this.get(id);
    if (!c) throw new Error('FLEET_COMMAND_NOT_FOUND');
    if (!['pending_approval', 'queued'].includes(c.status)) throw new Error('FLEET_COMMAND_NOT_PENDING');
    this.db.prepare(`UPDATE fleet_commands SET status = 'denied', approved_by = ?, decided_reason = ?, finished_at = ? WHERE id = ?`).run(actor, reason.slice(0, 300), now(), id);
    return this.get(id)!;
  }

  /** Heartbeat + hand-out: expired approvals lapse; queued commands for this host are delivered once. */
  poll(host: string, info: Record<string, unknown> = {}, version = ''): Array<{ id: string; kind: string; command: string; sha256: string }> {
    const at = now();
    this.db.prepare(`INSERT INTO fleet_hosts (host, last_seen, agent_version, info_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET last_seen = excluded.last_seen, agent_version = excluded.agent_version, info_json = excluded.info_json`)
      .run(host, at, String(version).slice(0, 40), JSON.stringify(info).slice(0, 4_000));
    this.db.prepare(`UPDATE fleet_commands SET status = 'expired', finished_at = ? WHERE host = ? AND status = 'queued' AND kind = 'shell' AND expires_at < ?`).run(at, host, at);
    const due = this.db.prepare(`SELECT * FROM fleet_commands WHERE host = ? AND status = 'queued' ORDER BY created_at LIMIT 5`).all(host) as FleetCommand[];
    const take = this.db.prepare(`UPDATE fleet_commands SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`);
    return due.filter((c) => take.run(at, c.id).changes === 1 && sha256(c.command) === c.command_sha256)
      .map((c) => ({ id: c.id, kind: c.kind, command: c.command, sha256: c.command_sha256 }));
  }

  result(id: string, host: string, exitCode: number | null, output: string): void {
    const c = this.get(id);
    if (!c || c.host !== host) throw new Error('FLEET_COMMAND_NOT_FOUND');
    if (c.status !== 'running') throw new Error('FLEET_COMMAND_NOT_RUNNING');
    const text = prepareState(String(output ?? '')).slice(-MAX_OUTPUT);
    this.db.prepare(`UPDATE fleet_commands SET status = ?, exit_code = ?, output = ?, finished_at = ? WHERE id = ?`)
      .run(exitCode === 0 ? 'done' : 'failed', Number.isInteger(exitCode) ? exitCode : null, text, now(), id);
  }

  get(id: string): FleetCommand | undefined { return this.db.prepare('SELECT * FROM fleet_commands WHERE id = ?').get(id) as FleetCommand | undefined; }

  hosts(nowMs = Date.now()): Array<{ host: string; last_seen: string; seconds_ago: number; live: boolean; agent_version: string | null; info: Record<string, unknown> }> {
    return (this.db.prepare('SELECT * FROM fleet_hosts ORDER BY host').all() as Array<{ host: string; last_seen: string; agent_version: string | null; info_json: string }>)
      .map((h) => { const ago = Math.round((nowMs - Date.parse(h.last_seen)) / 1000); return { host: h.host, last_seen: h.last_seen, seconds_ago: ago, live: ago <= 120, agent_version: h.agent_version, info: JSON.parse(h.info_json || '{}') }; });
  }

  recent(limit = 100): FleetCommand[] { return this.db.prepare('SELECT * FROM fleet_commands ORDER BY created_at DESC LIMIT ?').all(Math.min(500, limit)) as FleetCommand[]; }
}
