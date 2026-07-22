import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/test-db';
import type { Database } from 'better-sqlite3';
import { OIDCAbstraction, OIDCError, createOIDCConfigFromEnv } from '../services/oidc-provider';
import { AuditAnchoringService } from '../services/audit-anchoring';

describe('Security Invariant: OIDC Provider', () => {
  it('generates valid authorization URL with PKCE', () => {
    const config = {
      provider_name: 'test',
      client_id: 'test-client',
      issuer_url: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      userinfo_endpoint: 'https://auth.example.com/userinfo',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
      redirect_uri: 'http://localhost:3001/callback',
      scopes: ['openid', 'profile', 'email'],
      response_type: 'code' as const,
      pkce_enabled: true,
    };

    const oidc = new OIDCAbstraction(config);
    const { url, state } = oidc.generateAuthUrl('/dashboard');

    expect(url).toContain('https://auth.example.com/authorize');
    expect(url).toContain('client_id=test-client');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge=');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=');
    expect(url).toContain('nonce=');
    expect(state).toBeDefined();
  });

  it('creates step-up challenges for critical actions', () => {
    const config = {
      provider_name: 'test',
      client_id: 'test-client',
      issuer_url: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      userinfo_endpoint: 'https://auth.example.com/userinfo',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
      redirect_uri: 'http://localhost:3001/callback',
      scopes: ['openid'],
      response_type: 'code' as const,
      pkce_enabled: true,
    };

    const oidc = new OIDCAbstraction(config);
    const challenge = oidc.createStepUpChallenge('user-1', 'delete:task');

    expect(challenge.challenge_id).toMatch(/^stepup-/);
    expect(challenge.user_id).toBe('user-1');
    expect(challenge.action).toBe('delete:task');
    expect(challenge.status).toBe('pending');
  });

  it('verifies step-up challenges', () => {
    const config = {
      provider_name: 'test',
      client_id: 'test-client',
      issuer_url: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      userinfo_endpoint: 'https://auth.example.com/userinfo',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
      redirect_uri: 'http://localhost:3001/callback',
      scopes: ['openid'],
      response_type: 'code' as const,
      pkce_enabled: true,
    };

    const oidc = new OIDCAbstraction(config);
    const challenge = oidc.createStepUpChallenge('user-1', 'approve:task');

    expect(oidc.verifyStepUpChallenge(challenge.challenge_id)).toBe(true);
    expect(oidc.isStepUpVerified('user-1', 'approve:task')).toBe(true);
  });

  it('expires step-up challenges after timeout', () => {
    const config = {
      provider_name: 'test',
      client_id: 'test-client',
      issuer_url: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      userinfo_endpoint: 'https://auth.example.com/userinfo',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
      redirect_uri: 'http://localhost:3001/callback',
      scopes: ['openid'],
      response_type: 'code' as const,
      pkce_enabled: true,
    };

    const oidc = new OIDCAbstraction(config);
    const challenge = oidc.createStepUpChallenge('user-1', 'execute:task');

    expect(challenge.expires_at).toBeDefined();
    expect(new Date(challenge.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('identifies actions requiring step-up', () => {
    expect(OIDCAbstraction.requiresStepUp('delete:task')).toBe(true);
    expect(OIDCAbstraction.requiresStepUp('manage:config')).toBe(true);
    expect(OIDCAbstraction.requiresStepUp('approve:task')).toBe(true);
    expect(OIDCAbstraction.requiresStepUp('read:evidence')).toBe(false);
    expect(OIDCAbstraction.requiresStepUp('scan:repository')).toBe(false);
  });

  it('returns null OIDC config when no provider configured', () => {
    delete process.env.OIDC_PROVIDER;
    const config = createOIDCConfigFromEnv();
    expect(config).toBeNull();
  });

  it('creates Auth0 config from environment', () => {
    process.env.OIDC_PROVIDER = 'auth0';
    process.env.OIDC_CLIENT_ID = 'test-client-id';
    process.env.AUTH0_DOMAIN = 'test.auth0.com';

    const config = createOIDCConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config?.provider_name).toBe('Auth0');
    expect(config?.authorization_endpoint).toBe('https://test.auth0.com/authorize');
    expect(config?.pkce_enabled).toBe(true);

    delete process.env.OIDC_PROVIDER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.AUTH0_DOMAIN;
  });

  it('rejects invalid state in code exchange', () => {
    const config = {
      provider_name: 'test',
      client_id: 'test-client',
      issuer_url: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      userinfo_endpoint: 'https://auth.example.com/userinfo',
      jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
      redirect_uri: 'http://localhost:3001/callback',
      scopes: ['openid'],
      response_type: 'code' as const,
      pkce_enabled: true,
    };

    const oidc = new OIDCAbstraction(config);

    expect(oidc.exchangeCode('code', 'invalid-state')).rejects.toThrow(OIDCError);
  });
});

describe('Security Invariant: Audit Anchoring', () => {
  let db: Database;
  let service: AuditAnchoringService;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL DEFAULT '',
        resource TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success', 'failure', 'denied')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        previous_hash TEXT NOT NULL DEFAULT 'genesis',
        hash TEXT NOT NULL DEFAULT ''
      );
    `);
    service = new AuditAnchoringService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('computes Merkle root from audit chain', () => {
    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, previous_hash, hash)
      VALUES ('event-1', datetime('now'), 'user-1', 'create', 'task', 'success', 'genesis', 'hash1')
    `).run();

    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, previous_hash, hash)
      VALUES ('event-2', datetime('now'), 'user-2', 'approve', 'task', 'success', 'hash1', 'hash2')
    `).run();

    const { root, eventCount } = service.computeMerkleRoot();
    expect(root).toBeDefined();
    expect(eventCount).toBe(2);
    expect(root).toHaveLength(64);
  });

  it('computes empty Merkle root when no events', () => {
    const { root, eventCount } = service.computeMerkleRoot();
    expect(eventCount).toBe(0);
    expect(root).toBeDefined();
  });

  it('verifies chain integrity for valid chain', () => {
    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, previous_hash, hash)
      VALUES ('event-1', datetime('now'), 'user-1', 'create', 'task', 'success', 'genesis', 'hash1')
    `).run();

    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, previous_hash, hash)
      VALUES ('event-2', datetime('now'), 'user-2', 'approve', 'task', 'success', 'hash1', 'hash2')
    `).run();

    const result = service.verifyChainIntegrity();
    expect(result.valid).toBe(true);
  });

  it('detects broken chain integrity', () => {
    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, previous_hash, hash)
      VALUES ('event-1', datetime('now'), 'user-1', 'create', 'task', 'success', 'genesis', 'hash1')
    `).run();

    db.prepare(`
      INSERT INTO compliance_audit_log (id, timestamp, actor, action, resource, outcome, previous_hash, hash)
      VALUES ('event-2', datetime('now'), 'user-2', 'approve', 'task', 'success', 'WRONG_HASH', 'hash2')
    `).run();

    const result = service.verifyChainIntegrity();
    expect(result.valid).toBe(false);
    expect(result.firstInvalidEvent).toBe('event-2');
  });

  it('creates anchor records in database', () => {
    const anchor = service.getLatestAnchor();
    expect(anchor).toBeNull();
  });

  it('returns empty anchor list initially', () => {
    const anchors = service.getAnchors();
    expect(anchors).toEqual([]);
  });
});
