/**
 * Capability factory, slice 1 (CAPABILITY_FACTORY_MODE=on): operator requests and the capability registry view.
 * Off: both routes answer 404 CAPABILITY_FACTORY_DISABLED and write nothing.
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { CapabilityRequestError, capabilityFactoryMode, searchRegistry, submitCapabilityRequest } from '../services/capability-factory';

const requestSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(4000),
  target_file: z.string().trim().min(1).max(300),
  acceptance: z.string().trim().min(1).max(300),
  repo: z.string().trim().min(1).max(200).optional(),
  execute: z.boolean().optional(), // OMEGA slice 2: honoured only with CAPABILITY_FACTORY_REUSE_EXECUTE=on
}).strict();

export function createCapabilityRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false })); // per-router limiter CodeQL can see; /api also caps 300/min
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());
  const disabled = () => createError(404, 'Capability factory is off (CAPABILITY_FACTORY_MODE)', 'CAPABILITY_FACTORY_DISABLED');

  router.post('/requests', requirePermission('write:governance'), (req, res, next) => {
    try {
      if (capabilityFactoryMode() !== 'on') throw disabled();
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) throw createError(400, 'title, description, target_file and acceptance are required (repo, execute optional)', 'VALIDATION_ERROR');
      const result = submitCapabilityRequest(db, parsed.data, actor);
      res.status(result.status === 'proposed' ? 201 : result.status === 'duplicate' ? 409 : 200).json(result);
    } catch (error) {
      next(error instanceof CapabilityRequestError
        ? createError(error.code === 'CAPABILITY_FACTORY_DISABLED' ? 404 : 400, error.message, error.code)
        : error);
    }
  });

  router.get('/registry', requirePermission('read:evidence'), (req, res, next) => {
    try {
      if (capabilityFactoryMode() !== 'on') throw disabled();
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 300) : '';
      res.json({ q, capabilities: searchRegistry(db, q) });
    } catch (error) { next(error); }
  });

  return router;
}
