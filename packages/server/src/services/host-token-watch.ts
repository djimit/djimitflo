import type { Database } from 'better-sqlite3';
import type { Stall } from './stall-watch';

/**
 * Prod 27-10: the workstation's 30-day gym-worker token expired at 00:24Z. The remote gym, PL-001, remote makers and kb-sync
 * got 401 GYM_WORKER_TOKEN_INVALID for 7+ hours and the stall watch said nothing: rejections were only a console line, and an
 * issued token's expiry lives in its HMAC payload only. Recorded here per (host, scope): the last valid authentication, the
 * expiry that token states, and the current rejection streak (reason only). Never the token. A rejection only updates a host
 * that authenticated before, so an unknown caller cannot grow the table. Report-only: the stall watch reads it.
 */
export const HOST_TOKEN_REPEATS = 3;
export const HOST_TOKEN_ACTIVE_DAYS = 7;
export const HOST_TOKEN_EXPIRY_WARN_DAYS = 7;
/** a valid authentication is written at most this often per host × scope (hosts poll every few seconds), or at a new token */
const OK_WRITE_EVERY_MS = 10 * 60_000;
const lastOkWrite = new WeakMap<Database, Map<string, { at: number; exp: number | null }>>();
const iso = (ms: number) => new Date(ms).toISOString();

export function recordHostTokenOk(db: Database, host: string, scope: string, expiresAt: number | null, now = Date.now()): void {
  const seen = lastOkWrite.get(db) ?? new Map(); lastOkWrite.set(db, seen);
  const key = `${scope}|${host}`; const prev = seen.get(key);
  if (prev && prev.exp === expiresAt && now - prev.at < OK_WRITE_EVERY_MS) return;
  try {
    db.prepare(`INSERT INTO host_token_auth (host, scope, last_ok_at, token_expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(host, scope) DO UPDATE SET last_ok_at = excluded.last_ok_at, token_expires_at = excluded.token_expires_at`)
      .run(host.slice(0, 100), scope, iso(now), expiresAt === null ? null : iso(expiresAt));
    seen.set(key, { at: now, exp: expiresAt });
  } catch { /* table absent: the watch is advisory, auth never fails on it */ }
}

/** A rejection after a valid authentication starts a new streak; later ones extend it. */
export function recordHostTokenRejection(db: Database, host: string, scope: string, reason: string, now = Date.now()): void {
  lastOkWrite.get(db)?.delete(`${scope}|${host}`); // the next valid authentication is written at once, ending the streak
  const at = iso(now);
  try {
    db.prepare(`UPDATE host_token_auth SET
        rejected_count = CASE WHEN first_rejected_at IS NULL OR first_rejected_at < last_ok_at THEN 1 ELSE rejected_count + 1 END,
        first_rejected_at = CASE WHEN first_rejected_at IS NULL OR first_rejected_at < last_ok_at THEN ? ELSE first_rejected_at END,
        last_rejected_at = ?, last_reason = ?
      WHERE host = ? AND scope = ?`).run(at, at, reason.slice(0, 40), host.slice(0, 100), scope);
  } catch { /* table absent */ }
}

/**
 * Hosts with a valid authentication in the last 7 days whose token is refused repeatedly since (host_token:<scope>:<host>), or
 * whose token expires within 7 days (host_token_expiry:<scope>:<host>; superseded by the first). Throws on a missing table.
 */
export function hostTokenStalls(db: Database, now = Date.now()): Stall[] {
  const rows = db.prepare('SELECT * FROM host_token_auth WHERE last_ok_at >= ? ORDER BY scope, host').all(iso(now - HOST_TOKEN_ACTIVE_DAYS * 86_400_000)) as Array<{
    host: string; scope: string; last_ok_at: string; token_expires_at: string | null; first_rejected_at: string | null; last_rejected_at: string | null; rejected_count: number; last_reason: string | null }>;
  const out: Stall[] = [];
  for (const r of rows) {
    if (r.first_rejected_at && r.first_rejected_at > r.last_ok_at && r.rejected_count >= HOST_TOKEN_REPEATS) {
      out.push({ subsystem: `host_token:${r.scope}:${r.host}`, since: r.first_rejected_at,
        detail: `${r.rejected_count} ${r.scope} token rejections from ${r.host} since ${r.first_rejected_at} (last: ${r.last_reason} at ${r.last_rejected_at}); its last valid authentication was ${r.last_ok_at}. Mint a new token for the host and install it`.slice(0, 300) });
    } else if (r.token_expires_at && Date.parse(r.token_expires_at) <= now + HOST_TOKEN_EXPIRY_WARN_DAYS * 86_400_000) {
      const past = Date.parse(r.token_expires_at) <= now;
      out.push({ subsystem: `host_token_expiry:${r.scope}:${r.host}`, since: past ? r.token_expires_at : null,
        detail: `the ${r.scope} token of ${r.host} ${past ? 'expired' : 'expires'} at ${r.token_expires_at}; mint a new token for the host and install it before then` });
    }
  }
  return out;
}
