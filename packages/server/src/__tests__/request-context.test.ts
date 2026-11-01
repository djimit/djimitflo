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
it('UXE-08: request context is mounted at startup before the API, health and dashboard handlers', async () => {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const startup = readFileSync(join(__dirname, '../index.ts'), 'utf8');
  const middleware = startup.indexOf('app.use(requestContext)');
  expect(middleware).toBeGreaterThan(startup.indexOf('app.use(securityHeaders)'));
  for (const handler of ["app.get('/health'", "app.use('/api'", "app.use('/explore'", 'app.use(express.static']) {
    expect(startup.indexOf(handler)).toBeGreaterThan(middleware);
  }
});
