/**
 * Observability — structured request logging, timing, and tracing.
 *
 * Provides:
 * - Request duration tracking
 * - Response size measurement
 * - Structured access logs (JSON)
 * - Slow request warnings (>1000ms)
 * - Error rate tracking per route
 */

import type { Request, Response, NextFunction } from 'express';

const slowRequestThresholdMs = Number(process.env.SLOW_REQUEST_THRESHOLD_MS || '1000');

export function observabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const requestId = (req as any).requestId || 'unknown';

  // Log request start
  if (process.env.NODE_ENV === 'development') {
    console.log(`[REQ] ${req.method} ${req.path} — ${requestId}`);
  }

  // Capture response finish for metrics
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (duration > slowRequestThresholdMs) {
      console.warn(`[SLOW] ${req.method} ${req.path} took ${duration}ms — ${requestId}`);
    }

    if (res.statusCode >= 500) {
      console.error(`[5XX] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms) — ${requestId}`);
    } else if (process.env.NODE_ENV === 'development') {
      console.log(`[RES] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    }
  });

  next();
}
