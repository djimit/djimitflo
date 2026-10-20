import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import {
  ensureFleetSignatureTables,
  deriveFleetHmacKey,
  recordFleetVerdict,
} from '../services/fleet-event-signatures';
import type { FleetVerification, FleetSignatureMode } from '../services/fleet-event-signatures';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
});
afterEach(() => {
  db.close();
});

describe('ensureFleetSignatureTables', () => {
  it('creates the three expected tables', () => {
    ensureFleetSignatureTables(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fleet_event_keys','fleet_event_nonces','fleet_event_signatures') ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map((r) => r.name)).toEqual(['fleet_event_keys', 'fleet_event_nonces', 'fleet_event_signatures']);
  });

  it('is idempotent (calling twice does not throw)', () => {
    ensureFleetSignatureTables(db);
    expect(() => ensureFleetSignatureTables(db)).not.toThrow();
  });

  it('creates the nonce index', () => {
    ensureFleetSignatureTables(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fleet_event_nonces_seen'").get();
    expect(idx).toBeDefined();
  });
});

describe('deriveFleetHmacKey', () => {
  it('returns a base64url-encoded HMAC-SHA256 digest', () => {
    const key = deriveFleetHmacKey('master-secret', 'host1', 'abcdef01');
    // base64url alphabet only
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    // length of sha256 in base64url is 43 chars
    expect(key.length).toBe(43);
  });

  it('matches an independently computed HMAC', () => {
    const master = 'my-master';
    const host = 'node.example.com';
    const keyId = 'deadbeefcafe0001';
    const expected = createHmac('sha256', master)
      .update(`fleet-event-key|v1|${host}|${keyId}`)
      .digest('base64url');
    expect(deriveFleetHmacKey(master, host, keyId)).toBe(expected);
  });

  it('produces different keys for different hosts', () => {
    const a = deriveFleetHmacKey('m', 'host-a', 'k1');
    const b = deriveFleetHmacKey('m', 'host-b', 'k1');
    expect(a).not.toBe(b);
  });

  it('produces different keys for different keyIds', () => {
    const a = deriveFleetHmacKey('m', 'h', 'aaaa0001');
    const b = deriveFleetHmacKey('m', 'h', 'bbbb0002');
    expect(a).not.toBe(b);
  });

  it('is deterministic (same inputs → same output)', () => {
    expect(deriveFleetHmacKey('x', 'y', 'z')).toBe(deriveFleetHmacKey('x', 'y', 'z'));
  });
});

describe('recordFleetVerdict', () => {
  const v: FleetVerification = { verdict: 'verified', host: 'h1', key_id: 'abcd1234' };
  const mode: FleetSignatureMode = 'shadow';
  const now = Date.parse('2025-06-01T00:00:00Z');

  it('inserts a row into fleet_event_signatures', () => {
    ensureFleetSignatureTables(db);
    recordFleetVerdict(db, 'evt-1', v, mode, now);
    const row = db.prepare('SELECT * FROM fleet_event_signatures WHERE event_id = ?').get('evt-1') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.host).toBe('h1');
    expect(row!.key_id).toBe('abcd1234');
    expect(row!.verdict).toBe('verified');
    expect(row!.mode).toBe('shadow');
    expect(row!.at).toBe(new Date(now).toISOString());
  });

  it('ignores duplicate event_ids (INSERT OR IGNORE)', () => {
    ensureFleetSignatureTables(db);
    recordFleetVerdict(db, 'evt-dup', v, mode, now);
    // second insert with same event_id but different verdict should be ignored
    recordFleetVerdict(db, 'evt-dup', { ...v, verdict: 'replay' }, 'enforce', now + 1000);
    const rows = db.prepare('SELECT * FROM fleet_event_signatures WHERE event_id = ?').all('evt-dup') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe('verified');
  });

  it('stores null host and key_id when verification has no host/key', () => {
    ensureFleetSignatureTables(db);
    const unsigned: FleetVerification = { verdict: 'unsigned', host: null, key_id: null };
    recordFleetVerdict(db, 'evt-ns', unsigned, 'off', now);
    const row = db.prepare('SELECT * FROM fleet_event_signatures WHERE event_id = ?').get('evt-ns') as Record<string, unknown> | undefined;
    expect(row!.host).toBeNull();
    expect(row!.key_id).toBeNull();
    expect(row!.verdict).toBe('unsigned');
  });
});
