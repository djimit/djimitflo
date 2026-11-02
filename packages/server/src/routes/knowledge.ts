import { rateLimit } from 'express-rate-limit';
import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { knowledgeBus } from '../services/knowledge-bus';
import { createError } from '../middleware/error-handler';
import { openSseStream } from '../utils/sse';

function boundedLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw createError(400, 'limit must be an integer between 1 and 500', 'VALIDATION_ERROR');
  }
  return limit;
}

export function createKnowledgeRoutes(auth: AuthMiddleware, db?: Database): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false })); // per-router limiter CodeQL can see; /api also caps 300/min
  const requireAuth = auth.requireAuth;

  // G15: POST /api/knowledge/publish — publish a claim to the knowledge bus.
  // Used by remote DjimFlo instances to join the authenticated bus transport.
  // A claim acts: `capability_gap` creates a candidate capability and `help_request` asks for a nested maker spawn
  // (capability-acquisition.ts, negotiation-coordinator.ts), so publishing needs write:claim like /api/memory/store.
  router.post('/publish', requireAuth, auth.requirePermission('write:claim'), (req: Request, res: Response, next: NextFunction) => {
    try {
      const { claim_id, capability_id, predicate, subject_ref, confidence, status, trust, provenance_run, evidence_refs, created_from } = req.body;
      const isOptionalString = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string';
      const isScore = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
      const valid = typeof claim_id === 'string' && claim_id.trim().length > 0
        && typeof subject_ref === 'string' && subject_ref.trim().length > 0
        && isOptionalString(capability_id) && isOptionalString(predicate) && isOptionalString(status)
        && isOptionalString(provenance_run) && isOptionalString(created_from)
        && isScore(confidence) && isScore(trust)
        && (evidence_refs === undefined || (Array.isArray(evidence_refs) && evidence_refs.every((ref: unknown) => typeof ref === 'string')));
      if (!valid) {
        return res.status(400).json({ error: { message: 'claim fields are invalid', code: 'VALIDATION_ERROR' } });
      }
      knowledgeBus.publish({
        claim_id,
        capability_id: capability_id || null,
        predicate: predicate || '',
        subject_ref,
        confidence: confidence ?? 0,
        status: status || 'supported',
        trust: trust ?? confidence ?? 0,
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
  // OBS-001: same bounded backpressure contract as /observability/stream (utils/sse.ts).
  router.get('/subscribe/:capabilityId', requireAuth, (req: Request, res: Response) => {
    const stream = openSseStream(req, res);
    stream.send({ type: 'connected', capability: req.params.capabilityId });
    const capId = req.params.capabilityId === 'all' ? '*' : req.params.capabilityId;
    stream.onClose(knowledgeBus.subscribe(capId, (claim) => { stream.send(claim); }));
  });

  // D12: GET /api/knowledge/events — recent knowledge bus claims
  router.get('/events', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = boundedLimit(req.query.limit);
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
