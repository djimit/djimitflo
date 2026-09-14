import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { requestLogger } from '../middleware/request-logger';

function makeReq(originalUrl = '/api/test'): Request {
  return { method: 'GET', originalUrl, path: originalUrl.split('?')[0], ip: '127.0.0.1' } as unknown as Request;
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

  it('omits query strings from join-status logs but preserves other query logging', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const joinRes = makeRes(401);
    requestLogger(makeReq('/API/SWARM-V2/SOCIAL-RUNTIME/JOIN/WANDERER/STATUS?secret=top-secret'), joinRes, vi.fn());
    joinRes.emit('finish');
    const normalRes = makeRes(200);
    requestLogger(makeReq('/api/tasks?state=pending'), normalRes, vi.fn());
    normalRes.emit('finish');

    expect(logSpy.mock.calls[0]?.[0]).toContain('/API/SWARM-V2/SOCIAL-RUNTIME/JOIN/WANDERER/STATUS 401');
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('top-secret');
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('?');
    expect(logSpy.mock.calls[1]?.[0]).toContain('/api/tasks?state=pending');
  });

  it('logs ERROR for 5xx status', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = makeRes(500);
    requestLogger(makeReq(), res, vi.fn());
    res.emit('finish');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });
});
