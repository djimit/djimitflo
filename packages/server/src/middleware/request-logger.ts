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
    const isJoinStatus = /^\/api\/swarm-v2\/social-runtime\/join\/[^/]+\/status\/?$/i.test(req.path);
    const loggedUrl = isJoinStatus ? req.path : req.originalUrl;
    
    const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    
    console.log(
      `[${level}] ${method} ${loggedUrl} ${statusCode} ${duration}ms - ${ip}`
    );
  });
  
  next();
}
