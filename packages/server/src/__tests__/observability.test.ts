import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { observabilityMiddleware } from '../middleware/observability';

function makeReq(path = '/api/test', method = 'GET'): Request {
  return { method, path, headers: {} } as unknown as Request;
}
function makeRes(statusCode = 200): Response {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode,
    on: (event: string, cb: () => void) => { listeners[event] = cb; },
    emit: (event: string) => listeners[event]?.(),
    setHeader: vi.fn(),
  } as unknown as Response;
}

describe('observability middleware', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls next immediately', () => {
    const next = vi.fn();
    observabilityMiddleware(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('logs slow requests on finish', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2000);
    const res = makeRes();
    observabilityMiddleware(makeReq(), res, vi.fn());
    res.emit('finish');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SLOW]'));
  });

  it('logs 5xx errors on finish', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes(500);
    observabilityMiddleware(makeReq('/api/fail', 'POST'), res, vi.fn());
    res.emit('finish');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[5XX]'));
  });
});