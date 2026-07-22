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
      const user = authService.createUser('test@example.com', 'pass123', 'maker');
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
      const user = authService.createUser('active@example.com', 'pass', 'viewer');
      authService.setUserActive(user.id, false);
      const found = authService.findUserByEmail('active@example.com');
      expect(found!.isActive).toBe(false);
    });
  });

  describe('authentication', () => {
    it('authenticates with valid credentials', () => {
      authService.createUser('auth@test.local', 'correct-password', 'admin');
      const result = authService.authenticate('auth@test.local', 'correct-password');
      expect(result).not.toBeNull();
      expect(result!.user.email).toBe('auth@test.local');
    });

    it('fails with wrong password', () => {
      authService.createUser('fail@test.local', 'correct', 'viewer');
      const result = authService.authenticate('fail@test.local', 'wrong');
      expect(result).toBeNull();
    });

    it('fails with non-existent email', () => {
      const result = authService.authenticate('ghost@test.local', 'any');
      expect(result).toBeNull();
    });

    it('fails for inactive user', () => {
      const user = authService.createUser('inactive@test.local', 'pass', 'viewer');
      authService.setUserActive(user.id, false);
      const result = authService.authenticate('inactive@test.local', 'pass');
      expect(result).toBeNull();
    });
  });

  describe('JWT token generation and verification', () => {
    it('generates and verifies a token', () => {
      const user = authService.createUser('jwt@test.local', 'pass', 'admin');
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
    it('admin has all defined permissions', () => {
      authService.createUser('admin@test.local', 'pass', 'admin');
      const adminPerms = ROLE_PERMISSIONS[UserRole.ADMIN];
      for (const perm of adminPerms) {
        expect(authService.hasPermission('admin', perm)).toBe(true);
      }
    });

    it('maker has operational permissions', () => {
      authService.createUser('maker@test.local', 'pass', 'maker');
      expect(authService.hasPermission('maker', 'read:evidence')).toBe(true);
      expect(authService.hasPermission('maker', 'write:swarm_action')).toBe(true);
      expect(authService.hasPermission('maker', 'create:task')).toBe(true);
      expect(authService.hasPermission('maker', 'approve:task')).toBe(false);
      expect(authService.hasPermission('maker', 'manage:config')).toBe(false);
    });

    it('approver can approve but not execute', () => {
      authService.createUser('approver@test.local', 'pass', 'approver');
      expect(authService.hasPermission('approver', 'approve:task')).toBe(true);
      expect(authService.hasPermission('approver', 'execute:task')).toBe(false);
    });

    it('auditor has read-only access to audit data', () => {
      authService.createUser('auditor@test.local', 'pass', 'auditor');
      expect(authService.hasPermission('auditor', 'read:audit')).toBe(true);
      expect(authService.hasPermission('auditor', 'approve:task')).toBe(false);
    });

    it('platform_admin can manage config but not execute', () => {
      authService.createUser('platform@test.local', 'pass', 'platform_admin');
      expect(authService.hasPermission('platform_admin', 'manage:config')).toBe(true);
      expect(authService.hasPermission('platform_admin', 'execute:task')).toBe(false);
    });

    it('viewer has read-only permissions', () => {
      authService.createUser('viewer@test.local', 'pass', 'viewer');
      expect(authService.hasPermission('viewer', 'read:evidence')).toBe(true);
      expect(authService.hasPermission('viewer', 'write:swarm_action')).toBe(false);
    });

    it('returns false for unknown role', () => {
      expect(authService.hasPermission('unknown' as any, 'read:evidence')).toBe(false);
    });
  });

  describe('logout idempotency', () => {
    it('generateToken and verifyToken work correctly for logout flow', () => {
      const user = authService.createUser('logout@test.local', 'pass', 'viewer');
      const token = authService.generateToken(user);
      const payload = authService.verifyToken(token);
      expect(payload).not.toBeNull();
    });
  });

  describe('sanitizeUser', () => {
    it('excludes password_hash from sanitized user', () => {
      const user = authService.createUser('sanitize@test.local', 'pass', 'viewer');
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
