import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers, get: (h: string) => headers[h.toLowerCase()] } as unknown as Request;
}
function mockRes(): Response & { statusCode: number; body: unknown } {
  const r = { statusCode: 200, body: undefined, status(v: number) { this.statusCode = v; return this; }, json(b: unknown) { this.body = b; return this; }, setHeader() {} } as unknown as Response & { statusCode: number; body: unknown };
  return r;
}

describe('auth middleware', () => {
  let authService: vi.Mocked<Pick<AuthService, 'verifyToken' | 'findUserById'>>;
  let mw: ReturnType<typeof createAuthMiddleware>;

  beforeEach(() => {
    authService = {
      verifyToken: vi.fn(),
      findUserById: vi.fn(),
    } as unknown as vi.Mocked<Pick<AuthService, 'verifyToken' | 'findUserById'>>;
    mw = createAuthMiddleware(authService as unknown as AuthService);
  });

  it('requireAuth returns 401 when no Authorization header', () => {
    const req = mockReq();
    const res = mockRes();
    mw.requireAuth(req, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(401);
  });

  it('requireAuth returns 401 when token is invalid', () => {
    authService.verifyToken.mockReturnValue(null);
    const req = mockReq({ authorization: 'Bearer bad-token' });
    const res = mockRes();
    mw.requireAuth(req, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).error.code).toBe('AUTH_INVALID');
  });

  it('requireAuth returns 401 when user is inactive', () => {
    authService.verifyToken.mockReturnValue({ sub: '1', role: 'viewer' });
    authService.findUserById.mockReturnValue({ isActive: false } as any);
    const req = mockReq({ authorization: 'Bearer good' });
    const res = mockRes();
    mw.requireAuth(req, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).error.code).toBe('AUTH_DISABLED');
  });

  it('requireAuth calls next on valid token + active user', () => {
    authService.verifyToken.mockReturnValue({ sub: '1', role: 'admin' });
    authService.findUserById.mockReturnValue({ isActive: true } as any);
    const req = mockReq({ authorization: 'Bearer good' });
    const next = vi.fn();
    mw.requireAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ sub: '1', role: 'admin' });
  });

  it('requirePermission returns 403 when role lacks permission', () => {
    const req = { user: { sub: '1', role: 'viewer' } } as unknown as Request;
    const res = mockRes();
    const guard = mw.requirePermission('admin:all');
    guard(req, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(403);
  });

  it('requirePermission calls next when role has permission', () => {
    const role = 'admin' as keyof typeof ROLE_PERMISSIONS;
    const req = { user: { sub: '1', role } } as unknown as Request;
    const next = vi.fn();
    mw.requirePermission(ROLE_PERMISSIONS[role][0])(
      req, mockRes(), next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('optionalAuth calls next even without header', () => {
    const req = mockReq();
    const next = vi.fn();
    mw.optionalAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
  });

  it('optionalAuth sets user when valid token present', () => {
    authService.verifyToken.mockReturnValue({ sub: '1', role: 'admin' });
    authService.findUserById.mockReturnValue({ isActive: true } as any);
    const req = mockReq({ authorization: 'Bearer good' });
    mw.optionalAuth(req, mockRes(), vi.fn() as unknown as NextFunction);
    expect(req.user).toEqual({ sub: '1', role: 'admin' });
  });

  it('requireAuthOrSpawnToken admits X-Spawn-Token without user', () => {
    const req = mockReq({ 'x-spawn-token': 'abc' });
    const next = vi.fn();
    mw.requireAuthOrSpawnToken(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
  });

  it('requireAuthOrSpawnToken returns 401 when neither header present', () => {
    const req = mockReq();
    const res = mockRes();
    mw.requireAuthOrSpawnToken(req, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(401);
  });
});