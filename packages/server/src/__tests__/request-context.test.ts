import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requestContext } from '../middleware/request-context';

describe('request-context middleware', () => {
  it('sets X-Request-ID header on response', () => {
    const req = { headers: {} } as unknown as Request;
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    requestContext(req, res, vi.fn());
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
  });

  it('preserves incoming X-Request-ID header', () => {
    const req = { headers: { 'x-request-id': 'test-123' } } as unknown as Request;
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    requestContext(req, res, vi.fn());
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', 'test-123');
    expect((req as any).requestId).toBe('test-123');
  });

  it('generates a UUID when no header present', () => {
    const req = { headers: {} } as unknown as Request;
    requestContext(req, { setHeader: vi.fn() } as unknown as Response, vi.fn());
    expect((req as any).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});