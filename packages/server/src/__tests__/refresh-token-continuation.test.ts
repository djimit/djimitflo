import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createTestDb } from './helpers/test-db';
import { AuthService } from '../services/auth-service';

const now = '2026-09-09T12:00:00.000Z';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
let db: ReturnType<typeof createTestDb>;
let auth: AuthService;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  vi.stubEnv('JWT_SECRET', 'disposable-refresh-test-secret'); vi.stubEnv('JWT_EXPIRES_IN', '15m');
  db = createTestDb();
  // Keep SQLite's old datetime('now') comparison and the JS clock aligned.
  // This deterministic test clock does not replace date parsing/comparison.
  db.function('datetime', (value: unknown) => {
    if (value !== 'now') throw new Error('Unexpected test datetime expression');
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  });
  db.prepare("INSERT INTO users(id,email,password_hash,role) VALUES ('owner','refresh-owner@test','unused','maker')").run();
  auth = new AuthService(db);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([
  '2026-09-09T11:59:59.000Z', now, '2026-09-09 11:59:59',
  '2026-09-09T14:00:00.000+02:00', 'not-a-date', '',
])('rejects expired or malformed expiry chronologically: %s', expiry => {
  const issued = auth.generateTokenPair(auth.findUserById('owner')!);
  db.prepare('UPDATE refresh_tokens SET expires_at=?').run(expiry);
  expect(auth.rotateRefreshToken(issued.refresh_token)).toBeNull();
  expect(db.prepare('SELECT count(*) n FROM refresh_tokens').get()).toEqual({ n: 1 });
});

it.each(['2026-09-09 12:00:01', '2026-09-09T14:00:01.000+02:00'])('accepts a future legacy/offset timestamp: %s', expiry => {
  const issued = auth.generateTokenPair(auth.findUserById('owner')!);
  db.prepare('UPDATE refresh_tokens SET expires_at=?').run(expiry);
  expect(auth.rotateRefreshToken(issued.refresh_token)).not.toBeNull();
});

it('stores only hashes and preserves session lineage through multiple rotations', () => {
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  const firstRecord = db.prepare('SELECT * FROM refresh_tokens').get() as any;
  const second = auth.rotateRefreshToken(first.refresh_token)!;
  const third = auth.rotateRefreshToken(second.refresh_token)!;
  const records = db.prepare('SELECT * FROM refresh_tokens').all() as any[];
  expect(records.map(row => row.session_id)).toEqual([firstRecord.session_id, firstRecord.session_id, firstRecord.session_id]);
  expect(records.map(row => row.rotated_from)).toEqual([null, hash(first.refresh_token), hash(second.refresh_token)]);
  expect(records.map(row => row.revoked)).toEqual([1, 1, 0]);
  for (const pair of [first, second, third]) {
    expect(JSON.stringify(records)).not.toContain(pair.refresh_token);
    expect(records.some(row => row.token_hash === hash(pair.refresh_token))).toBe(true);
  }
});

it.each(['insert', 'sign'])('rolls back the old token revocation if replacement %s fails', failure => {
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  const before = db.prepare('SELECT * FROM refresh_tokens').all();
  if (failure === 'insert') {
    db.exec("CREATE TRIGGER reject_refresh_insert BEFORE INSERT ON refresh_tokens BEGIN SELECT RAISE(ABORT,'fixture insertion failure'); END");
  } else vi.spyOn(auth, 'generateToken').mockImplementation(() => { throw new Error('fixture signing failure'); });
  expect(() => auth.rotateRefreshToken(first.refresh_token)).toThrow(/fixture/);
  expect(db.prepare('SELECT * FROM refresh_tokens').all()).toEqual(before);
  if (failure === 'insert') db.exec('DROP TRIGGER reject_refresh_insert');
  else vi.restoreAllMocks();
  expect(auth.rotateRefreshToken(first.refresh_token)).not.toBeNull();
});

it('reports actual access-token lifetime while retaining a rolling thirty-day refresh expiry', () => {
  vi.stubEnv('JWT_EXPIRES_IN', '1h');
  auth = new AuthService(db);
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  const claims = jwt.decode(first.access_token) as jwt.JwtPayload;
  expect(first.expires_in).toBe(claims.exp! - claims.iat!);
  expect(first.expires_in).toBe(3600);
  const initial = db.prepare('SELECT * FROM refresh_tokens').get() as any;
  expect(Date.parse(initial.expires_at) - Date.parse(initial.issued_at)).toBe(30 * 86_400_000);
  vi.setSystemTime(Date.parse(now) + 86_400_000);
  const rotated = auth.rotateRefreshToken(first.refresh_token)!;
  const current = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash=?').get(hash(rotated.refresh_token)) as any;
  expect(Date.parse(current.expires_at) - Date.now()).toBe(30 * 86_400_000);
});

