import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { createError, errorHandler, ApiError } from '../middleware/error-handler';

describe('createError', () => {
  it('creates an error with status, message, and code', () => {
    const err = createError(400, 'Bad Request', 'INVALID_INPUT');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Bad Request');
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('creates an error without code', () => {
    const err = createError(500, 'Internal Error');
    expect(err.status).toBe(500);
    expect(err.message).toBe('Internal Error');
    expect(err.code).toBeUndefined();
  });

  it('creates errors for all HTTP status codes used in routes', () => {
    const statuses = [400, 401, 403, 404, 409, 422, 500, 502, 503];
    for (const status of statuses) {
      const err = createError(status, `Error ${status}`, `CODE_${status}`);
      expect(err.status).toBe(status);
    }
  });

  it('creates ApiError-compatible objects', () => {
    const err: ApiError = createError(409, 'conflict', 'CONFLICT');
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err instanceof Error).toBe(true);
  });
});

describe('errorHandler', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    req = { method: 'GET', path: '/test' };
    res = { status: statusMock };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns structured error response with status, message, code', () => {
    const err = createError(400, 'Bad Request', 'INVALID_INPUT');
    errorHandler(err, req as Request, res as Response, vi.fn() as NextFunction);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Bad Request',
          code: 'INVALID_INPUT',
          status: 400,
        }),
      })
    );
  });

  it('defaults to 500 when error has no status', () => {
    const err = new Error('Something broke');
    errorHandler(err, req as Request, res as Response, vi.fn() as NextFunction);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Something broke',
          code: 'INTERNAL_ERROR',
          status: 500,
        }),
      })
    );
  });

  it('defaults message to Internal Server Error when empty', () => {
    const err = new Error('');
    errorHandler(err, req as Request, res as Response, vi.fn() as NextFunction);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Internal Server Error',
          code: 'INTERNAL_ERROR',
        }),
      })
    );
  });

  it('includes stack trace in development mode', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const err = createError(500, 'Dev Error', 'DEV_ERROR');
    errorHandler(err, req as Request, res as Response, vi.fn() as NextFunction);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          stack: expect.any(String),
        }),
      })
    );

    process.env.NODE_ENV = originalEnv;
  });

  it('omits stack trace in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const err = createError(500, 'Prod Error', 'PROD_ERROR');
    errorHandler(err, req as Request, res as Response, vi.fn() as NextFunction);

    const callArg = jsonMock.mock.calls[0][0];
    expect(callArg.error).toBeDefined();
    expect(callArg.error.stack).toBeUndefined();

    process.env.NODE_ENV = originalEnv;
  });

  it('handles all loop-specific error codes with correct status', () => {
    const loopErrors = [
      { code: 'LOOP_RUN_NOT_FOUND', status: 404 },
      { code: 'LOOP_NAME_UNSUPPORTED', status: 400 },
      { code: 'LOOP_HUMAN_APPROVAL_REQUIRED', status: 409 },
      { code: 'LOOP_COMPLETION_LEASES_INCOMPLETE', status: 409 },
      { code: 'LOOP_TOKEN_BUDGET_EXHAUSTED', status: 409 },
      { code: 'LOOP_RETRY_BUDGET_EXHAUSTED', status: 409 },
      { code: 'LOOP_WORKER_BUDGET_EXHAUSTED', status: 409 },
      { code: 'LOOP_FINDING_NOT_FOUND', status: 404 },
      { code: 'LOOP_REPOSITORY_REQUIRED', status: 400 },
    ];

    for (const { code, status } of loopErrors) {
      const err = createError(status, `test ${code}`, code);
      const localJsonMock = vi.fn();
      const localStatusMock = vi.fn().mockReturnValue({ json: localJsonMock });
      errorHandler(err, req as Request, { status: localStatusMock } as unknown as Response, vi.fn() as NextFunction);
      expect(localStatusMock).toHaveBeenCalledWith(status);
    }
  });
});
