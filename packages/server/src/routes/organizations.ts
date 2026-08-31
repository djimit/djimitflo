import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Database } from 'better-sqlite3';

export function createOrganizationRoutes(db: Database, requireAuthMiddleware: any, authService: any, auditService?: any): Router {
  const router = Router();
  const orgLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  /**
   * GET /api/organizations
   * Lijst van organisaties (gefilterd op req.user.organization_id).
   */
  router.get('/', orgLimiter, requireAuthMiddleware, (req, res) => {
    const userOrgId = (req as any).user?.organization_id || 'default';
    const organizations = db.prepare(
      'SELECT * FROM organizations WHERE id = ? OR id = ?'
    ).all(userOrgId, 'default');
    res.json(organizations);
  });

  /**
   * POST /api/organizations/switch
   * Switch organisatie (genereert nieuwe JWT token).
   */
  router.post('/switch', orgLimiter, requireAuthMiddleware, async (req, res) => {
    const { organization_id } = req.body;
    const userId = (req as any).user?.sub || (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: { message: 'User not found', code: 'AUTH_INVALID' } });
      return;
    }

    const user = authService?.findUserById ? authService.findUserById(userId) : null;
    if (!user) {
      res.status(401).json({ error: { message: 'User not found', code: 'AUTH_INVALID' } });
      return;
    }

    if (user.organization_id && user.organization_id !== organization_id && organization_id !== 'default') {
      res.status(403).json({ error: { message: 'Organization mismatch', code: 'ORG_MISMATCH' } });
      return;
    }

    // Review fix: sign the REQUESTED organization into the replacement token —
    // without it the JWT keeps the original org and all scoped calls stay there.
    const targetUser = { ...user, organization_id: organization_id ?? user.organization_id ?? 'default' };
    const token = authService.generateToken(targetUser);
    if (auditService && typeof auditService.record === 'function') {
      auditService.record({
        event_type: 'organization.switch' as any,
        user_id: user.id,
        action: 'organization.switch',
        resource_type: 'user',
        resource_id: user.id,
        metadata: { from: user.organization_id || 'default', to: organization_id },
      });
    }

    res.json({ token });
  });

  return router;
}