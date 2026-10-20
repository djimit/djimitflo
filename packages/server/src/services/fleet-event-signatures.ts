import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySignature } from 'crypto';
import type { Database } from 'better-sqlite3';
import { constTimeEq, resolveSpawnTokenSecret } from './spawn-token';

/**
 * P0-3: signed fleet `agent.outcome` events (in-house; pattern from Agent-Name-Service v2, no third-party code).
 *   FLEET_EVENT_SIGNATURES=off (default) | shadow | enforce
 * shadow = verify every new agent.outcome and record the verdict in fleet_event_signatures; scoring is unchanged.
 * enforce = only `verified` events score a fleet skill outcome; any other verdict is stored but never scored (also not
 * by a later catch-up in off/shadow).
 *
 * Key registry (fleet_event_keys) is per host and server-side only. The key is NEVER taken from the event or a request
 * body (the autogenous anti-pattern): the verifier looks up (host, key_id) in the registry.
 *  - hmac-sha256 (the emitter is Python 3.9 stdlib-only and the stdlib has no Ed25519): the per-host secret is not
 *    stored; it is derived from the existing spawn/host-token master secret (resolveSpawnTokenSecret) as
 *    HMAC(master, 'fleet-event-key|v1|<host>|<key_id>'). Rotating that master invalidates every fleet key.
 *  - ed25519 (Node's built-in crypto; for emitters that have it): the registry stores the host's public key (PEM).
 * Signed body: canonical JSON (sorted keys, no whitespace) of {agent, event_id, host, payload_sha256, success, task_kind,
 * ts}; payload_sha256 = sha256 hex of canonical JSON of the present optional fields (duration_ms, model, ref, tokens) as
 * strings — the Redis bus hands every field back as a string, so strings are the stable form.
 * Replay: the event_id is a single-use nonce (fleet_event_nonces, pruned after 2 × window) and ts must lie within 24 h.
 */
export type FleetSignatureMode = 'off' | 'shadow' | 'enforce';
export const FLEET_SIGNATURE_VERDICTS = ['verified', 'unsigned', 'bad_signature', 'replay', 'unknown_host', 'revoked'] as const;
export type FleetSignatureVerdict = (typeof FLEET_SIGNATURE_VERDICTS)[number];
export type FleetSignatureAlg = 'hmac-sha256' | 'ed25519';
export const FLEET_EVENT_WINDOW_MS = 24 * 3_600_000;
const HOST_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const KEY_ID_RE = /^[a-f0-9]{8,32}$/;
const PAYLOAD_FIELDS = ['duration_ms', 'model', 'ref', 'tokens'] as const;

export const fleetSignatureMode = (env: NodeJS.ProcessEnv = process.env): FleetSignatureMode =>
  env.FLEET_EVENT_SIGNATURES === 'shadow' ? 'shadow' : env.FLEET_EVENT_SIGNATURES === 'enforce' ? 'enforce' : 'off';

