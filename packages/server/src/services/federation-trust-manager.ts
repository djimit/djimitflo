import { randomUUID, createHash as cryptoCreateHash } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface FederationToken {
  id: string;
  peerId: string;
  scopes: string[];
  tokenHash: string;
  expiresAt: string;
  revoked: boolean;
  createdAt: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  peerId?: string;
  scopes?: string[];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

interface TokenRow {
  id: string;
  peer_id: string;
  scopes_json: string;
  token_hash: string;
  expires_at: string;
  revoked: number;
  created_at: string;
}

export class FederationTrustManager {
  private rateLimitPerMinute = 10;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_tokens (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_ft_peer ON federation_tokens(peer_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_ft_hash ON federation_tokens(token_hash)');
  }

  issueToken(peerId: string, scopes: string[], ttlHours: number = 24): FederationToken {
    const id = randomUUID();
    const tokenValue = randomUUID() + randomUUID();
    const tokenHash = cryptoCreateHash('sha256').update(tokenValue).digest('hex');
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

    this.db.prepare(`
      INSERT INTO federation_tokens (id, peer_id, scopes_json, token_hash, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, peerId, JSON.stringify(scopes), tokenHash, expiresAt);

    return { id, peerId, scopes, tokenHash, expiresAt, revoked: false, createdAt: new Date().toISOString() };
  }

  verifyToken(tokenHash: string): VerificationResult {
    const row = this.db.prepare('SELECT * FROM federation_tokens WHERE token_hash = ?').get(tokenHash) as TokenRow | undefined;

    if (!row) return { valid: false, reason: 'token not found' };
    if (row.revoked === 1) return { valid: false, reason: 'token revoked' };

    const expires = new Date(row.expires_at).getTime();
    if (Date.now() > expires) return { valid: false, reason: 'token expired' };

    return {
      valid: true,
      peerId: row.peer_id,
      scopes: JSON.parse(row.scopes_json) as string[],
    };
  }

  revokeToken(tokenId: string): void {
    this.db.prepare('UPDATE federation_tokens SET revoked = 1 WHERE id = ?').run(tokenId);
  }

  checkRateLimit(peerId: string): RateLimitResult {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const row = this.db.prepare(
      'SELECT COUNT(*) as c FROM federation_tokens WHERE peer_id = ? AND created_at > ?'
    ).get(peerId, oneMinuteAgo) as { c: number };

    const used = row.c;
    return {
      allowed: used < this.rateLimitPerMinute,
      remaining: Math.max(0, this.rateLimitPerMinute - used),
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  getTrustedPeers(): Array<{ peerId: string; tokenCount: number; activeScopes: string[] }> {
    const rows = this.db.prepare(`
      SELECT peer_id, COUNT(*) as token_count, scopes_json
      FROM federation_tokens WHERE revoked = 0 AND expires_at > datetime('now')
      GROUP BY peer_id
    `).all() as Array<{ peer_id: string; token_count: number; scopes_json: string }>;

    return rows.map(r => ({
      peerId: r.peer_id,
      tokenCount: r.token_count,
      activeScopes: JSON.parse(r.scopes_json) as string[],
    }));
  }
}


