import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FederationService } from '../services/federation-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let federation: FederationService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  federation = new FederationService(db);
});

afterEach(() => {
  db?.close();
});

describe('G50: Federation Protocol', () => {
  it('registers a peer', () => {
    const peer = federation.registerPeer('https://peer1.example.com', 'pubkey123');
    expect(peer.id).toBeDefined();
    expect(peer.status).toBe('pending');
    expect(peer.trustScore).toBe(0.5);
  });

  it('strips PII from email', () => {
    const cleaned = federation.stripPII('Contact: user@example.com');
    expect(cleaned).toContain('[REDACTED_EMAIL]');
    expect(cleaned).not.toContain('user@example.com');
  });

  it('strips PII from SSN', () => {
    const cleaned = federation.stripPII('SSN: 123-45-6789');
    expect(cleaned).toContain('[REDACTED_SSN]');
  });

  it('strips PII from phone', () => {
    const cleaned = federation.stripPII('Call +1-555-123-4567');
    expect(cleaned).toContain('[REDACTED_PHONE]');
  });

  it('strips PII from API key', () => {
    const cleaned = federation.stripPII('api_key=abcdef1234567890abcdef1234567890');
    expect(cleaned).toContain('[REDACTED_API_KEY]');
  });

  it('detects PII types', () => {
    const detected = federation.detectPII('Email: test@example.com, SSN: 123-45-6789');
    expect(detected).toContain('email');
    expect(detected).toContain('ssn');
  });

  it('sends message with PII stripped', () => {
    const peer = federation.registerPeer('https://peer.example.com', 'key');
    const msg = federation.sendMessage(peer.id, 'capability_discovery', { email: 'secret@example.com' });
    expect(msg.payload).not.toEqual({ email: 'secret@example.com' });
  });

  it('verifies valid message', () => {
    const peer = federation.registerPeer('https://peer.example.com', 'key');
    const msg = federation.sendMessage(peer.id, 'capability_discovery', { data: 'test' });
    const result = federation.receiveMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('rejects message from unknown peer', () => {
    const msg = { id: '1', peerId: 'unknown', type: 'capability_discovery' as const, payload: {}, signature: '', timestamp: '' };
    const result = federation.receiveMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unknown_peer');
  });

  it('rejects message from untrusted peer', () => {
    const peer = federation.registerPeer('https://peer.example.com', 'key');
    federation.untrustPeer(peer.id);
    const msg = federation.sendMessage(peer.id, 'capability_discovery', {});
    const result = federation.receiveMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('untrusted_peer');
  });

  it('trustPeer changes status', () => {
    const peer = federation.registerPeer('https://peer.example.com', 'key');
    federation.trustPeer(peer.id);
    const trusted = federation.getTrustedPeers();
    expect(trusted.length).toBeGreaterThan(0);
  });

  it('getPendingPeers returns pending', () => {
    federation.registerPeer('https://peer1.example.com', 'key1');
    federation.registerPeer('https://peer2.example.com', 'key2');
    const pending = federation.getPendingPeers();
    expect(pending.length).toBe(2);
  });

  it('getMessageHistory returns messages', () => {
    const peer = federation.registerPeer('https://peer.example.com', 'key');
    federation.sendMessage(peer.id, 'capability_discovery', { test: 1 });
    federation.sendMessage(peer.id, 'claim_share', { test: 2 });
    const history = federation.getMessageHistory(peer.id);
    expect(history.length).toBe(2);
  });

  it('stripPII handles multiple types', () => {
    const input = 'Email: a@b.com, Phone: +1-555-123-4567, Key: abc123def456ghi789';
    const cleaned = federation.stripPII(input);
    expect(cleaned).toContain('[REDACTED_EMAIL]');
    expect(cleaned).toContain('[REDACTED_PHONE]');
  });

  it('calculateTrustScore returns value between 0 and 1', () => {
    const peer = federation.registerPeer('https://peer.example.com', 'key');
    federation.trustPeer(peer.id);
    const score = federation.calculateTrustScore(peer.id);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
