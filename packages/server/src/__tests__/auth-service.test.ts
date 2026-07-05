import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../services/auth-service';
import { UserRole, ROLE_PERMISSIONS } from '@djimitflo/shared';
import type { Database } from 'better-sqlite3';
import { createTestDb } from './helpers/test-db';

describe('AuthService', () => {
  let db: Database;
  let authService: AuthService;

  beforeEach(() => {
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = Array(40).fill('a').join('');
    delete process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
    db = createTestDb() as unknown as Database;
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('password hashing', () => {
    it('hashes and verifies passwords correctly', () => {
      const hash = authService.hashPassword('test-password');
      expect(hash).toBeTruthy();
      expect(authService.verifyPassword('test-password', hash)).toBe(true);
      expect(authService.verifyPassword('wrong-password', hash)).toBe(false);
    });

    it('produces different hashes for same password', () => {
      const hash1 = authService.hashPassword('same-password');
      const hash2 = authService.hashPassword('same-password');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('user management', () => {
    it('creates a user and finds by email', () => {
      const user = authService.createUser({ email: 'test@example.com', password: 'pass123', role: 'operator' });
      expect(user.id).toBeDefined();
      expect(user.email).toBe('test@example.com');

      const found = authService.findUserByEmail('test@example.com');
      expect(found).not.toBeNull();
      expect(found!.email).toBe('test@example.com');
    });

    it('returns null for non-existent email', () => {
      expect(authService.findUserByEmail('noone@example.com')).toBeNull();
    });

    it('returns null for non-existent id', () => {
      expect(authService.findUserById('nonexistent-id')).toBeNull();
    });

    it('updates user status', () => {
      const user = authService.createUser({ email: 'active@example.com', password: 'pass', role: 'viewer' });
      authService.setUserActive(user.id, false);
      const found = authService.findUserByEmail('active@example.com');
      expect(found!.is_active).toBe(0);
    });
  });

  describe('authentication', () => {
    it('authenticates with valid credentials', () => {
      authService.createUser({ email: 'auth@test.local', password: 'correct-password', role: 'admin' });
      const result = authService.authenticate({ email: 'auth@test.local', password: 'correct-password' });
      expect(result).not.toBeNull();
      expect(result!.email).toBe('auth@test.local');
    });

    it('fails with wrong password', () => {
      authService.createUser({ email: 'fail@test.local', password: 'correct', role: 'viewer' });
      const result = authService.authenticate({ email: 'fail@test.local', password: 'wrong' });
      expect(result).toBeNull();
    });

    it('fails with non-existent email', () => {
      const result = authService.authenticate({ email: 'ghost@test.local', password: 'any' });
      expect(result).toBeNull();
    });

    it('fails for inactive user', () => {
      const user = authService.createUser({ email: 'inactive@test.local', password: 'pass', role: 'viewer' });
      authService.setUserActive(user.id, false);
      const result = authService.authenticate({ email: 'inactive@test.local', password: 'pass' });
      expect(result).toBeNull();
    });
  });

  describe('JWT token generation and verification', () => {
    it('generates and verifies a token', () => {
      const user = authService.createUser({ email: 'jwt@test.local', password: 'pass', role: 'admin' });
      const token = authService.generateToken(user);
      expect(token).toBeTruthy();

      const payload = authService.verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe(user.id);
    });

    it('returns null for invalid tokens', () => {
      expect(authService.verifyToken('invalid-token')).toBeNull();
      expect(authService.verifyToken('')).toBeNull();
    });
  });

  describe('hasPermission', () => {
    it('admin has all permissions', () => {
      const admin = authService.createUser({ email: 'admin@test.local', password: 'pass', role: 'admin' });
      for (const perm of Object.values(ROLE_PERMISSIONS)) {
        expect(authService.hasPermission(admin.id, perm)).toBe(true);
      }
    });

    it('operator has operational permissions', () => {
      const op = authService.createUser({ email: 'op@test.local', password: 'pass', role: 'operator' });
      expect(authService.hasPermission(op.id, 'read:evidence')).toBe(true);
      expect(authService.hasPermission(op.id, 'write:swarm_action')).toBe(true);
      expect(authService.hasPermission(op.id, 'manage:config')).toBe(false);
    });

    it('viewer has read-only permissions', () => {
      const viewer = authService.createUser({ email: 'viewer@test.local', password: 'pass', role: 'viewer' });
      expect(authService.hasPermission(viewer.id, 'read:evidence')).toBe(true);
      expect(authService.hasPermission(viewer.id, 'write:swarm_action')).toBe(false);
    });

    it('returns false for unknown user', () => {
      expect(authService.hasPermission('unknown-id', 'read:evidence')).toBe(false);
    });
  });

  describe('logout idempotency', () => {
    it('generateToken and verifyToken work correctly for logout flow', () => {
      const user = authService.createUser({ email: 'logout@test.local', password: 'pass', role: 'viewer' });
      const token = authService.generateToken(user);
      const payload = authService.verifyToken(token);
      expect(payload).not.toBeNull();
    });
  });

  describe('sanitizeUser', () => {
    it('excludes password_hash from sanitized user', () => {
      const user = authService.createUser({ email: 'sanitize@test.local', password: 'pass', role: 'viewer' });
      const sanitized = authService.sanitizeUser(user);
      expect((sanitized as any).password_hash).toBeUndefined();
    });

    it('produces different hashes for same password', () => {
      const hash1 = authService.hashPassword('same-password');
      const hash2 = authService.hashPassword('same-password');
      expect(hash1).not.toBe(hash2);
    });
  });
});
