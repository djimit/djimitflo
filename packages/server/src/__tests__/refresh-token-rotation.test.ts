import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { AuthService } from '../services/auth-service';

describe('Security Invariant: Refresh Token Rotation', () => {
  let db: Database;
  let authService: AuthService;

  beforeEach(() => {
    db = createTestDb() as unknown as Database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'viewer',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        rotated_from TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-for-testing';
    authService = new AuthService(db);
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    db.close();
  });

  function createTestUser() {
    const email = `test-${Date.now()}@example.com`;
    const password = 'SecurePass123!';
    authService.createUser(email, password, 'maker' as any);
    return { email, password };
  }

  it('issues a token pair on authentication', () => {
    const { email, password } = createTestUser();
    const result = authService.authenticateWithRefresh(email, password);

    expect(result).not.toBeNull();
    expect(result!.tokens.access_token).toBeDefined();
    expect(result!.tokens.refresh_token).toBeDefined();
    expect(result!.tokens.expires_in).toBe(900);
    expect(result!.tokens.token_type).toBe('Bearer');
  });

  it('rotates refresh token successfully', () => {
    const { email, password } = createTestUser();
    const initial = authService.authenticateWithRefresh(email, password);
    expect(initial).not.toBeNull();

    const oldRefreshToken = initial!.tokens.refresh_token;
    const rotated = authService.rotateRefreshToken(oldRefreshToken);

    expect(rotated).not.toBeNull();
    expect(rotated!.access_token).toBeDefined();
    expect(rotated!.refresh_token).toBeDefined();
    // New refresh token should be different from old one
    expect(rotated!.refresh_token).not.toBe(oldRefreshToken);
  });

  it('revokes old token after rotation', () => {
    const { email, password } = createTestUser();
    const initial = authService.authenticateWithRefresh(email, password);
    expect(initial).not.toBeNull();

    const oldRefreshToken = initial!.tokens.refresh_token;
    authService.rotateRefreshToken(oldRefreshToken);

    // Old token should now be rejected
    const secondAttempt = authService.rotateRefreshToken(oldRefreshToken);
    expect(secondAttempt).toBeNull();
  });

  it('detects token reuse (replay attack)', () => {
    const { email, password } = createTestUser();
    const initial = authService.authenticateWithRefresh(email, password);
    expect(initial).not.toBeNull();

    const oldRefreshToken = initial!.tokens.refresh_token;

    // First rotation succeeds
    const rotated = authService.rotateRefreshToken(oldRefreshToken);
    expect(rotated).not.toBeNull();

    // Reuse of old token should revoke ALL user tokens
    const replayAttempt = authService.rotateRefreshToken(oldRefreshToken);
    expect(replayAttempt).toBeNull();

    // New token should also be revoked
    const newTokenAttempt = authService.rotateRefreshToken(rotated!.refresh_token);
    expect(newTokenAttempt).toBeNull();
  });

  it('rejects expired refresh token', () => {
    const { email, password } = createTestUser();
    const initial = authService.authenticateWithRefresh(email, password);
    expect(initial).not.toBeNull();

    // Manually expire the token
    db.prepare("UPDATE refresh_tokens SET expires_at = datetime('now', '-1 day')").run();

    const expiredAttempt = authService.rotateRefreshToken(initial!.tokens.refresh_token);
    expect(expiredAttempt).toBeNull();
  });

  it('rejects unknown refresh token', () => {
    const result = authService.rotateRefreshToken('unknown-token-that-does-not-exist');
    expect(result).toBeNull();
  });

  it('revokes all user tokens on demand', () => {
    const { email, password } = createTestUser();
    const initial = authService.authenticateWithRefresh(email, password);
    expect(initial).not.toBeNull();

    const user = authService.authenticate(email, password);
    expect(user).not.toBeNull();

    authService.revokeAllUserTokens(user!.user.id);

    // All tokens should be revoked
    const result = authService.rotateRefreshToken(initial!.tokens.refresh_token);
    expect(result).toBeNull();
  });

  it('does not allow rotation for inactive users', () => {
    const { email, password } = createTestUser();
    const initial = authService.authenticateWithRefresh(email, password);
    expect(initial).not.toBeNull();

    const user = authService.authenticate(email, password);
    expect(user).not.toBeNull();

    // Deactivate user
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user!.user.id);

    const result = authService.rotateRefreshToken(initial!.tokens.refresh_token);
    expect(result).toBeNull();
  });
});
