/**
 * spawn-token — scoped, expiring HMAC spawn tokens for nested agent spawning.
 *
 * Leaf module (no service deps) shared by NestedSpawnService (validates tokens over
 * the HTTP control endpoint) and LoopService (mints a child's own token to inject
 * into that child's env so it can self-spawn). Extracting this here breaks what
 * would otherwise be a LoopService → NestedSpawnService → LoopService cycle, and
 * avoids the instance-wiring problem (the LoopService that runs executeMaker is
 * not the NestedSpawnService instance built in the spawn router).
 *
 * Token shape: `base64url("leaseId|spawnTreeId|expiresAt").sig` where sig is
 * HMAC-SHA256(secret, payloadB64). Scoped to a single (leaseId, spawnTreeId) pair
 * and a short TTL so a leaked child token can only spawn children inside that one
 * tree within its lease window. Validation is constant-time on the signature.
 */

import { createHmac, randomBytes } from 'crypto';

export const SPAWN_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes — a child lease's spawn window.
const EPHEMERAL_DEV_SPAWN_KEY = randomBytes(32).toString('base64url');
let warnedAboutEphemeralSecret = false;

/**
 * Resolve the HMAC secret from the environment. An operator may set a dedicated
 * DJIMITFLO_SPAWN_TOKEN_SECRET; otherwise JWT_SECRET is reused. Production
 * fails closed when neither is configured. Local/test development gets a
 * per-process ephemeral secret so tokens remain scoped without relying on a
 * predictable value committed in the repo.
 */
export function resolveSpawnTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DJIMITFLO_SPAWN_TOKEN_SECRET) return env.DJIMITFLO_SPAWN_TOKEN_SECRET;
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error('SPAWN_TOKEN_SECRET_REQUIRED');
  }
  if (!warnedAboutEphemeralSecret && env.NODE_ENV !== 'test') {
    warnedAboutEphemeralSecret = true;
    console.warn('WARNING: DJIMITFLO_SPAWN_TOKEN_SECRET/JWT_SECRET unset; using an ephemeral local spawn-token secret.');
  }
  return EPHEMERAL_DEV_SPAWN_KEY;
}

/** Constant-time string comparison to avoid leaking signature bytes via timing. */
export function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a scoped, expiring spawn token (HMAC). Never printed except by the caller. */
export function mintSpawnToken(secret: string, leaseId: string, spawnTreeId: string, ttlMs: number = SPAWN_TOKEN_TTL_MS): string {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${leaseId}|${spawnTreeId}|${expiresAt}`;
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Validate a spawn token against the expected (leaseId, spawnTreeId) scope and the
 * secret. Returns false (never throws) on any malformed/expired/wrong-scope token;
 * the caller maps that to a 401 SPAWN_TOKEN_INVALID at the HTTP layer.
 */
export function validateSpawnToken(secret: string, token: string, expectedLeaseId: string, expectedTreeId: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (sig.length !== expected.length || !constTimeEq(sig, expected)) return false;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const [leaseId, treeId, expiresAtStr] = payload.split('|');
  if (leaseId !== expectedLeaseId || treeId !== expectedTreeId) return false;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return true;
}
