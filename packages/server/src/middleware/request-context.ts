/**
 * Request Context — correlation ID injection for distributed tracing.
 *
 * Injects X-Request-ID into every request and response for log correlation.
 */

import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// An inbound id is echoed into a response header and logs, so only a short plain token is trusted.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const requestId = typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  (req as any).requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}
