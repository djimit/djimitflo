import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  validateEcli,
  sanitizeFilePath,
  sanitizeString,
  limitBodySize,
  requireValidEcli,
  sanitizeBodyFields,
} from '../middleware/input-validation';

describe('validateEcli', () => {
  it('accepts valid ECLI format', () => {
    expect(validateEcli('ECLI:NL:RBROT:2024:1234').valid).toBe(true);
    expect(validateEcli('ECLI:NL:HR:2023:ABC-123').valid).toBe(true);
  });

  it('rejects empty input', () => {
    expect(validateEcli('').valid).toBe(false);
    expect(validateEcli(undefined as any).valid).toBe(false);
  });

  it('rejects invalid format', () => {
    expect(validateEcli('invalid').valid).toBe(false);
    expect(validateEcli('ECLI:XX:YY:ZZ:123').valid).toBe(false);
    expect(validateEcli('ECLI:nl:rbrot:2024:1234').valid).toBe(false);
  });
});

describe('sanitizeFilePath', () => {
  it('accepts safe paths', () => {
    expect(sanitizeFilePath('/src/services/auth.ts').safe).toBe(true);
    expect(sanitizeFilePath('packages/server/src').safe).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(sanitizeFilePath('../../../etc/passwd').safe).toBe(false);
    expect(sanitizeFilePath('/src/../../secret').safe).toBe(false);
    expect(sanitizeFilePath('~/ssh/key').safe).toBe(false);
  });

  it('normalizes double slashes', () => {
    const result = sanitizeFilePath('/src//services///auth.ts');
    expect(result.safe).toBe(true);
    expect(result.sanitized).toBe('/src/services/auth.ts');
  });

  it('rejects empty input', () => {
    expect(sanitizeFilePath('').safe).toBe(false);
  });
});

describe('sanitizeString', () => {
  it('removes HTML tags to prevent XSS', () => {
    expect(sanitizeString('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
  });

  it('enforces max length', () => {
    const long = 'a'.repeat(20000);
    expect(sanitizeString(long).length).toBe(10000);
  });

  it('handles empty/null input', () => {
    expect(sanitizeString('')).toBe('');
    expect(sanitizeString(null as any)).toBe('');
    expect(sanitizeString(undefined as any)).toBe('');
  });

  it('trims whitespace', () => {
    expect(sanitizeString('  hello  ')).toBe('hello');
  });
});

describe('limitBodySize', () => {
  it('allows requests under the limit', () => {
    const middleware = limitBodySize(1000);
    const req = { headers: { 'content-length': '500' } } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks requests over the limit', () => {
    const middleware = limitBodySize(1000);
    const req = { headers: { 'content-length': '2000' } } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireValidEcli middleware', () => {
  it('passes valid ECLI param', () => {
    const middleware = requireValidEcli('ecli');
    const req = { params: { ecli: 'ECLI:NL:RBROT:2024:1234' } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects invalid ECLI param', () => {
    const middleware = requireValidEcli('ecli');
    const req = { params: { ecli: 'invalid' } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('sanitizeBodyFields middleware', () => {
  it('sanitizes specified string fields', () => {
    const middleware = sanitizeBodyFields(['title', 'description']);
    const req = { body: { title: '<b>Hello</b>', description: 'Normal text', count: 42 } } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(req.body.title).toBe('bHello/b');
    expect(req.body.description).toBe('Normal text');
    expect(req.body.count).toBe(42);
    expect(next).toHaveBeenCalled();
  });

  it('handles missing body gracefully', () => {
    const middleware = sanitizeBodyFields(['title']);
    const req = { body: undefined } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
