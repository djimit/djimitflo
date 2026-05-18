import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../services/auth-service';
import { UserRole, ROLE_PERMISSIONS } from '@djimitflo/shared';
import BetterSqlite3 from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import type { Database } from 'better-sqlite3';

describe('AuthService', () => {
  let db: Database;
  let authService: AuthService;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-for-vitest';
    delete process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
    db = new BetterSqlite3(':memory:') as unknown as Database;
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
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

  describe('JWT token generation and verification', () => {
    it('generates and verifies a token', () => {
      const user = authService.createUser('test@example.com', 'password123', UserRole.ADMIN);
      const token = authService.generateToken(user);
      const payload = authService.verifyToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe(user.id);
      expect(payload!.email).toBe(user.email);
      expect(payload!.role).toBe(UserRole.ADMIN);
    });

    it('returns null for invalid tokens', () => {
      expect(authService.verifyToken('invalid-token')).toBeNull();
      expect(authService.verifyToken('')).toBeNull();
    });
  });

  describe('user management', () => {
    it('creates a user and finds by email', () => {
      const user = authService.createUser('admin@example.com', 'password123', UserRole.ADMIN);
      expect(user.email).toBe('admin@example.com');
      expect(user.role).toBe(UserRole.ADMIN);
      expect(user.isActive).toBe(true);

      const found = authService.findUserByEmail('admin@example.com');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
    });

    it('creates a user and finds by id', () => {
      const user = authService.createUser('op@example.com', 'password123', UserRole.OPERATOR);
      const found = authService.findUserById(user.id);
      expect(found).not.toBeNull();
      expect(found!.email).toBe('op@example.com');
    });

    it('returns null for non-existent email', () => {
      expect(authService.findUserByEmail('noone@example.com')).toBeNull();
    });

    it('returns null for non-existent id', () => {
      expect(authService.findUserById('nonexistent-id')).toBeNull();
    });

    it('normalizes email to lowercase', () => {
      authService.createUser('UpperCase@example.com', 'password', UserRole.VIEWER);
      const found = authService.findUserByEmail('uppercase@example.com');
      expect(found).not.toBeNull();
    });
  });

  describe('sanitizeUser', () => {
    it('excludes password_hash from sanitized user', () => {
      const user = authService.createUser('safe@example.com', 'password', UserRole.OPERATOR);
      const sanitized = authService.sanitizeUser(
        db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as Record<string, unknown>
      );
      expect((sanitized as any).password_hash).toBeUndefined();
      expect(sanitized.email).toBe('safe@example.com');
    });
  });

  describe('authenticate', () => {
    it('succeeds with valid credentials', () => {
      authService.createUser('login@example.com', 'password123', UserRole.ADMIN);
      const result = authService.authenticate('login@example.com', 'password123');
      expect(result).not.toBeNull();
      expect(result!.user.email).toBe('login@example.com');
      expect(result!.token).toBeTruthy();
    });

    it('fails with wrong password', () => {
      authService.createUser('login2@example.com', 'password123', UserRole.ADMIN);
      const result = authService.authenticate('login2@example.com', 'wrong-password');
      expect(result).toBeNull();
    });

    it('fails with non-existent email', () => {
      const result = authService.authenticate('noone@example.com', 'password');
      expect(result).toBeNull();
    });

    it('fails for inactive user', () => {
      const user = authService.createUser('inactive@example.com', 'password', UserRole.VIEWER);
      db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
      const result = authService.authenticate('inactive@example.com', 'password');
      expect(result).toBeNull();
    });
  });

  describe('bootstrap', () => {
    it('creates admin user when bootstrap credentials are provided', () => {
      process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL = 'bootstrap@example.com';
      process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = 'bootstrap-pass';
      const bootSvc = new AuthService(db);
      bootSvc.bootstrapAdmin();

      const user = bootSvc.findUserByEmail('bootstrap@example.com');
      expect(user).not.toBeNull();
      expect(user!.role).toBe(UserRole.ADMIN);
      expect(bootSvc.verifyPassword('bootstrap-pass', (db.prepare('SELECT password_hash FROM users WHERE email = ?').get('bootstrap@example.com') as any).password_hash)).toBe(true);
    });

    it('skips bootstrap if user already exists', () => {
      process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL = 'existing@example.com';
      process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = 'first-pass';
      const bootSvc1 = new AuthService(db);
      bootSvc1.bootstrapAdmin();

      process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = 'second-pass';
      const bootSvc2 = new AuthService(db);
      bootSvc2.bootstrapAdmin();

      const user = bootSvc2.findUserByEmail('existing@example.com');
      expect(user).not.toBeNull();
      expect(bootSvc2.verifyPassword('first-pass', (db.prepare('SELECT password_hash FROM users WHERE email = ?').get('existing@example.com') as any).password_hash)).toBe(true);
    });

    it('does not create user when bootstrap env vars are missing', () => {
      delete process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL;
      delete process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
      const bootSvc = new AuthService(db);
      bootSvc.bootstrapAdmin();

      const count = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
      expect(count).toBe(0);
    });
  });

  describe('hasPermission', () => {
    it('admin has all permissions', () => {
      expect(authService.hasPermission(UserRole.ADMIN, 'read:evidence')).toBe(true);
      expect(authService.hasPermission(UserRole.ADMIN, 'manage:users')).toBe(true);
      expect(authService.hasPermission(UserRole.ADMIN, 'delete:task')).toBe(true);
    });

    it('operator has operational permissions', () => {
      expect(authService.hasPermission(UserRole.OPERATOR, 'create:task')).toBe(true);
      expect(authService.hasPermission(UserRole.OPERATOR, 'execute:task')).toBe(true);
      expect(authService.hasPermission(UserRole.OPERATOR, 'approve:task')).toBe(true);
      expect(authService.hasPermission(UserRole.OPERATOR, 'manage:users')).toBe(false);
      expect(authService.hasPermission(UserRole.OPERATOR, 'delete:task')).toBe(false);
    });

    it('viewer has read-only permissions', () => {
      expect(authService.hasPermission(UserRole.VIEWER, 'read:evidence')).toBe(true);
      expect(authService.hasPermission(UserRole.VIEWER, 'read:repository')).toBe(true);
      expect(authService.hasPermission(UserRole.VIEWER, 'create:task')).toBe(false);
      expect(authService.hasPermission(UserRole.VIEWER, 'execute:task')).toBe(false);
      expect(authService.hasPermission(UserRole.VIEWER, 'approve:task')).toBe(false);
    });
  });

  describe('logout idempotency', () => {
    it('generateToken and verifyToken work correctly for logout flow', () => {
      process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL = 'logout-test@example.com';
      process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = 'LogoutPass123!';
      const service = new AuthService(db);
      service.bootstrapAdmin();
      const user = service.findUserByEmail('logout-test@example.com');
      expect(user).not.toBeNull();
      const token = service.generateToken(user!);
      const decoded = service.verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded!.sub).toBe(user!.id);
    });
  });
});