/**
 * Authentication routes — login, current user, logout
 */

import { Router, Request, Response } from 'express';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { AuthMiddleware } from '../middleware/auth';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { loginRateLimiter } from '../middleware/rate-limiter';

export function createAuthRoutes(authService: AuthService, auth: AuthMiddleware, auditService: AuditService): Router {
  const router = Router();

  router.post('/login', (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    const rateCheck = loginRateLimiter.check(ip);
    if (!rateCheck.allowed) {
      res.status(429).json({ error: { message: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED' } });
      return;
    }

    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: { message: 'Email and password are required', code: 'VALIDATION_ERROR' } });
      return;
    }

    const result = authService.authenticate(email, password);
    if (!result) {
      loginRateLimiter.recordFailure(ip);
      res.status(401).json({ error: { message: 'Invalid credentials', code: 'AUTH_FAILED' } });
      return;
    }

    loginRateLimiter.reset(ip);

    auditService.record({
      event_type: AuditEventType.AUTH_LOGIN,
      user_id: result.user.id,
      action: 'auth.login',
      resource_type: 'user',
      resource_id: result.user.id,
      risk_level: RiskLevel.LOW,
    });

    res.json({ token: result.token, user: result.user });
  });

  router.get('/me', auth.requireAuth, (req: Request, res: Response) => {
    const user = authService.findUserById(req.user!.sub);
    if (!user) {
      res.status(401).json({ error: { message: 'User not found', code: 'AUTH_INVALID' } });
      return;
    }
    res.json({ user });
  });

  router.post('/logout', auth.optionalAuth, (req: Request, res: Response) => {
    if (req.user) {
      auditService.record({
        event_type: AuditEventType.AUTH_LOGOUT,
        user_id: req.user.sub,
        action: 'auth.logout',
        resource_type: 'user',
        resource_id: req.user.sub,
        risk_level: RiskLevel.LOW,
      });
    }
    res.json({ success: true });
  });

  return router;
}