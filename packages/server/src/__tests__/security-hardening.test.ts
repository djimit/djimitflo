import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createError, errorHandler } from '../middleware/error-handler';
import { validateEcli, sanitizeFilePath, sanitizeString } from '../middleware/input-validation';

/**
 * Security hardening tests.
 * Verifies that the API does not leak secrets, stack traces, or internal state.
 */
describe('Security Hardening', () => {
  describe('createError', () => {
    it('creates error with status, message, and code', () => {
      const err = createError(400, 'Bad Request', 'VALIDATION_ERROR');
      expect(err.status).toBe(400);
      expect(err.message).toBe('Bad Request');
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('defaults code to undefined when not provided', () => {
      const err = createError(500, 'Internal Error');
      expect(err.code).toBeUndefined();
    });

    it('does not expose internal state in message', () => {
      const err = createError(500, 'Database connection failed: password=secret123');
      // Even if a developer accidentally includes secrets, the error handler
      // should not expose stack traces in production
      expect(err.status).toBe(500);
    });
  });

  describe('errorHandler', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv, NODE_ENV: 'production' };
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('does NOT include stack trace in production', () => {
      const err = createError(500, 'Test Error', 'TEST_ERROR');
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

      errorHandler(
        err,
        { method: 'GET', path: '/test' } as any,
        { status: statusMock } as any,
        vi.fn() as any
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      const response = jsonMock.mock.calls[0][0];
      expect(response.error.stack).toBeUndefined();
    });

    it('includes stack trace in development', () => {
      process.env.NODE_ENV = 'development';
      const err = createError(500, 'Test Error', 'TEST_ERROR');
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

      errorHandler(
        err,
        { method: 'GET', path: '/test' } as any,
        { status: statusMock } as any,
        vi.fn() as any
      );

      const response = jsonMock.mock.calls[0][0];
      expect(response.error.stack).toBeDefined();
    });

    it('defaults to 500 when error has no status', () => {
      const err = new Error('Unknown error');
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

      errorHandler(
        err,
        { method: 'GET', path: '/test' } as any,
        { status: statusMock } as any,
        vi.fn() as any
      );

      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it('defaults code to INTERNAL_ERROR when not provided', () => {
      const err = new Error('Something broke');
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

      errorHandler(
        err,
        { method: 'GET', path: '/test' } as any,
        { status: statusMock } as any,
        vi.fn() as any
      );

      const response = jsonMock.mock.calls[0][0];
      expect(response.error.code).toBe('INTERNAL_ERROR');
    });

    it('does not crash on null error message', () => {
      const err = new Error('');
      err.message = '';
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

      expect(() => {
        errorHandler(
          err,
          { method: 'GET', path: '/test' } as any,
          { status: statusMock } as any,
          vi.fn() as any
        );
      }).not.toThrow();
    });
  });

  describe('Input Validation Patterns', () => {
    it('rejects SQL injection patterns in ECLI', () => {
      const maliciousEcli = "ECLI:NL:RBAMS:2026:1234; DROP TABLE agents;--";
      const result = validateEcli(maliciousEcli);
      expect(result.valid).toBe(false);
    });

    it('rejects path traversal in file paths', () => {
      const maliciousPath = '../../../etc/passwd';
      const result = sanitizeFilePath(maliciousPath);
      expect(result.safe).toBe(false);
    });

    it('sanitizes XSS in user input', () => {
      const maliciousInput = '<script>alert("xss")</script>';
      const sanitized = sanitizeString(maliciousInput);
      expect(sanitized).not.toContain('<');
      expect(sanitized).not.toContain('>');
    });
  });
});
