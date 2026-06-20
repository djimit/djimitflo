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

  // L3: spawn control middleware — admits either a user JWT or a scoped X-Spawn-Token.
  // Rejects with AUTH_REQUIRED when neither is present, AUTH_INVALID for a malformed
  // Bearer. X-Spawn-Token-only requests pass through; the spawn route validates the token.
  function requireAuthOrSpawnToken(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const hasSpawnToken = typeof req.headers['x-spawn-token'] === 'string';
    if (!authHeader && !hasSpawnToken) {
      res.status(401).json({ error: { message: 'Authentication required', code: 'AUTH_REQUIRED' } });
      return;
    }
    if (authHeader) {
      if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: { message: 'Invalid or expired token', code: 'AUTH_INVALID' } });
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
    }
    next();
  }

  return { requireAuth, requirePermission, optionalAuth, requireAuthOrSpawnToken };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;