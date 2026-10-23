import { Router, Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { swarmEventBus } from '../services/swarm-event-bus';
import { agentRegistryAuthHeaders } from '../services/fleet-bus-auth';
import { LoopService } from '../services/loop-service';
import { runtimeConcurrencyLimit, runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';
import { resolveRepositoryRoot } from '../utils/repository-root';
import { deniedHosts, isDenied } from '../utils/outbound-guard';

/**
 * G26: Federation protocol — peer discovery, registration, claim sharing,
 * capability synchronization, and work distribution.
 */

interface PeerRecord {
  id: string;
  url: string;
  trust_level: 'low' | 'medium' | 'high';
  registered_at: string;
  last_seen: string;
  metadata: Record<string, unknown>;
}

/**
 * Live fleet discovery source of truth: the agent-registry service
 * (control plane, `GET /agents`). Consumed read-only — DjimFlo never writes to
 * it. `federation_peers` remains an outbound work-dispatch peer list; it is not
 * a discovery cache and must not be treated as one.
 */
const DEFAULT_AGENT_REGISTRY_URL = 'http://100.86.47.122:8088';

export function resolveAgentRegistryUrl(): string {
  return (process.env.AGENT_REGISTRY_URL || DEFAULT_AGENT_REGISTRY_URL).replace(/\/$/, '');
}

export interface FleetAgent {
  name: string;
  host?: string;
  runtime?: string;
  framework?: string;
  version?: string;
  capabilities?: string[];
  status?: string;
  last_heartbeat?: string;
  api_endpoint?: string;
  [key: string]: unknown;
}

export type FleetAgentsResult =
  | { ok: true; registry_url: string; fetched_at: string; agents: FleetAgent[] }
  | { ok: false; registry_url: string; reason: string; agents: [] };

/**
 * Read the live fleet registry. Fail-closed: an unreachable or malformed registry
 * is reported as an explicit failure, never as an empty (but "successful") list.
 */
export async function fetchFleetAgents(registryUrl = resolveAgentRegistryUrl()): Promise<FleetAgentsResult> {
  try {
    const response = await fetch(`${registryUrl}/agents`, {
      headers: { accept: 'application/json', ...agentRegistryAuthHeaders() },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, registry_url: registryUrl, reason: `registry_http_${response.status}`, agents: [] };
    const body = await response.json();
    if (!Array.isArray(body)) return { ok: false, registry_url: registryUrl, reason: 'registry_malformed_response', agents: [] };
    return { ok: true, registry_url: registryUrl, fetched_at: new Date().toISOString(), agents: body as FleetAgent[] };
  } catch (error) {
    return { ok: false, registry_url: registryUrl, reason: `registry_unreachable: ${error instanceof Error ? error.message : String(error)}`, agents: [] };
  }
}

/**
 * P0-1: a peer row may only name a dedicated peer-token env var, never an arbitrary server secret
 * (JWT_SECRET, GITHUB_TOKEN, ...). Checked at register and again at use, so pre-existing rows are re-validated.
 */
const PEER_TOKEN_ENV = /^FEDERATION_PEER_TOKEN_[A-Z0-9_]+$/;

export function isAllowedPeerTokenEnv(name: unknown): name is string {
  return typeof name === 'string' && PEER_TOKEN_ENV.test(name);
}

/** Bearer token for a peer: a valid FEDERATION_PEER_TOKEN_* name, else FEDERATION_TOKEN when none is named; an invalid name gets nothing. */
export function peerToken(metadata: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (metadata.auth_token_env === undefined) return env.FEDERATION_TOKEN;
  return isAllowedPeerTokenEnv(metadata.auth_token_env) ? env[metadata.auth_token_env] : undefined;
}

/**
 * P0-1: a peer URL must be https://, or http:// to a host listed in FEDERATION_ALLOWED_HOSTS (comma list; empty = https only),
 * and must not hit OUTBOUND_DENY_HOSTS. Returns the refusal reason, or null when the URL is acceptable.
 */
export function peerUrlRejection(url: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof url !== 'string' || !url) return 'url is required';
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'url is not a valid URL'; }
  if (parsed.username || parsed.password) return 'url must not carry credentials';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowed = new Set((env.FEDERATION_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowed.has(host))) {
    return 'url must be https:// (or http:// to a host in FEDERATION_ALLOWED_HOSTS)';
  }
  if (isDenied(parsed.href, deniedHosts(env))) return 'url host is refused by OUTBOUND_DENY_HOSTS';
  return null;
}

export function createFederationRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  // CodeQL js/missing-rate-limiting: every handler performs DB access.
  const fedLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  router.use(fedLimiter);
  const requireAuth = auth.requireAuth;
  // P0-1: reads need read:evidence like sibling routes; peer registration and work dispatch/intake are admin-only.
  const canRead = auth.requirePermission('read:evidence');
  const canManage = auth.requirePermission('manage:config');
  const loops = new LoopService(db);

  // Ensure federation_peers table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS federation_peers (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      trust_level TEXT NOT NULL DEFAULT 'medium',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // GET /api/federation/peers — list known peers.
  router.get('/peers', requireAuth, canRead, (_req: Request, res: Response, next: NextFunction) => {
    try {
      const peers = db.prepare('SELECT * FROM federation_peers ORDER BY registered_at ASC').all() as PeerRecord[];
      res.json({ peers });
    } catch (error) {
      next(error);
      return;
    }
  });

  // GET /api/federation/fleet — live fleet discovery from the agent-registry (read-only).
  router.get('/fleet', requireAuth, canRead, async (_req: Request, res: Response) => {
    const fleet = await fetchFleetAgents();
    res.status(fleet.ok ? 200 : 503).json(fleet);
  });

  // POST /api/federation/register — register a peer.
  router.post('/register', requireAuth, canManage, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, trust_level, metadata } = req.body;
      const urlRejection = peerUrlRejection(url);
      if (urlRejection) {
        res.status(400).json({ error: urlRejection });
        return;
      }
      if (metadata && typeof metadata === 'object' && 'auth_token_env' in metadata && !isAllowedPeerTokenEnv((metadata as Record<string, unknown>).auth_token_env)) {
        res.status(400).json({ error: 'metadata.auth_token_env must match FEDERATION_PEER_TOKEN_[A-Z0-9_]+' });
        return;
      }
      const id = `peer_${Date.now()}`;
      const trust = trust_level || 'medium';
      const now = new Date().toISOString();
      db.prepare('INSERT INTO federation_peers (id, url, trust_level, registered_at, last_seen, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, url, trust, now, now, JSON.stringify(metadata || {}));
      swarmEventBus.emit('convergence', { federation: 'peer_registered', peer_id: id, url });
      res.status(201).json({ id, url, trust_level: trust, registered: true });
    } catch (error) {
      next(error);
      return;
    }
  });

  // GET /api/federation/capabilities — list local capabilities for peer sync.
  router.get('/capabilities', requireAuth, canRead, (_req: Request, res: Response, next: NextFunction) => {
    try {
      const caps = db.prepare('SELECT id, kind, status, metadata, cost_model_json FROM swarm_capabilities WHERE status IN (\'validated\', \'candidate\')').all();
      res.json({ capabilities: caps });
    } catch (error) {
      next(error);
      return;
    }
  });

  router.get('/capacity', requireAuth, canRead, (_req: Request, res: Response) => {
    const active = (db.prepare("SELECT COUNT(*) AS count FROM loop_runs WHERE status IN ('planning','running','verifying')").get() as { count: number }).count;
    const limit = Math.max(1, Number(process.env.FEDERATION_MAX_ACTIVE_WORK || 4));
    res.json({ available: active < limit, active, limit });
  });

  router.post('/inbox/work', requireAuth, canManage, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { goal_objective, source_peer_id } = req.body;
      if (!goal_objective) {
        res.status(400).json({ error: 'goal_objective is required' });
        return;
      }
      const active = (db.prepare("SELECT COUNT(*) AS count FROM loop_runs WHERE status IN ('planning','running','verifying')").get() as { count: number }).count;
      if (active >= Math.max(1, Number(process.env.FEDERATION_MAX_ACTIVE_WORK || 4))) return void res.status(429).json({ accepted: false, reason: 'capacity exhausted' });
      const objective = `BEGIN_EXTERNAL_CONTENT source=federated_peer trust=peer\n${JSON.stringify({ source_peer_id, goal_objective })}\nEND_EXTERNAL_CONTENT`;
      const goal = loops.createGoal({ objective, acceptance_criteria: ['Complete federated work with recorded gates'], metadata: { source_peer_id, federated: true, external_content: true } });
      const run = loops.startLoop({ goal_id: goal.id, repository_path: process.env.FEDERATION_REPOSITORY_PATH || resolveRepositoryRoot(process.cwd()), loop_name: 'repo-maintenance-loop' });
      swarmEventBus.emit('convergence', {
        federation: 'work_accepted', goal_id: goal.id, loop_run_id: run.id, source_peer_id,
      });
      res.status(202).json({ accepted: true, goal_id: goal.id, loop_run_id: run.id });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/federation/work — distribute work to an available registered peer.
  router.post('/work', requireAuth, canManage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { goal_objective } = req.body;
      if (!goal_objective) return void res.status(400).json({ error: 'goal_objective is required' });
      // Runtime capacity gate (133f5094): shared semaphore first — offered work
      // is rejected before any peer dispatch when local capacity is exhausted.
      const active = runtimeConcurrencySemaphore.activeCount;
      const limit = runtimeConcurrencyLimit();
      if (active >= limit) {
        return void res.json({ accepted: false, reason: 'capacity exhausted', capacity: { active, limit } });
      }
      const peers = db.prepare("SELECT * FROM federation_peers ORDER BY CASE trust_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen DESC").all() as Array<Omit<PeerRecord, 'metadata'> & { metadata: string }>;
      const attempts: Array<Record<string, unknown>> = [];
      for (const peer of peers) {
        // Defence in depth: rows registered before P0-1 are re-validated at use.
        const urlRejection = peerUrlRejection(peer.url);
        if (urlRejection) { attempts.push({ peer_id: peer.id, status: 'url_rejected', reason: urlRejection }); continue; }
        const metadata = JSON.parse(peer.metadata || '{}') as Record<string, unknown>;
        const token = peerToken(metadata);
        const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
        try {
          const base = peer.url.replace(/\/$/, '');
          const capacity = await fetch(`${base}/api/federation/capacity`, { headers, redirect: 'error', signal: AbortSignal.timeout(5_000) });
          const status = capacity.ok ? await capacity.json() as { available?: boolean } : { available: false };
          if (!status.available) { attempts.push({ peer_id: peer.id, status: 'no_capacity' }); continue; }
          const response = await fetch(`${base}/api/federation/inbox/work`, {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
            body: JSON.stringify({ goal_objective, source_peer_id: process.env.DJIMITFLO_NODE_ID || 'djimitflo-local' }),
          });
          if (!response.ok) { attempts.push({ peer_id: peer.id, status: `http_${response.status}` }); continue; }
          const result = await response.json();
          db.prepare('UPDATE federation_peers SET last_seen=? WHERE id=?').run(new Date().toISOString(), peer.id);
          swarmEventBus.emit('convergence', { federation: 'work_dispatched', peer_id: peer.id });
          return void res.json({ accepted: true, peer_id: peer.id, result, attempts });
        } catch (error) {
          attempts.push({ peer_id: peer.id, status: 'unreachable', error: error instanceof Error ? error.message : String(error) });
        }
      }
      res.status(503).json({ accepted: false, reason: 'no peer capacity available', attempts });
    } catch (error) { next(error); }
  });

  return router;
}
