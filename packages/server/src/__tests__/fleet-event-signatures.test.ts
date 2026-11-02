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
  FLEET_EVENT_WINDOW_MS, fleetSignatureEvidence, fleetSignedBody, pruneFleetNonces, registerFleetHostKey, revokeFleetHostKey,
  signFleetEventHmac, verifyFleetEvent,
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
