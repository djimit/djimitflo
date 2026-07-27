/**
 * Global error handler middleware
 */

import { Request, Response, NextFunction } from 'express';

export interface ApiError extends Error {
  status?: number;
  code?: string;
}

export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  const code = err.code || 'INTERNAL_ERROR';
  const requestId = (req as Request & { requestId?: string }).requestId;

  if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  } else {
    console.warn(`[WARN] ${req.method} ${req.path}: ${code}`);
  }

  res.status(status).json({
    error: {
      message,
      code,
      status,
      ...(requestId && { requestId }),
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
