import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { swarmEventBus } from '../services/swarm-event-bus';

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

  // POST /api/federation/work — offer work to this instance.
  router.post('/work', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { goal_objective } = req.body;
      if (!goal_objective) {
        res.status(400).json({ error: 'goal_objective is required' });
        return;
        return;
      }
      const accepted = true;
      swarmEventBus.emit('convergence', {
        federation: 'work_offered',
        goal_objective,
        accepted,
      });
      res.json({ accepted, reason: accepted ? 'capacity available' : 'capacity exhausted' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
