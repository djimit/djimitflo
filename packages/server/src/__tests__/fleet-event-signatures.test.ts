import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { generateKeyPairSync, sign as edSign } from 'crypto';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations, runPreSchemaMigrations } from '../database/migrate';
import { ExternalEventIngestService, scoreAgentOutcomes } from '../services/external-event-ingest-service';
import {
  FLEET_EVENT_WINDOW_MS, canonicalJson, ensureFleetSignatureTables, fleetSignatureEvidence, fleetSignedBody, pruneFleetNonces,
  registerFleetHostKey, revokeFleetHostKey, signFleetEventHmac, verifyFleetEvent,
} from '../services/fleet-event-signatures';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

const MASTER = 'test-master-secret';
const NOW = Date.parse('2026-10-20T09:00:00Z');
const EMITTER = path.resolve(__dirname, '../../../../scripts/emit-agent-outcome.py');
let db: Database.Database;

beforeEach(() => { db = new Database(':memory:'); runPreSchemaMigrations(db); db.exec(schema); runMigrations(db); });
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const outcome = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event_id: 'agent-outcome:1', event_type: 'agent.outcome', source: 'hermes', agent: 'hermes', task_kind: 'briefing',
  success: true, occurred_at: '2026-10-20T08:00:00Z', tokens: 1200, model: 'kimi-k3', ...over,
});
const signed = (key: { host: string; key_id: string; secret?: string }, over: Record<string, unknown> = {}) => {
  const e = outcome({ host: key.host, key_id: key.key_id, sig_alg: 'hmac-sha256', ...over });
  return { ...e, sig: signFleetEventHmac(key.secret!, e) };
};

