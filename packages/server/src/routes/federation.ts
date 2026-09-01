import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { swarmEventBus } from '../services/swarm-event-bus';
import { LoopService } from '../services/loop-service';
import { runtimeConcurrencyLimit, runtimeConcurrencySemaphore } from '../services/concurrency-semaphore';

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

export function createFederationRoutes(db: Database, auth: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth.requireAuth;
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
  router.get('/peers', requireAuth, (_req: Request, res: Response, next: NextFunction) => {
    try {
      const peers = db.prepare('SELECT * FROM federation_peers ORDER BY registered_at ASC').all() as PeerRecord[];
      res.json({ peers });
    } catch (error) {
      next(error);
      return;
    }
  });

  // POST /api/federation/register — register a peer.
  router.post('/register', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, trust_level, metadata } = req.body;
      if (!url) {
        res.status(400).json({ error: 'url is required' });
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
  router.get('/capabilities', requireAuth, (_req: Request, res: Response, next: NextFunction) => {
    try {
      const caps = db.prepare('SELECT id, kind, status, metadata, cost_model_json FROM swarm_capabilities WHERE status IN (\'validated\', \'candidate\')').all();
      res.json({ capabilities: caps });
    } catch (error) {
      next(error);
      return;
    }
  });

  router.get('/capacity', requireAuth, (_req: Request, res: Response) => {
    const active = (db.prepare("SELECT COUNT(*) AS count FROM loop_runs WHERE status IN ('planning','running','verifying')").get() as { count: number }).count;
    const limit = Math.max(1, Number(process.env.FEDERATION_MAX_ACTIVE_WORK || 4));
    res.json({ available: active < limit, active, limit });
  });

  router.post('/inbox/work', requireAuth, (req: Request, res: Response, next: NextFunction) => {
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
      const run = loops.startLoop({ goal_id: goal.id, repository_path: process.env.FEDERATION_REPOSITORY_PATH || process.cwd(), loop_name: 'repo-maintenance-loop' });
      swarmEventBus.emit('convergence', {
        federation: 'work_accepted', goal_id: goal.id, loop_run_id: run.id, source_peer_id,
      });
      res.status(202).json({ accepted: true, goal_id: goal.id, loop_run_id: run.id });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/federation/work — distribute work to an available registered peer.
  router.post('/work', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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
        const metadata = JSON.parse(peer.metadata || '{}') as Record<string, unknown>;
        const token = typeof metadata.auth_token_env === 'string' ? process.env[metadata.auth_token_env] : process.env.FEDERATION_TOKEN;
        const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
        try {
          const base = peer.url.replace(/\/$/, '');
          const capacity = await fetch(`${base}/api/federation/capacity`, { headers, signal: AbortSignal.timeout(5_000) });
          const status = capacity.ok ? await capacity.json() as { available?: boolean } : { available: false };
          if (!status.available) { attempts.push({ peer_id: peer.id, status: 'no_capacity' }); continue; }
          const response = await fetch(`${base}/api/federation/inbox/work`, {
            method: 'POST', headers, signal: AbortSignal.timeout(10_000),
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
