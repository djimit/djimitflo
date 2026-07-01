import { describe, expect, it } from 'vitest';
import { createError } from '../middleware/error-handler';

describe('error-handler', () => {
  it('should create an error with status code', () => {
    const err = createError(404, 'Resource not found', 'NOT_FOUND');
    expect(err).toBeDefined();
    expect(err.message).toBe('Resource not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('should create an error without code', () => {
    const err = createError(500, 'Internal error');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  it('should create common errors', () => {
    const badRequest = createError(400, 'Bad request', 'BAD_REQUEST');
    expect(badRequest.statusCode).toBe(400);

    const unauthorized = createError(401, 'Unauthorized', 'UNAUTHORIZED');
    expect(unauthorized.statusCode).toBe(401);

    const forbidden = createError(403, 'Forbidden', 'FORBIDDEN');
    expect(forbidden.statusCode).toBe(403);

    const notFound = createError(404, 'Not found', 'NOT_FOUND');
    expect(notFound.statusCode).toBe(404);

    const internal = createError(500, 'Internal error', 'INTERNAL_ERROR');
    expect(internal.statusCode).toBe(500);
  });

  it('should create error with custom status', () => {
    const err = createError(418, 'I am a teapot', 'TEAPOT');
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe('TEAPOT');
  });

  it('should expose isOperational flag', () => {
    const err = createError(400, 'Bad request');
    expect(err.isOperational).toBe(true);
  });
});