describe('P0-3 verifier', () => {
  it('verifies a correctly signed event once; the same event_id again is a replay', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const e = signed(key);
    expect(verifyFleetEvent(db, e, { master: MASTER, now: NOW })).toEqual({ verdict: 'verified', host: 'macmini', key_id: key.key_id });
    expect(verifyFleetEvent(db, e, { master: MASTER, now: NOW }).verdict).toBe('replay');
  });

  it('a forged event signed with a key carried in its own payload is rejected (the registry key is used, never the event\'s)', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const forged = outcome({ host: 'macmini', key_id: key.key_id, sig_alg: 'hmac-sha256', secret: 'attacker', key: 'attacker' });
    forged.sig = signFleetEventHmac('attacker', forged);
    expect(verifyFleetEvent(db, forged, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
    // an ed25519 public key in the event is ignored too
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const edForged = outcome({ host: 'macmini', key_id: key.key_id, sig_alg: 'ed25519', public_key: publicKey.export({ type: 'spki', format: 'pem' }) });
    edForged.sig = edSign(null, Buffer.from(fleetSignedBody(edForged)), privateKey).toString('base64url');
    expect(verifyFleetEvent(db, edForged, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
  });

  it('a tampered success flag breaks the signature', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    expect(verifyFleetEvent(db, { ...signed(key, { success: false }), success: true }, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
    expect(verifyFleetEvent(db, { ...signed(key, { event_id: 'agent-outcome:t2' }), tokens: 99999 }, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
  });

  it('unsigned, unknown host, revoked key and an out-of-window ts', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    expect(verifyFleetEvent(db, outcome(), { master: MASTER, now: NOW }).verdict).toBe('unsigned');
    expect(verifyFleetEvent(db, signed({ ...key, host: 'evil-host' }), { master: MASTER, now: NOW }).verdict).toBe('unknown_host');
    expect(verifyFleetEvent(db, signed(key, { occurred_at: new Date(NOW - FLEET_EVENT_WINDOW_MS - 60_000).toISOString() }), { master: MASTER, now: NOW }).verdict).toBe('replay');
    expect(revokeFleetHostKey(db, 'macmini')).toBe(1);
    expect(verifyFleetEvent(db, signed(key, { event_id: 'agent-outcome:after-revoke' }), { master: MASTER, now: NOW }).verdict).toBe('revoked');
  });

  it('accepts ed25519 against the registered public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const key = registerFleetHostKey(db, 'node-host', { alg: 'ed25519', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    expect(key.secret).toBeUndefined();
    const e = outcome({ host: 'node-host', key_id: key.key_id, sig_alg: 'ed25519' });
    e.sig = edSign(null, Buffer.from(fleetSignedBody(e)), privateKey).toString('base64url');
    expect(verifyFleetEvent(db, e, { now: NOW }).verdict).toBe('verified');
  });

  it('prunes nonces older than two windows', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    verifyFleetEvent(db, signed(key), { master: MASTER, now: NOW });
    expect(pruneFleetNonces(db, NOW + FLEET_EVENT_WINDOW_MS)).toBe(0);
    expect(pruneFleetNonces(db, NOW + 2 * FLEET_EVENT_WINDOW_MS + 1)).toBe(1);
  });
});

describe('P0-3 canonical encoding', () => {
  it('canonicalJson sorts keys and nests arrays and objects with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"b":1}');
    expect(canonicalJson([3, 1, { b: 1, a: 1 }])).toBe('[3,1,{"a":1,"b":1}]');
    expect(canonicalJson(null)).toBe('null');
  });

  it('fleetSignedBody drops null/undefined payload fields but keeps present ones', () => {
    const base = { agent: 'hermes', event_id: 'e', host: 'macmini', occurred_at: '2026-10-20T08:00:00Z', task_kind: 'briefing', success: true };
    expect(fleetSignedBody({ ...base, tokens: null })).toBe(fleetSignedBody(base));
    expect(fleetSignedBody({ ...base, tokens: 1200 })).not.toBe(fleetSignedBody(base));
  });

  it('signs skills identically whether they arrive as a list or the bus JSON string, and tolerates non-JSON strings', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const skills = [{ name: 'alpha', sha: 'deadbeef' }, { name: 'beta' }];
    const asList = signed(key, { event_id: 'agent-outcome:sk1', skills });
    const asStr = signed(key, { event_id: 'agent-outcome:sk2', skills: JSON.stringify(skills) });
    const norm = (s: string) => s.replace(/"event_id":"[^"]*"/, '"event_id":"X"');
    expect(norm(fleetSignedBody(asList))).toBe(norm(fleetSignedBody(asStr)));
    expect(verifyFleetEvent(db, asList, { master: MASTER, now: NOW }).verdict).toBe('verified');
    expect(verifyFleetEvent(db, asStr, { master: MASTER, now: NOW }).verdict).toBe('verified');
    const bad = signed(key, { event_id: 'agent-outcome:sk3', skills: 'not-json' });
    expect(verifyFleetEvent(db, bad, { master: MASTER, now: NOW }).verdict).toBe('verified');
  });

  it('asBool: true/"true" and false/"false" sign alike and differ; other values are null', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const base = outcome({ host: key.host, key_id: key.key_id });
    const sig = (s: unknown) => signFleetEventHmac(key.secret!, { ...base, event_id: 'x', success: s });
    expect(sig(true)).toBe(sig('true'));
    expect(sig(false)).toBe(sig('false'));
    expect(sig(true)).not.toBe(sig(false));
    expect(sig('maybe')).toBe(sig(undefined));
  });
});

