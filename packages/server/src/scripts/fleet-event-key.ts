/**
 * P0-3: operator-run fleet event key registry (FLEET_EVENT_SIGNATURES). Run inside the Djimitflo container so the master
 * secret (DJIMITFLO_SPAWN_TOKEN_SECRET / JWT_SECRET) never leaves it:
 *   node dist/scripts/fleet-event-key.js --db <path> mint --host <host>        → prints ONE key-file line to stdout (pipe it)
 *   node dist/scripts/fleet-event-key.js --db <path> register-ed25519 --host <host> --public-key-file <pem>
 *   node dist/scripts/fleet-event-key.js --db <path> revoke --host <host> [--key-id <id>]
 *   node dist/scripts/fleet-event-key.js --db <path> list                       → hosts, key ids, status (no secrets)
 * Exit: 0 ok, 2 refused, 64 usage.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { fleetSignatureEvidence, registerFleetHostKey, revokeFleetHostKey } from '../services/fleet-event-signatures';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
const command = ['mint', 'register-ed25519', 'revoke', 'list'].find((c) => process.argv.includes(c));
const dbPath = arg('db'); const host = arg('host');
if (!dbPath || !command || (command !== 'list' && !host)) {
  console.error('usage: fleet-event-key --db <path> mint|register-ed25519|revoke|list [--host <host>] [--key-id <id>] [--public-key-file <pem>]');
  process.exit(64);
}
const db = new Database(dbPath, { timeout: 10_000 });
try {
  if (command === 'mint') {
    const k = registerFleetHostKey(db, host);
    process.stdout.write(`${k.host} ${k.key_id} ${k.secret}\n`); // the key-file line; pipe it, never paste it
    console.error(`minted fleet event key ${k.key_id} for ${k.host}`);
  } else if (command === 'register-ed25519') {
    const k = registerFleetHostKey(db, host, { alg: 'ed25519', publicKey: fs.readFileSync(arg('public-key-file'), 'utf8') });
    console.log(JSON.stringify(k));
  } else if (command === 'revoke') {
    console.log(JSON.stringify({ host, revoked: revokeFleetHostKey(db, host, arg('key-id') || undefined) }));
  } else {
    console.log(JSON.stringify(fleetSignatureEvidence(db).keys, null, 2));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2;
} finally { db.close(); }
