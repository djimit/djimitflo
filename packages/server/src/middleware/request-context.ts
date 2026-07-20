/**
 * Request Context — correlation ID injection for distributed tracing.
 *
 * Injects X-Request-ID into every request and response for log correlation.
 */

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  (req as any).requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}