describe('P0-3 key registry edge cases', () => {
  it('rejects invalid hosts and ed25519 without a real ed25519 public key', () => {
    expect(() => registerFleetHostKey(db, 'bad host!', { master: MASTER })).toThrow('FLEET_HOST_INVALID');
    expect(() => registerFleetHostKey(db, ' macmini', { master: MASTER })).toThrow('FLEET_HOST_INVALID');
    expect(() => registerFleetHostKey(db, 'macmini ', { master: MASTER })).toThrow('FLEET_HOST_INVALID');
    expect(() => registerFleetHostKey(db, 'h', { alg: 'ed25519', master: MASTER })).toThrow('FLEET_PUBLIC_KEY_REQUIRED');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => registerFleetHostKey(db, 'h', { alg: 'ed25519', publicKey: rsaPem, master: MASTER })).toThrow('FLEET_PUBLIC_KEY_NOT_ED25519');
  });

  it('hmac keys never store a public_key even if one is passed', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER, publicKey: 'should-be-ignored' });
    const row = db.prepare('SELECT public_key FROM fleet_event_keys WHERE host = ? AND key_id = ?').get(key.host, key.key_id) as { public_key: string | null };
    expect(row.public_key).toBeNull();
  });

  it('revoke works on a fresh db and targets one key or all active keys of a host', () => {
    const fresh = new Database(':memory:');
    expect(revokeFleetHostKey(fresh)).toBe(0);
    fresh.close();
    registerFleetHostKey(db, 'macmini', { master: MASTER });
    const k2 = registerFleetHostKey(db, 'macmini', { master: MASTER });
    expect(revokeFleetHostKey(db, 'macmini', k2.key_id)).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM fleet_event_keys WHERE host = ? AND status = ?').get('macmini', 'active') as { n: number }).n).toBe(1);
    expect(revokeFleetHostKey(db, 'macmini')).toBe(1);
  });
});

