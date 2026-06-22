import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';
import type { AuthMiddleware } from '../middleware/auth';
import { getCatalog } from '../services/agent-catalog-service';
import { compile, type Profile, type Target } from '@djimitflo/agent-catalog';

interface CatalogCounts { imported: number; evaluated: number; active: number; duplicate: number; rejected: number; }
interface CatalogAgent {
  id: string; name: string; division: string; status: string;
  evaluation?: { score?: number; verdict?: string } | null;
  activation?: { target?: string; active?: boolean } | null;
}

function toCatalogAgent(profile: Profile): CatalogAgent {
  const act = getCatalog().registry.status(profile.id);
  const active = act.status === 'active';
  let status = 'imported';
  if (active) status = 'active';
  else if (profile.evaluation_status === 'rejected') status = profile.risk_profile.flags.includes('near-duplicate') ? 'duplicate' : 'rejected';
  else if (profile.evaluation_status === 'passed') status = 'evaluated';

  const evaluation =
    profile.evaluation_status === 'pending'
      ? null
      : { score: profile.evaluation_status === 'passed' ? 100 : 0, verdict: profile.evaluation_status };
  return {
    id: profile.id, name: profile.name, division: profile.division, status,
    evaluation,
    activation: { target: act.target || undefined, active },
  };
}

export function createCatalogRoutes(_db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requireAuth = auth?.requireAuth ?? ((_req: any, _res: any, next: any) => next());
  const requirePermission = auth?.requirePermission ?? (() => (_req: any, _res: any, next: any) => next());

  router.get('/counts', requireAuth, requirePermission('read:evidence'), (_req, res, next) => {
    try {
      const c = getCatalog().counts();
      const out: CatalogCounts = { imported: c.total, evaluated: c.evaluated, active: c.active, duplicate: c.duplicate, rejected: c.rejected };
      res.json(out);
    } catch (e) { next(e); }
  });

  router.get('/agents', requireAuth, requirePermission('read:evidence'), (req, res, next) => {
    try {
      const { division, status } = req.query;
      res.json({ agents: getCatalog().list({ division: division as string, status: status as string }).map(toCatalogAgent) });
    } catch (e) { next(e); }
  });

  router.get('/agents/:id', requireAuth, requirePermission('read:evidence'), (req, res, next) => {
    try {
      const cat = getCatalog();
      const profile = cat.db.getProfile(req.params.id);
      if (!profile) throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
      res.json({ ...toCatalogAgent(profile), profile });
    } catch (e) { next(e); }
  });

  router.get('/search', requireAuth, requirePermission('read:evidence'), (req, res, next) => {
    try { res.json({ agents: getCatalog().search(String(req.query.q || ''), Number(req.query.topK) || 20).map(toCatalogAgent) }); } catch (e) { next(e); }
  });

  router.get('/compile/:id', requireAuth, requirePermission('read:evidence'), (req, res, next) => {
    try {
      const cat = getCatalog();
      const profile = cat.db.getProfile(req.params.id);
      if (!profile) throw createError(404, 'Agent not found', 'AGENT_NOT_FOUND');
      const target = (req.query.target as Target) || 'openclaw';
      res.json({ target, files: compile(profile, target).files });
    } catch (e) { next(e); }
  });

  router.post('/activate/:id', requireAuth, requirePermission('manage:config'), (req, res, next) => {
    try {
      const target = (req.body?.target || 'openclaw') as Target;
      const r = getCatalog().registry.activate(req.params.id, target);
      res.json({ target: r.target, active: true });
    } catch (e) { next(e); }
  });

  router.post('/deactivate/:id', requireAuth, requirePermission('manage:config'), (_req, res, next) => {
    try { getCatalog().registry.deactivate(_req.params.id); res.json({ active: false }); } catch (e) { next(e); }
  });

  return router;
}