it('preserves user-wide replay revocation without affecting another user', () => {
  db.prepare("INSERT INTO users(id,email,password_hash,role) VALUES ('other','refresh-other@test','unused','maker')").run();
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  const sibling = auth.generateTokenPair(auth.findUserById('owner')!);
  const other = auth.generateTokenPair(auth.findUserById('other')!);
  const rotated = auth.rotateRefreshToken(first.refresh_token)!;
  expect(auth.rotateRefreshToken(first.refresh_token)).toBeNull();
  expect(auth.rotateRefreshToken(rotated.refresh_token)).toBeNull();
  expect(auth.rotateRefreshToken(sibling.refresh_token)).toBeNull();
  expect(auth.rotateRefreshToken(other.refresh_token)).not.toBeNull();
});

it('uses current user role and refuses disabled accounts during rotation', () => {
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  db.prepare("UPDATE users SET role='viewer' WHERE id='owner'").run();
  const rotated = auth.rotateRefreshToken(first.refresh_token)!;
  expect(auth.verifyToken(rotated.access_token)?.role).toBe('viewer');
  db.prepare("UPDATE users SET is_active=0 WHERE id='owner'").run();
  expect(auth.rotateRefreshToken(rotated.refresh_token)).toBeNull();
  expect(db.prepare('SELECT revoked FROM refresh_tokens WHERE token_hash=?').get(hash(rotated.refresh_token))).toEqual({ revoked: 1 });
});

it('binds access tokens to a durable refresh family without changing legacy bearer tokens', () => {
  const user = auth.findUserById('owner')!;
  const legacy = auth.generateToken(user);
  const first = auth.generateTokenPair(user);
  const sibling = auth.generateTokenPair(user);
  const claims = auth.verifyToken(first.access_token)!;
  expect(claims.sid).toEqual(expect.any(String));
  const rotated = auth.rotateRefreshToken(first.refresh_token)!;
  expect(auth.verifyToken(rotated.access_token)?.sid).toBe(claims.sid);
  expect(new AuthService(db).verifyToken(first.access_token)?.sid).toBe(claims.sid);
  expect(auth.revokeSessionFamily(first.refresh_token)).toEqual({ user_id: user.id, session_id: claims.sid });
  expect(auth.verifyToken(first.access_token)).toBeNull();
  expect(auth.verifyToken(rotated.access_token)).toBeNull();
  expect(auth.verifyToken(sibling.access_token)).not.toBeNull();
  expect(auth.verifyToken(legacy)).not.toBeNull();
});

it('rejects session identifiers that are malformed, expired, missing or owned by another user', () => {
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  const claims = jwt.decode(first.access_token) as jwt.JwtPayload;
  for (const sid of ['', 123, {}, 'unknown']) {
    const token = jwt.sign({ ...claims, sid }, 'disposable-refresh-test-secret');
    expect(auth.verifyToken(token)).toBeNull();
  }
  const wrongOwner = jwt.sign({ ...claims, sub: 'another-user' }, 'disposable-refresh-test-secret');
  expect(auth.verifyToken(wrongOwner)).toBeNull();
  db.prepare('UPDATE refresh_tokens SET expires_at=?').run(now);
  expect(auth.verifyToken(first.access_token)).toBeNull();
});

it('preserves selected organization through rotation without consuming rejected organization requests', () => {
  db.prepare("UPDATE users SET organization_id='assigned' WHERE id='owner'").run();
  const first = auth.generateTokenPair(auth.findUserById('owner')!);
  expect(auth.rotateRefreshToken(first.refresh_token, 'unrelated')).toBeNull();
  const rotated = auth.rotateRefreshToken(first.refresh_token, 'default')!;
  expect(auth.verifyToken(rotated.access_token)?.organization_id).toBe('default');
  expect(auth.verifyToken(rotated.access_token)?.sid).toBe(auth.verifyToken(first.access_token)?.sid);
});
