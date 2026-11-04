/**
 * Request logging middleware
 */

import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, ip } = req;
    const { statusCode } = res;
    // Query strings can carry tokens or user input; the route path is enough for operations.
    const loggedUrl = req.path;
    
    const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    
    console.log(
      `[${level}] ${method} ${loggedUrl} ${statusCode} ${duration}ms - ${ip}`
    );
  });
  
  next();
}
