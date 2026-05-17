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
    
    const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    
    console.log(
      `[${level}] ${method} ${originalUrl} ${statusCode} ${duration}ms - ${ip}`
    );
  });
  
  next();
}
