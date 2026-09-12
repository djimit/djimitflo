/**
 * Authentication routes — login, current user, logout
 */

import { Router, Request, Response, type CookieOptions } from 'express';
import { AuthService } from '../services/auth-service';
import { AuditService } from '../services/audit-service';
import { AuthMiddleware } from '../middleware/auth';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { loginRateLimiter } from '../middleware/rate-limiter';

const REFRESH_COOKIE = 'djimitflo_refresh';
const browserSession = (req: Request) => req.get('X-Djimitflo-Session') === 'browser';

function cookieOptions(): CookieOptions {
  const override = process.env.AUTH_COOKIE_SECURE;
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/auth',
    secure: override === 'true' || (override !== 'false' && process.env.NODE_ENV === 'production'),
  };
}

function refreshCookie(req: Request): string | null {
  const matches = (req.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${REFRESH_COOKIE}=`));
  if (matches.length !== 1) return null;
  try { return decodeURIComponent(matches[0].slice(REFRESH_COOKIE.length + 1)) || null; }
  catch { return null; }
}

export function createAuthRoutes(authService: AuthService, auth: AuthMiddleware, auditService: AuditService): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  function setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), maxAge: 30 * 24 * 60 * 60 * 1000 });
  }

  router.post('/login', (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    const rateCheck = loginRateLimiter.check(ip);
    if (!rateCheck.allowed) {
      res.status(429).json({ error: { message: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED' } });
      return;
    }

    const { email, password } = req.body ?? {};

    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      res.status(400).json({ error: { message: 'Email and password are required', code: 'VALIDATION_ERROR' } });
      return;
    }

    if (browserSession(req)) {
      const result = authService.withSessionTransaction(() => {
        const authenticated = authService.authenticateWithRefresh(email, password);
        if (!authenticated) return null;
        auditService.record({
          event_type: AuditEventType.AUTH_LOGIN,
          user_id: authenticated.user.id,
          action: 'auth.login',
          resource_type: 'user',
          resource_id: authenticated.user.id,
          risk_level: RiskLevel.LOW,
          metadata: { channel: 'browser' },
        });
        return authenticated;
      });
      if (!result) {
        loginRateLimiter.recordFailure(ip);
        res.status(401).json({ error: { message: 'Invalid credentials', code: 'AUTH_FAILED' } });
        return;
      }
      loginRateLimiter.reset(ip);
      setRefreshCookie(res, result.tokens.refresh_token);
      res.json({ token: result.tokens.access_token, user: result.user, expires_in: result.tokens.expires_in });
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

  router.post('/refresh', (req: Request, res: Response) => {
    // Required non-simple header plus the server's explicit-origin CORS policy
    // prevents a cross-origin page from using ambient browser credentials.
    if (!browserSession(req)) {
      res.status(403).json({ error: { message: 'Browser session header required', code: 'SESSION_HEADER_REQUIRED' } });
      return;
    }
    const organizationId = req.body?.organization_id;
    if (organizationId !== undefined && (typeof organizationId !== 'string' || !organizationId.trim())) {
      res.status(400).json({ error: { message: 'organization_id must be a nonempty string', code: 'VALIDATION_ERROR' } });
      return;
    }
    const cookie = refreshCookie(req);
    const result = cookie ? authService.withSessionTransaction(() => {
      const tokens = authService.rotateRefreshToken(cookie, organizationId);
      if (!tokens) return null;
      const payload = authService.verifyToken(tokens.access_token);
      const user = payload && authService.findUserById(payload.sub);
      if (!user) throw new Error('Refreshed session has no current user');
      auditService.record({
        event_type: AuditEventType.AUTH_LOGIN,
        user_id: user.id,
        action: 'auth.refresh',
        resource_type: 'user',
        resource_id: user.id,
        risk_level: RiskLevel.LOW,
        metadata: { channel: 'browser' },
      });
      return { tokens, user };
    }) : null;
    if (!result) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      res.status(401).json({ error: { message: 'Invalid or expired browser session', code: 'AUTH_INVALID' } });
      return;
    }
    setRefreshCookie(res, result.tokens.refresh_token);
    res.json({ token: result.tokens.access_token, user: result.user, expires_in: result.tokens.expires_in });
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
    if (browserSession(req)) {
      const cookie = refreshCookie(req);
      authService.withSessionTransaction(() => {
        const sessions: { user_id: string; session_id: string }[] = [];
        const cookieSession = cookie ? authService.revokeSessionFamily(cookie) : null;
        if (cookieSession) sessions.push(cookieSession);
        // The current authenticated principal can close its own session even
        // if browser cookie storage was cleared. Never accept user/body IDs.
        if (req.user?.sid && !(cookieSession?.user_id === req.user.sub && cookieSession.session_id === req.user.sid)
          && authService.revokeAuthenticatedSession(req.user.sub, req.user.sid)) {
          sessions.push({ user_id: req.user.sub, session_id: req.user.sid });
        }
        for (const session of sessions) {
          auditService.record({
            event_type: AuditEventType.AUTH_LOGOUT,
            user_id: session.user_id,
            action: 'auth.logout',
            resource_type: 'user',
            resource_id: session.user_id,
            risk_level: RiskLevel.LOW,
            metadata: { channel: 'browser' },
          });
        }
      });
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      res.json({ success: true });
      return;
    }
    if ((req.headers.cookie ?? '').split(';').some(part => part.trim().startsWith(`${REFRESH_COOKIE}=`))) {
      res.status(403).json({ error: { message: 'Browser session header required', code: 'SESSION_HEADER_REQUIRED' } });
      return;
    }
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