describe('P0-3 verifier shape and boundary guards', () => {
  it('rejects non-string sig and non-string host/key_id shapes', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    expect(verifyFleetEvent(db, { ...signed(key), sig: 123 as unknown as string }, { master: MASTER, now: NOW }).verdict).toBe('unsigned');
    const h = signed(key, { event_id: 'agent-outcome:obj-h' }); (h as Record<string, unknown>).host = { bad: 1 } as unknown as string;
    expect(verifyFleetEvent(db, h, { master: MASTER, now: NOW }).verdict).toBe('unknown_host');
    const k = signed(key, { event_id: 'agent-outcome:obj-k' }); (k as Record<string, unknown>).key_id = { bad: 1 } as unknown as string;
    expect(verifyFleetEvent(db, k, { master: MASTER, now: NOW }).verdict).toBe('unknown_host');
  });

  it('an event signed with a valid hmac sig but declaring sig_alg=ed25519 is bad_signature', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const e = signed(key, { sig_alg: 'ed25519' });
    expect(verifyFleetEvent(db, e, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
  });

  it('an event with an empty or missing event_id is bad_signature even with a matching sig', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const base = outcome({ host: key.host, key_id: key.key_id, occurred_at: new Date(NOW).toISOString() });
    const empty = { ...base, event_id: '', sig: signFleetEventHmac(key.secret!, { ...base, event_id: '' }) };
    expect(verifyFleetEvent(db, empty, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
    const none = { ...base, sig: signFleetEventHmac(key.secret!, { ...base }) };
    delete (none as Record<string, unknown>).event_id;
    expect(verifyFleetEvent(db, none, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
  });

  it('a key with an unknown alg never verifies', () => {
    ensureFleetSignatureTables(db);
    db.prepare("INSERT INTO fleet_event_keys (host, key_id, alg, public_key, status, created_at) VALUES ('macmini', 'ffffffff', 'rsa', NULL, 'active', ?)")
      .run(new Date(NOW).toISOString());
    const e = outcome({ host: 'macmini', key_id: 'ffffffff', sig_alg: 'rsa', event_id: 'agent-outcome:rsa', occurred_at: new Date(NOW).toISOString() });
    e.sig = 'AAAA';
    expect(verifyFleetEvent(db, e, { master: MASTER, now: NOW }).verdict).toBe('bad_signature');
  });

  it('an ed25519 key with a malformed public key yields bad_signature via the catch path', () => {
    ensureFleetSignatureTables(db);
    db.prepare("INSERT INTO fleet_event_keys (host, key_id, alg, public_key, status, created_at) VALUES ('node-host', 'ffffffff', 'ed25519', 'not-a-pem', 'active', ?)")
      .run(new Date(NOW).toISOString());
    const e = outcome({ host: 'node-host', key_id: 'ffffffff', sig_alg: 'ed25519', event_id: 'agent-outcome:badpem', occurred_at: new Date(NOW).toISOString() });
    e.sig = 'AAAA';
    expect(verifyFleetEvent(db, e, { now: NOW }).verdict).toBe('bad_signature');
  });

  it('accepts a ts exactly at the 24h window edge and rejects just beyond', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const edge = signed(key, { event_id: 'agent-outcome:edge', occurred_at: new Date(NOW - FLEET_EVENT_WINDOW_MS).toISOString() });
    expect(verifyFleetEvent(db, edge, { master: MASTER, now: NOW }).verdict).toBe('verified');
    const beyond = signed(key, { event_id: 'agent-outcome:beyond', occurred_at: new Date(NOW - FLEET_EVENT_WINDOW_MS - 1).toISOString() });
    expect(verifyFleetEvent(db, beyond, { master: MASTER, now: NOW }).verdict).toBe('replay');
  });
});

describe('P0-3 Python emitter ↔ TS verifier', () => {
  it('matches the fixed vector in emit-agent-outcome.py --selfcheck (bus string form included)', () => {
    const e = { event_id: 'agent-outcome:fixture-1', agent: 'hermes', task_kind: 'briefing', success: true, occurred_at: '2026-10-20T08:00:00Z',
      tokens: 1200, model: 'kimi-k3', host: 'macmini', key_id: '0123456789abcdef' };
    expect(signFleetEventHmac('fixture-secret', e)).toBe('sGOwPZ1cvtEUsA1EBpcixRnV2kv8Us2q23n2C9CbT-0');
    // the Redis bus returns every field as a string; the signature still holds
    expect(signFleetEventHmac('fixture-secret', { ...e, success: 'true', tokens: '1200' })).toBe('sGOwPZ1cvtEUsA1EBpcixRnV2kv8Us2q23n2C9CbT-0');
  });

  const python = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!python)('an event signed by the real emitter (key file) verifies in the TS verifier', () => {
    const key = registerFleetHostKey(db, 'macmini', { master: MASTER });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-key-'));
    const keyFile = path.join(dir, 'fleet-event.key');
    fs.writeFileSync(keyFile, `${key.host} ${key.key_id} ${key.secret}\n`, { mode: 0o600 });
    const out = execFileSync('python3', [EMITTER, '--agent', 'hermes', '--task-kind', 'briefing', '--success', 'true', '--tokens', '7', '--ref', 'https://x/é', '--dry-run'],
      { env: { ...process.env, DJIMIT_FLEET_EVENT_KEY_FILE: keyFile } }).toString();
    fs.rmSync(dir, { recursive: true, force: true });
    const event = JSON.parse(out) as Record<string, unknown>;
    expect(JSON.stringify(event)).not.toContain(key.secret);
    expect(verifyFleetEvent(db, event, { master: MASTER }).verdict).toBe('verified');
  });
});

describe('P0-3 ingest (FLEET_EVENT_SIGNATURES)', () => {
  const poll = async (events: Array<Record<string, unknown>>) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 })));
    return new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
  };
  const fleetOutcomes = () => db.prepare("SELECT task_id, success FROM skill_outcomes WHERE domain = 'fleet' ORDER BY task_id").all();
  const verdicts = () => db.prepare('SELECT event_id, verdict, mode FROM fleet_event_signatures ORDER BY event_id').all();
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  it('shadow records a verdict per new event and scores exactly as off', async () => {
    vi.stubEnv('FLEET_EVENT_SIGNATURES', 'shadow');
    const key = registerFleetHostKey(db, 'macmini');
    await poll([{ _id: '2-0', ...signed(key, { event_id: 'agent-outcome:s', occurred_at: now() }) }, { _id: '1-0', ...outcome({ event_id: 'agent-outcome:u', success: 'true' }) }]);
    expect(verdicts()).toEqual([{ event_id: 'agent-outcome:s', verdict: 'verified', mode: 'shadow' }, { event_id: 'agent-outcome:u', verdict: 'unsigned', mode: 'shadow' }]);
    expect(fleetOutcomes()).toEqual([{ task_id: 'agent-outcome:s', success: 1 }, { task_id: 'agent-outcome:u', success: 1 }]);
    // redelivery keeps the first verdict (no replay verdict for the bus's own re-read)
    await poll([{ _id: '2-0', ...signed(key, { event_id: 'agent-outcome:s', occurred_at: now() }) }]);
    expect(verdicts()).toHaveLength(2);
  });

  it('enforce scores only verified events; unsigned and forged are stored, never scored — not even by a later off catch-up', async () => {
    vi.stubEnv('FLEET_EVENT_SIGNATURES', 'enforce');
    const key = registerFleetHostKey(db, 'macmini');
    const forged = outcome({ event_id: 'agent-outcome:f', host: 'macmini', key_id: key.key_id, occurred_at: now() });
    forged.sig = signFleetEventHmac('attacker', forged);
    await poll([
      { _id: '3-0', ...signed(key, { event_id: 'agent-outcome:s', occurred_at: now() }) },
      { _id: '2-0', ...outcome({ event_id: 'agent-outcome:u' }) },
      { _id: '1-0', ...forged },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM external_events WHERE event_type = 'agent.outcome'").get()).toEqual({ n: 3 });
    expect(verdicts()).toEqual([
      { event_id: 'agent-outcome:f', verdict: 'bad_signature', mode: 'enforce' },
      { event_id: 'agent-outcome:s', verdict: 'verified', mode: 'enforce' },
      { event_id: 'agent-outcome:u', verdict: 'unsigned', mode: 'enforce' },
    ]);
    expect(fleetOutcomes()).toEqual([{ task_id: 'agent-outcome:s', success: 1 }]);
    expect(scoreAgentOutcomes(db, {})).toBe(0);
    expect(fleetOutcomes()).toHaveLength(1);
  });

  it('off (default) verifies nothing and scores as before', async () => {
    await poll([{ _id: '1-0', ...outcome({ event_id: 'agent-outcome:u' }) }]);
    expect(verdicts()).toEqual([]);
    expect(fleetOutcomes()).toEqual([{ task_id: 'agent-outcome:u', success: 1 }]);
  });

  it('evidence: counts per verdict per host and the key list, no secrets; table absent → null, never 0', async () => {
    const empty = new Database(':memory:');
    expect(fleetSignatureEvidence(empty, {})).toEqual({ mode: 'off', by_host: null, keys: null });
    empty.close();
    vi.stubEnv('FLEET_EVENT_SIGNATURES', 'shadow');
    const key = registerFleetHostKey(db, 'macmini');
    await poll([{ _id: '2-0', ...signed(key, { event_id: 'agent-outcome:s', occurred_at: now() }) }, { _id: '1-0', ...outcome({ event_id: 'agent-outcome:u' }) }]);
    const ev = buildEvolutionEvidence(db, { FLEET_EVENT_SIGNATURES: 'shadow' }).fleet_signatures;
    expect(ev.mode).toBe('shadow');
    expect(ev.by_host).toEqual([{ host: '(none)', verdict: 'unsigned', n: 1 }, { host: 'macmini', verdict: 'verified', n: 1 }]);
    expect(ev.keys).toEqual([expect.objectContaining({ host: 'macmini', key_id: key.key_id, alg: 'hmac-sha256', status: 'active' })]);
    expect(JSON.stringify(ev)).not.toContain(key.secret);
  });
});
