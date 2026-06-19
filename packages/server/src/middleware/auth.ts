/**
 * Authentication and authorization middleware for Express
 */

import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth-service';
import { ROLE_PERMISSIONS, type UserRole, type AuthTokenPayload } from '@djimitflo/shared';

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

export function createAuthMiddleware(authService: AuthService) {
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: { message: 'Authentication required', code: 'AUTH_REQUIRED' } });
      return;
    }

    const token = authHeader.substring(7);
    const payload = authService.verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: { message: 'Invalid or expired token', code: 'AUTH_INVALID' } });
      return;
    }

    const user = authService.findUserById(payload.sub);
    if (!user || !user.isActive) {
      res.status(401).json({ error: { message: 'User account disabled', code: 'AUTH_DISABLED' } });
      return;
    }

    req.user = payload;
    next();
  }

  function requirePermission(permission: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.user) {
        res.status(401).json({ error: { message: 'Authentication required', code: 'AUTH_REQUIRED' } });
        return;
      }

      const role = req.user.role as UserRole;
      const permissions = ROLE_PERMISSIONS[role];
      if (!permissions || !permissions.includes(permission)) {
        res.status(403).json({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } });
        return;
      }

      next();
    };
  }

  function optionalAuth(req: Request, _res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = authService.verifyToken(token);
      if (payload) {
        const user = authService.findUserById(payload.sub);
        if (user && user.isActive) {
          req.user = payload;
        }
      }
    }
    next();
  }

  /**
   * Authentication path for the nested-spawn control endpoint (L3): a spawned
   * runtime child has no user session, so it cannot present a Bearer JWT. Instead
   * it presents a scoped spawn token in the `X-Spawn-Token` header. This
   * middleware admits EITHER credential:
   *   - `Authorization: Bearer <jwt>`  → verified, sets req.user (the user path).
   *     A malformed/expired Bearer returns 401 AUTH_INVALID and does NOT fall
   *     through to the spawn token — a malformed Bearer is an attack signal, not
   *     a child, and silently retrying it as a token would mask the failure.
   *   - `X-Spawn-Token: <scoped token>`  → passes through with req.user UNSET. The
   *     real scoped validation happens downstream in NestedSpawnService.requestSpawn
   *     (which checks lease+tree scope + expiry); a bad token surfaces as
   *     SPAWN_TOKEN_INVALID → 401 via mapSpawnError.
   *   - neither header  → 401 AUTH_REQUIRED.
   * Routes that additionally need a user permission (e.g. POST /spawns/root with
   * write:swarm_action) sit behind requirePermission, which 401s a token-only
   * caller (req.user unset) — so only operators create roots, never children.
   */
  function requireAuthOrSpawnToken(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = authService.verifyToken(token);
      if (!payload) {
        res.status(401).json({ error: { message: 'Invalid or expired token', code: 'AUTH_INVALID' } });
        return;
      }
      const user = authService.findUserById(payload.sub);
      if (!user || !user.isActive) {
        res.status(401).json({ error: { message: 'User account disabled', code: 'AUTH_DISABLED' } });
        return;
      }
      req.user = payload;
      next();
      return;
    }
    if (req.get('X-Spawn-Token')) {
      // Token-only child: real scope/expiry validation is in the route + service.
      next();
      return;
    }
    res.status(401).json({ error: { message: 'Authentication required', code: 'AUTH_REQUIRED' } });
  }

  return { requireAuth, requirePermission, optionalAuth, requireAuthOrSpawnToken };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;