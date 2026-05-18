/**
 * Security headers middleware for Express
 *
 * Adds common security headers to all responses.
 * CSP is not included in this phase — the Vite-built dashboard
 * uses inline styles (Tailwind) and inline scripts that would
 * require careful CSP tuning. CSP is documented as planned hardening.
 */

import { Request, Response, NextFunction } from 'express';

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  next();
}