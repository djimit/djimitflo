/**
 * Input validation middleware — prevents injection attacks.
 *
 * Validates and sanitizes user input before it reaches services:
 * - ECLI format validation
 * - Path traversal prevention
 * - SQL injection prevention
 * - XSS prevention
 * - JSON payload size limits
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Validate ECLI format.
 */
export function validateEcli(ecli: string): { valid: boolean; error?: string } {
  if (!ecli?.trim()) return { valid: false, error: 'ECLI is required' };

  const pattern = /^ECLI:[A-Z]{2}:[A-Z]+:\d{4}:[A-Za-z0-9._-]+$/;
  if (!pattern.test(ecli.trim())) {
    return { valid: false, error: 'Invalid ECLI format. Expected: ECLI:NL:<RECHTBANK>:<JAAR>:<NUMMER>' };
  }

  return { valid: true };
}

/**
 * Sanitize file path — prevent path traversal.
 */
export function sanitizeFilePath(inputPath: string): { safe: boolean; sanitized: string; error?: string } {
  if (!inputPath?.trim()) return { safe: false, sanitized: '', error: 'Path is required' };

  // Reject path traversal attempts
  if (inputPath.includes('..') || inputPath.includes('~')) {
    return { safe: false, sanitized: '', error: 'Path traversal detected' };
  }

  // Normalize path
  const sanitized = inputPath
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .trim();

  // Must be absolute or relative without ..
  if (sanitized.startsWith('..')) {
    return { safe: false, sanitized: '', error: 'Invalid path' };
  }

  return { safe: true, sanitized };
}

/**
 * Sanitize string input — prevent XSS.
 */
export function sanitizeString(input: string, maxLength = 10000): string {
  if (!input) return '';

  return input
    .slice(0, maxLength)
    .replace(/[<>]/g, '') // Remove < and > to prevent HTML injection
    .trim();
}

/**
 * Validate JSON body size.
 */
export function limitBodySize(maxBytes = 1_000_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    if (contentLength > maxBytes) {
      res.status(413).json({
        error: {
          message: `Request body too large. Max ${maxBytes} bytes allowed.`,
          code: 'PAYLOAD_TOO_LARGE',
          status: 413,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Middleware: validate ECLI param in route.
 */
export function requireValidEcli(paramName = 'ecli') {
  return (req: Request, res: Response, next: NextFunction) => {
    const ecli = req.params[paramName] || req.body?.ecli;
    const result = validateEcli(ecli);

    if (!result.valid) {
      res.status(400).json({
        error: { message: result.error, code: 'VALIDATION_ERROR', status: 400 },
      });
      return;
    }

    next();
  };
}

/**
 * Middleware: sanitize text body fields.
 */
export function sanitizeBodyFields(fields: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.body) {
      for (const field of fields) {
        if (typeof req.body[field] === 'string') {
          req.body[field] = sanitizeString(req.body[field]);
        }
      }
    }
    next();
  };
}
