/**
 * Capability factory, slice 1 (CAPABILITY_FACTORY_MODE=on): operator requests and the capability registry view.
 * Off: both routes answer 404 CAPABILITY_FACTORY_DISABLED and write nothing.
 * L1 skill route (SKILL_ROUTE_MODE=shadow|on, manage:config): register a skill from a repair (server-side digest) and validate it.
 * Off: 404 SKILL_ROUTE_DISABLED, nothing written. SKILL_VALIDATION_REQUIRES_TESTS=on: register needs `tests`, validate a `test_receipt`.
 */
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { CapabilityRequestError, capabilityFactoryMode, searchRegistry, submitCapabilityRequest } from '../services/capability-factory';
import { CapabilityLifecycleError } from '../services/swarm-intelligence-service';
import { SKILL_LANES, registerSkillFromRepair, skillRouteMode, validateSkillCapability } from '../services/skill-route';
import { param } from './params';

const requestSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(4000),
  target_file: z.string().trim().min(1).max(300),
  acceptance: z.string().trim().min(1).max(300),
  repo: z.string().trim().min(1).max(200).optional(),
  execute: z.boolean().optional(), // OMEGA slice 2: honoured only with CAPABILITY_FACTORY_REUSE_EXECUTE=on
}).strict();

// the digest is never client-supplied: the server hashes script_path in its own checkout
const skillSchema = z.object({
  name: z.string().trim().min(2).max(49),
  lanes: z.array(z.enum(SKILL_LANES)).min(1).max(SKILL_LANES.length),
  script_path: z.string().trim().min(1).max(200),
  oracle: z.string().trim().min(5).max(300),
  applicability: z.object({ runtimes: z.array(z.string().trim().min(1).max(80)).max(10).optional() }).strict().optional(),
  provenance: z.object({ lease_ids: z.array(z.string().trim().min(1).max(100)).max(50).optional(), ref: z.string().trim().max(300).optional() }).strict().optional(),
  // SKILL_VALIDATION_REQUIRES_TESTS: repo-relative test files that exercise the script (required when on); the server hashes them
  tests: z.array(z.string().trim().min(1).max(300)).min(1).max(20).optional(),
}).strict();
// scripts/skill-test-receipt.mjs output; checked only with SKILL_VALIDATION_REQUIRES_TESTS=on (the server never runs tests)
const testReceiptSchema = z.object({
  commit: z.string().trim().regex(/^[0-9a-f]{7,64}$/i),
  test_files: z.array(z.object({ path: z.string().trim().min(1).max(300), sha256: z.string().trim().min(1).max(80) }).strict()).min(1).max(20),
  result: z.enum(['pass', 'fail']),
  runner: z.string().trim().min(1).max(500),
  ran_at: z.string().trim().min(1).max(40),
}).strict();
const validateSchema = z.object({ evidence_refs: z.array(z.string().trim().min(1).max(300)).min(1).max(20), test_receipt: testReceiptSchema.optional() }).strict();
const SKILL_STATUS: Record<string, number> = { SKILL_ROUTE_DISABLED: 404, SKILL_NOT_FOUND: 404, SKILL_DIGEST_CHANGED: 409, SKILL_NOT_CANDIDATE: 409, SKILL_TESTS_UNPROVEN: 409 };

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

  const skillError = (error: unknown) => (error instanceof CapabilityRequestError ? createError(SKILL_STATUS[error.code] ?? 400, error.message, error.code)
    : error instanceof CapabilityLifecycleError ? createError(409, error.message, error.code) : error);
  const skillDisabled = () => createError(404, 'Skill route is off (SKILL_ROUTE_MODE)', 'SKILL_ROUTE_DISABLED');

  router.post('/skills', requirePermission('manage:config'), (req, res, next) => {
    try {
      if (skillRouteMode() === 'off') throw skillDisabled();
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const parsed = skillSchema.safeParse(req.body);
      if (!parsed.success) throw createError(400, 'name, lanes, script_path and oracle are required (applicability, provenance, tests optional; no digest)', 'VALIDATION_ERROR');
      const result = registerSkillFromRepair(db, parsed.data, actor);
      res.status(result.status === 'registered' ? 201 : 200).json(result);
    } catch (error) { next(skillError(error)); }
  });

  router.post('/skills/:id/validate', requirePermission('manage:config'), (req, res, next) => {
    try {
      if (skillRouteMode() === 'off') throw skillDisabled();
      const actor = req.user?.sub || req.user?.email;
      if (!actor) throw createError(401, 'Authentication required', 'AUTH_REQUIRED');
      const parsed = validateSchema.safeParse(req.body);
      if (!parsed.success) throw createError(400, 'evidence_refs (1–20) are required (test_receipt optional: {commit, test_files [{path, sha256}], result, runner, ran_at})', 'VALIDATION_ERROR');
      res.json({ capability: validateSkillCapability(db, param(req, 'id'), parsed.data, actor) });
    } catch (error) { next(skillError(error)); }
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
