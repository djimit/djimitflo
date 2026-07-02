import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FederationTrustManager } from '../services/federation-trust-manager';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let manager: FederationTrustManager;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  manager = new FederationTrustManager(db);
});

afterEach(() => {
  db?.close();
});

describe('G115: FederationTrustManager', () => {
  it('issues token', () => {
    const token = manager.issueToken('peer-1', ['read', 'write']);
    expect(token.id).toBeDefined();
    expect(token.peerId).toBe('peer-1');
    expect(token.scopes).toEqual(['read', 'write']);
    expect(token.revoked).toBe(false);
  });

  it('verifies valid token', () => {
    const token = manager.issueToken('peer-2', ['read']);
    const result = manager.verifyToken(token.tokenHash);
    expect(result.valid).toBe(true);
    expect(result.peerId).toBe('peer-2');
  });

  it('rejects invalid token', () => {
    const result = manager.verifyToken('invalid-hash');
    expect(result.valid).toBe(false);
  });

  it('revokes token', () => {
    const token = manager.issueToken('peer-3', ['read']);
    manager.revokeToken(token.id);
    const result = manager.verifyToken(token.tokenHash);
    expect(result.valid).toBe(false);
  });

  it('checks rate limit', () => {
    const result = manager.checkRateLimit('peer-4');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(10);
  });

  it('gets trusted peers', () => {
    manager.issueToken('peer-5', ['read']);
    const peers = manager.getTrustedPeers();
    expect(peers.length).toBeGreaterThan(0);
    expect(peers[0].peerId).toBe('peer-5');
  });
});
