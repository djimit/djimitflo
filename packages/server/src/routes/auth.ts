/**
 * Authentication routes — login, current user, logout
 */

import { Router, Request, Response } from 'express';
import { AuthService } from '../services/auth-service';
import { AuthMiddleware } from '../middleware/auth';

export function createAuthRoutes(authService: AuthService, auth: AuthMiddleware): Router {
  const router = Router();

  router.post('/login', (req: Request, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: { message: 'Email and password are required', code: 'VALIDATION_ERROR' } });
      return;
    }

    const result = authService.authenticate(email, password);
    if (!result) {
      res.status(401).json({ error: { message: 'Invalid credentials', code: 'AUTH_FAILED' } });
      return;
    }

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

  router.post('/logout', (_req: Request, res: Response) => {
    res.json({ message: 'Logged out successfully' });
  });

  return router;
}