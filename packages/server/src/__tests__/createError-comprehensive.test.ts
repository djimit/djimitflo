import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createError, errorHandler, ApiError } from '../middleware/error-handler';

/**
 * Comprehensive test suite for createError (238 callers) and errorHandler.
 * These are the most-called untested functions in the entire codebase.
 */
describe('createError', () => {
  it('creates error with status, message, and code', () => {
    const err = createError(400, 'Bad Request', 'INVALID_INPUT');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Bad Request');
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('creates error without code', () => {
    const err = createError(500, 'Internal Error');
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
  });

  it('creates all standard HTTP error codes', () => {
    const codes = [400, 401, 403, 404, 409, 422, 500, 502, 503];
    for (const status of codes) {
      const err = createError(status, `Error ${status}`, `CODE_${status}`);
      expect(err.status).toBe(status);
      expect(err.message).toBe(`Error ${status}`);
      expect(err.code).toBe(`CODE_${status}`);
    }
  });

  it('preserves error message for empty string', () => {
    const err = createError(400, '', 'EMPTY');
    expect(err.message).toBe('');
  });

  it('handles special characters in message', () => {
    const err = createError(400, 'Error: <script>alert("xss")</script>', 'XSS');
    expect(err.message).toContain('<script>');
  });
});

describe('errorHandler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns structured error response', () => {
    const err = createError(400, 'Bad Request', 'VALIDATION_ERROR');
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    errorHandler(err, { method: 'GET', path: '/test' } as any, { status: statusMock } as any, vi.fn() as any);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        message: 'Bad Request',
        code: 'VALIDATION_ERROR',
        status: 400,
      }),
    }));
  });

  it('defaults to 500 when error has no status', () => {
    const err = new Error('Unknown error');
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    errorHandler(err, { method: 'GET', path: '/test' } as any, { status: statusMock } as any, vi.fn() as any);

    expect(statusMock).toHaveBeenCalledWith(500);
    const response = jsonMock.mock.calls[0][0];
    expect(response.error.code).toBe('INTERNAL_ERROR');
  });

  it('does NOT include stack trace in production', () => {
    process.env.NODE_ENV = 'production';
    const err = createError(500, 'Server Error', 'SERVER_ERROR');
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    errorHandler(err, { method: 'POST', path: '/api/test' } as any, { status: statusMock } as any, vi.fn() as any);

    const response = jsonMock.mock.calls[0][0];
    expect(response.error.stack).toBeUndefined();
  });

  it('includes stack trace in development', () => {
    process.env.NODE_ENV = 'development';
    const err = createError(500, 'Dev Error', 'DEV_ERROR');
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    errorHandler(err, { method: 'POST', path: '/api/test' } as any, { status: statusMock } as any, vi.fn() as any);

    const response = jsonMock.mock.calls[0][0];
    expect(response.error.stack).toBeDefined();
    expect(response.error.stack).toContain('Error');
  });

  it('handles error with empty message', () => {
    const err = new Error('');
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    expect(() => {
      errorHandler(err, { method: 'GET', path: '/test' } as any, { status: statusMock } as any, vi.fn() as any);
    }).not.toThrow();
  });

  it('handles all DjimFlo-specific error codes', () => {
    const djimitfloCodes = [
      'LOOP_RUN_NOT_FOUND', 'LOOP_NAME_UNSUPPORTED', 'LOOP_HUMAN_APPROVAL_REQUIRED',
      'LOOP_COMPLETION_LEASES_INCOMPLETE', 'LOOP_TOKEN_BUDGET_EXHAUSTED',
      'WORKER_LEASE_NOT_FOUND', 'WORKER_LEASE_NOT_STOPPABLE',
      'SWARM_INTELLIGENCE_SECRET_DETECTED', 'KNOWLEDGE_RUNTIME_OKF_BASE_MISSING',
      'PROOF_RUN_NOT_FOUND', 'PROOF_RUN_RUNTIME_FAILED',
      'AGENT_NOT_FOUND', 'GOAL_NOT_FOUND',
    ];

    for (const code of djimitfloCodes) {
      const err = createError(400, `Test ${code}`, code);
      expect(err.code).toBe(code);
    }
  });
});
