import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler, createError, ApiError } from '../middleware/error-handler';

function createMockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response;
  return res;
}

describe('errorHandler', () => {
  it('returns 500 with default message for generic errors', () => {
    const err = new Error('Something broke');
    const res = createMockResponse();

    errorHandler(err, { method: 'GET', path: '/test' } as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        message: 'Something broke',
        status: 500,
        code: 'INTERNAL_ERROR',
      }),
    }));
  });

  it('uses custom status and code from ApiError', () => {
    const err = createError(404, 'Not found', 'RESOURCE_NOT_FOUND');
    const res = createMockResponse();

    errorHandler(err, { method: 'GET', path: '/missing' } as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        message: 'Not found',
        status: 404,
        code: 'RESOURCE_NOT_FOUND',
      }),
    }));
  });

  it('includes stack trace in development mode', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const err = new Error('Dev error');
    const res = createMockResponse();

    errorHandler(err, { method: 'POST', path: '/api/test' } as Request, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        stack: expect.any(String),
      }),
    }));

    process.env.NODE_ENV = originalEnv;
  });

  it('handles errors without message', () => {
    const err = new Error();
    const res = createMockResponse();

    errorHandler(err, { method: 'GET', path: '/' } as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        message: 'Internal Server Error',
      }),
    }));
  });
});

describe('createError', () => {
  it('creates an error with status and code', () => {
    const err = createError(403, 'Forbidden', 'ACCESS_DENIED');

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Forbidden');
    expect(err.status).toBe(403);
    expect(err.code).toBe('ACCESS_DENIED');
  });

  it('creates an error without code', () => {
    const err = createError(400, 'Bad request');

    expect(err.status).toBe(400);
    expect(err.code).toBeUndefined();
  });
});
