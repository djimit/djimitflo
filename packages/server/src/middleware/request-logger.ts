/**
 * Request logging middleware
 */

import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, originalUrl, ip } = req;
    const { statusCode } = res;
    
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    console.log(JSON.stringify({
      level,
      event: 'http_request',
      requestId: (req as Request & { requestId?: string }).requestId,
      method,
      path: originalUrl,
      statusCode,
      durationMs: duration,
      ip,
    }));
  });
  
  next();
}
