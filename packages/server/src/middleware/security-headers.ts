/**
 * Security headers middleware for Express.
 *
 * Implements defense-in-depth HTTP security headers including:
 * - Strict-Transport-Security (HSTS)
 * - Content-Security-Policy (CSP) — strict but compatible with Vite dashboard
 * - X-Content-Type-Options
 * - X-Frame-Options
 * - Referrer-Policy
 * - Permissions-Policy
 */

import { Request, Response, NextFunction } from 'express';

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Control referrer information leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Disable XSS filter (modern browsers rely on CSP instead)
  res.setHeader('X-XSS-Protection', '0');

  // HSTS — force HTTPS for 1 year (only in production)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Permissions Policy — disable unnecessary browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Content Security Policy — strict but compatible with Vite-built dashboard
  // - 'self' for same-origin resources
  // - 'unsafe-inline' for styles required by Tailwind CSS
  // - 'unsafe-eval' required by Vite dev mode (disabled in production builds)
  // - data: for inline images (SVGs)
  // - blob: for Web Workers
  const isDev = process.env.NODE_ENV !== 'production';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);

  next();
}
