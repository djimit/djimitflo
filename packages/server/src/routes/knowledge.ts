import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { knowledgeBus } from '../services/knowledge-bus';

export function createKnowledgeRoutes(auth: AuthMiddleware, db?: Database): Router {
  const router = Router();
  const requireAuth = auth.requireAuth;

  // G15: POST /api/knowledge/publish — publish a claim to the knowledge bus.
  // Used by remote DjimFlo instances to join the bus (federation transport scaffold).
  router.post('/publish', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const { claim_id, capability_id, predicate, subject_ref, confidence, status, trust, provenance_run, evidence_refs, created_from } = req.body;
      if (!claim_id || !subject_ref) {
        return res.status(400).json({ error: 'claim_id and subject_ref are required' });
      }
      knowledgeBus.publish({
        claim_id,
        capability_id: capability_id || null,
        predicate: predicate || '',
        subject_ref,
        confidence: confidence || 0,
        status: status || 'supported',
        trust: trust || confidence || 0,
        provenance_run: provenance_run || null,
        evidence_refs: evidence_refs || [],
        created_from: created_from || null,
      });
      return res.json({ published: true, subscribers: knowledgeBus.getSubscriberCount() });
    } catch (error) {
      next(error);
      return;
    }
  });

  // G15: GET /api/knowledge/subscribe/:capabilityId — SSE stream of claims for a capability.
  // Use :capabilityId=all for all claims.
  router.get('/subscribe/:capabilityId', requireAuth, (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', capability: req.params.capabilityId })}\n\n`);

    const capId = req.params.capabilityId === 'all' ? '*' : req.params.capabilityId;
    const unsub = knowledgeBus.subscribe(capId, (claim) => {
      try { res.write(`data: ${JSON.stringify(claim)}\n\n`); } catch { /* disconnected */ }
    });
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(ka); } }, 15_000);
    req.on('close', () => { unsub(); clearInterval(ka); });
  });

  // D12: GET /api/knowledge/events — recent knowledge bus claims
  router.get('/events', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const events = db?.prepare(`
        SELECT id, subject_ref, predicate, confidence, status, created_from, metadata, created_at
        FROM swarm_claims
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as any[];
      res.json({ events: events || [] });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
