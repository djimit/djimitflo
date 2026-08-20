import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { requestLogger } from '../middleware/request-logger';

function makeReq(): Request {
  return { method: 'GET', originalUrl: '/api/test', ip: '127.0.0.1' } as unknown as Request;
}
function makeRes(statusCode = 200): Response {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode,
    on: (event: string, cb: () => void) => { listeners[event] = cb; },
    emit: (event: string) => listeners[event]?.(),
  } as unknown as Response;
}

describe('request-logger middleware', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls next immediately', () => {
    const next = vi.fn();
    requestLogger(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('logs INFO for 2xx status', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes(200);
    requestLogger(makeReq(), res, vi.fn());
    res.emit('finish');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('INFO'));
  });

  it('logs WARN for 4xx status', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes(404);
    requestLogger(makeReq(), res, vi.fn());
    res.emit('finish');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('WARN'));
  });

  it('logs ERROR for 5xx status', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes(500);
    requestLogger(makeReq(), res, vi.fn());
    res.emit('finish');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });
});