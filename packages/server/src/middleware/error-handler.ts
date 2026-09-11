/**
 * Global error handler middleware
 */

import { Request, Response, NextFunction } from 'express';

export interface ApiError extends Error {
  status?: number;
  code?: string;
}

function inferredStatus(err: ApiError): number {
  if (err.status) return err.status;
  const code = err.code ?? '';
  const message = err.message ?? '';
  const marker = `${code} ${message}`;
  if (/(^|_)(NOT_FOUND|MISSING)\b/.test(marker) || /not found/i.test(message) || /^no activation\b/i.test(message)) return 404;
  if (/(REQUIRED|INVALID|MALFORMED|VALIDATION)/.test(marker)) return 400;
  if (/(NOT_PENDING|NOT_ACCEPTED|CONFLICT|ALREADY)/.test(marker)) return 409;
  if (/(UNAVAILABLE|NOT_CONFIGURED)/.test(marker)) return 503;
  return 500;
}

export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = inferredStatus(err);
  const message = err.message || 'Internal Server Error';
  const code = err.code || 'INTERNAL_ERROR';
  
  console.error('[ERROR]', req.method, req.path, err);
  
  res.status(status).json({
    error: {
      message,
      code,
      status,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
}

export function createError(status: number, message: string, code?: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.code = code;
  return error;
}