export function ensureFleetSignatureTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_event_keys (
      host TEXT NOT NULL, key_id TEXT NOT NULL, alg TEXT NOT NULL, public_key TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (host, key_id));
    CREATE TABLE IF NOT EXISTS fleet_event_nonces (event_id TEXT PRIMARY KEY, host TEXT NOT NULL, seen_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_fleet_event_nonces_seen ON fleet_event_nonces(seen_at);
    CREATE TABLE IF NOT EXISTS fleet_event_signatures (
      event_id TEXT PRIMARY KEY, host TEXT, key_id TEXT, verdict TEXT NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL);
  `);
}

/** Canonical JSON: object keys sorted, no whitespace (matches Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const asBool = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/** The exact bytes that are signed, rebuilt from the event's own fields (never from a signer-supplied body). */
export function fleetSignedBody(event: Record<string, unknown>): string {
  const payload: Record<string, string> = {};
  for (const f of PAYLOAD_FIELDS) if (event[f] !== undefined && event[f] !== null) payload[f] = String(event[f]);
  return canonicalJson({
    agent: String(event.agent ?? ''), event_id: String(event.event_id ?? ''), host: String(event.host ?? ''),
    payload_sha256: createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex'),
    success: asBool(event.success), task_kind: String(event.task_kind ?? ''), ts: String(event.occurred_at ?? ''),
  });
}

/** The per-host HMAC secret (base64url); derived, never stored. Its UTF-8 bytes are the HMAC key on both sides. */
export const deriveFleetHmacKey = (master: string, host: string, keyId: string): string =>
  createHmac('sha256', master).update(`fleet-event-key|v1|${host}|${keyId}`).digest('base64url');

export const signFleetEventHmac = (key: string, event: Record<string, unknown>): string =>
  createHmac('sha256', key).update(fleetSignedBody(event), 'utf8').digest('base64url');

/** Registers a new active key for a host. For hmac-sha256 the returned secret goes to the host's key file only — never logged. */
export function registerFleetHostKey(db: Database, host: string, opts: { alg?: FleetSignatureAlg; publicKey?: string; master?: string; now?: number } = {}):
  { host: string; key_id: string; alg: FleetSignatureAlg; secret?: string } {
  if (!HOST_RE.test(host)) throw new Error('FLEET_HOST_INVALID');
  const alg = opts.alg ?? 'hmac-sha256';
  if (alg === 'ed25519') {
    if (!opts.publicKey) throw new Error('FLEET_PUBLIC_KEY_REQUIRED');
    if (createPublicKey(opts.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('FLEET_PUBLIC_KEY_NOT_ED25519');
  }
  ensureFleetSignatureTables(db);
  const keyId = randomBytes(8).toString('hex');
  db.prepare('INSERT INTO fleet_event_keys (host, key_id, alg, public_key, status, created_at) VALUES (?, ?, ?, ?, \'active\', ?)')
    .run(host, keyId, alg, alg === 'ed25519' ? opts.publicKey : null, new Date(opts.now ?? Date.now()).toISOString());
  return alg === 'hmac-sha256'
    ? { host, key_id: keyId, alg, secret: deriveFleetHmacKey(opts.master ?? resolveSpawnTokenSecret(), host, keyId) }
    : { host, key_id: keyId, alg };
}

/** Revokes one key of a host, or every active key of it when keyId is omitted. Returns the number revoked. */
export function revokeFleetHostKey(db: Database, host: string, keyId?: string, now = Date.now()): number {
  ensureFleetSignatureTables(db);
  return db.prepare(`UPDATE fleet_event_keys SET status = 'revoked', revoked_at = ? WHERE host = ? AND status = 'active'${keyId ? ' AND key_id = ?' : ''}`)
    .run(new Date(now).toISOString(), host, ...(keyId ? [keyId] : [])).changes;
}

export interface FleetVerification { verdict: FleetSignatureVerdict; host: string | null; key_id: string | null }

/**
 * Verifies one agent.outcome event. Order: shape → registry (unknown_host / revoked) → signature → window → nonce,
 * so only a correctly signed event consumes its event_id. Never throws.
 */
export function verifyFleetEvent(db: Database, event: Record<string, unknown>, opts: { master?: string; now?: number } = {}): FleetVerification {
  const now = opts.now ?? Date.now();
  const sig = typeof event.sig === 'string' ? event.sig : '';
  const host = typeof event.host === 'string' && HOST_RE.test(event.host) ? event.host : null;
  const keyId = typeof event.key_id === 'string' && KEY_ID_RE.test(event.key_id) ? event.key_id : null;
  if (!sig) return { verdict: 'unsigned', host, key_id: keyId };
  if (!host || !keyId) return { verdict: 'unknown_host', host, key_id: keyId };
  try {
    const key = db.prepare('SELECT alg, public_key, status FROM fleet_event_keys WHERE host = ? AND key_id = ?').get(host, keyId) as
      { alg: FleetSignatureAlg; public_key: string | null; status: string } | undefined;
    if (!key) return { verdict: 'unknown_host', host, key_id: keyId };
    if (key.status !== 'active') return { verdict: 'revoked', host, key_id: keyId };
    // the nonce is the event's own id: a signed event without one cannot be replay-protected
    if ((event.sig_alg ?? 'hmac-sha256') !== key.alg || typeof event.event_id !== 'string' || !event.event_id) return { verdict: 'bad_signature', host, key_id: keyId };
    const body = fleetSignedBody(event);
    let ok = false;
    if (key.alg === 'hmac-sha256') {
      const expected = createHmac('sha256', deriveFleetHmacKey(opts.master ?? resolveSpawnTokenSecret(), host, keyId)).update(body, 'utf8').digest('base64url');
      ok = constTimeEq(sig, expected);
    } else if (key.alg === 'ed25519' && key.public_key) {
      ok = verifySignature(null, Buffer.from(body, 'utf8'), createPublicKey(key.public_key), Buffer.from(sig, 'base64url'));
    }
    if (!ok) return { verdict: 'bad_signature', host, key_id: keyId };
    const ts = Date.parse(String(event.occurred_at ?? ''));
    if (!Number.isFinite(ts) || Math.abs(now - ts) > FLEET_EVENT_WINDOW_MS) return { verdict: 'replay', host, key_id: keyId };
    const fresh = db.prepare('INSERT OR IGNORE INTO fleet_event_nonces (event_id, host, seen_at) VALUES (?, ?, ?)').run(String(event.event_id), host, now).changes > 0;
    return { verdict: fresh ? 'verified' : 'replay', host, key_id: keyId };
  } catch {
    return { verdict: 'bad_signature', host, key_id: keyId };
  }
}

export function recordFleetVerdict(db: Database, eventId: string, v: FleetVerification, mode: FleetSignatureMode, now = Date.now()): void {
  db.prepare('INSERT OR IGNORE INTO fleet_event_signatures (event_id, host, key_id, verdict, mode, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(eventId, v.host, v.key_id, v.verdict, mode, new Date(now).toISOString());
}

/** Nonces older than two windows can go: an event that old is already rejected by the ts window. */
export const pruneFleetNonces = (db: Database, now = Date.now()): number =>
  db.prepare('DELETE FROM fleet_event_nonces WHERE seen_at < ?').run(now - 2 * FLEET_EVENT_WINDOW_MS).changes;

/** Evidence `fleet_signatures` (read-only): mode, verdict counts per host, key list (no secrets). null = table absent (never 0). */
export function fleetSignatureEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, since?: string) {
  const mode = fleetSignatureMode(env);
  try {
    const by_host = db.prepare(`SELECT COALESCE(host, '(none)') AS host, verdict, COUNT(*) AS n FROM fleet_event_signatures${since ? ' WHERE at >= ?' : ''}
      GROUP BY 1, 2 ORDER BY 1, 2`).all(...(since ? [since] : [])) as Array<{ host: string; verdict: string; n: number }>;
    const keys = db.prepare('SELECT host, key_id, alg, status, created_at, revoked_at FROM fleet_event_keys ORDER BY host, created_at').all() as
      Array<{ host: string; key_id: string; alg: string; status: string; created_at: string; revoked_at: string | null }>;
    return { mode, by_host, keys };
  } catch {
    return { mode, by_host: null, keys: null };
  }
}
