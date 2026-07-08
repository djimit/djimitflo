import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { securityHeaders } from '../middleware/security-headers';

function createMockResponse(): Response {
  const headers: Record<string, string> = {};
  return {
    setHeader: vi.fn((key: string, value: string) => { headers[key] = value; }),
    getHeader: (key: string) => headers[key],
  } as unknown as Response;
}

describe('securityHeaders', () => {
  it('sets X-Content-Type-Options to nosniff', () => {
    const res = createMockResponse();
    const next = vi.fn();

    securityHeaders({} as Request, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });

  it('sets X-Frame-Options to DENY', () => {
    const res = createMockResponse();
    const next = vi.fn();

    securityHeaders({} as Request, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
  });

  it('sets Referrer-Policy', () => {
    const res = createMockResponse();
    const next = vi.fn();

    securityHeaders({} as Request, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  it('sets X-XSS-Protection to 0', () => {
    const res = createMockResponse();
    const next = vi.fn();

    securityHeaders({} as Request, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
  });

  it('calls next() to continue middleware chain', () => {
    const res = createMockResponse();
    const next = vi.fn();

    securityHeaders({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
