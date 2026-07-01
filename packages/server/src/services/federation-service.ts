import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface FederationPeer {
  id: string;
  endpoint: string;
  publicKey: string;
  trustScore: number;
  status: 'pending' | 'trusted' | 'untrusted';
  lastSeen: string;
}

export interface FederationMessage {
  id: string;
  peerId: string;
  type: 'capability_discovery' | 'claim_share' | 'skill_share';
  payload: unknown;
  signature: string;
  timestamp: string;
}

interface PeerRow {
  id: string;
  endpoint: string;
  public_key: string;
  trust_score: number;
  status: string;
  last_seen: string;
}

interface MessageRow {
  id: string;
  peer_id: string;
  type: string;
  payload: string;
  signature: string;
  created_at: string;
}

export class FederationService {
  private piiPatterns: Array<{ type: string; pattern: RegExp }> = [
    { type: 'email', pattern: /[\w.-]+@[\w.-]+\.\w+/g },
    { type: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
    { type: 'phone', pattern: /\b\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
    { type: 'credit_card', pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
    { type: 'ip_address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
    { type: 'api_key', pattern: /\b(api[_-]?key|token|secret)[\s]*[=:]\s*['"]?[a-zA-Z0-9]{16,}['"]?/gi },
    { type: 'password', pattern: /\b(password|passwd|pwd)[\s]*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi },
    { type: 'url_auth', pattern: /https?:\/\/[^:\s]+:[^@\s]+@[^\s]+/g },
    { type: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { type: 'private_key', pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
    { type: 'date_of_birth', pattern: /\b(0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])[/-](19|20)\d{2}\b/g },
    { type: 'address', pattern: /\b\d+\s+[\w\s]+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd)\b/gi },
    { type: 'zip_code', pattern: /\b\d{5}(-\d{4})?\b/g },
    { type: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  ];

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_peers (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        public_key TEXT,
        trust_score REAL DEFAULT 0.5,
        last_seen TEXT,
        status TEXT DEFAULT 'pending'
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_messages (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        signature TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_fed_peer_status ON federation_peers(status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_fed_msg_peer ON federation_messages(peer_id)');
  }

  registerPeer(endpoint: string, publicKey: string): FederationPeer {
    const id = createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
    this.db.prepare(`
      INSERT OR REPLACE INTO federation_peers (id, endpoint, public_key, status, last_seen)
      VALUES (?, ?, ?, 'pending', datetime('now'))
    `).run(id, endpoint, publicKey);
    return { id, endpoint, publicKey, trustScore: 0.5, status: 'pending', lastSeen: new Date().toISOString() };
  }

  sendMessage(peerId: string, type: string, payload: unknown): FederationMessage {
    const cleanPayload = this.stripPII(JSON.stringify(payload));
    const message: FederationMessage = {
      id: createHash('sha256').update(`${peerId}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16),
      peerId,
      type: type as FederationMessage['type'],
      payload: JSON.parse(cleanPayload),
      signature: '',
      timestamp: new Date().toISOString(),
    };
    message.signature = this.signMessage(message);

    this.db.prepare(`
      INSERT INTO federation_messages (id, peer_id, type, payload, signature)
      VALUES (?, ?, ?, ?, ?)
    `).run(message.id, peerId, type, cleanPayload, message.signature);

    return message;
  }

  receiveMessage(message: FederationMessage): { valid: boolean; reason?: string } {
    const peer = this.db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(message.peerId) as PeerRow | undefined;
    if (!peer) return { valid: false, reason: 'unknown_peer' };
    if (peer.status === 'untrusted') return { valid: false, reason: 'untrusted_peer' };

    const valid = this.verifyMessage(message, peer.public_key);
    if (!valid) return { valid: false, reason: 'invalid_signature' };

    this.db.prepare("UPDATE federation_peers SET last_seen = datetime('now') WHERE id = ?").run(message.peerId);
    return { valid: true };
  }

  calculateTrustScore(peerId: string): number {
    const peer = this.db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(peerId) as PeerRow | undefined;
    if (!peer) return 0;

    const stats = this.db.prepare(`
      SELECT COUNT(*) as total FROM federation_messages WHERE peer_id = ?
    `).get(peerId) as { total: number };

    const successRate = stats.total > 0 ? Math.min(1, stats.total / 10) : 0.5;
    const uptime = peer.last_seen ? this.calculateUptime(peer.last_seen) : 0.5;
    const threat = peer.status === 'untrusted' ? 0 : 1;
    const integrity = 1;

    const score = 0.4 * successRate + 0.2 * uptime + 0.2 * threat + 0.2 * integrity;
    const clamped = Math.max(0, Math.min(1, score));

    this.db.prepare('UPDATE federation_peers SET trust_score = ? WHERE id = ?').run(clamped, peerId);
    return clamped;
  }

  stripPII(payload: string): string {
    let cleaned = payload;
    for (const { type, pattern } of this.piiPatterns) {
      cleaned = cleaned.replace(pattern, `[REDACTED_${type.toUpperCase()}]`);
    }
    return cleaned;
  }

  detectPII(payload: string): string[] {
    const detected: string[] = [];
    for (const { type, pattern } of this.piiPatterns) {
      if (pattern.test(payload)) detected.push(type);
    }
    return [...new Set(detected)];
  }

  getTrustedPeers(): FederationPeer[] {
    const rows = this.db.prepare("SELECT * FROM federation_peers WHERE status = 'trusted'").all() as PeerRow[];
    return rows.map(this.rowToPeer);
  }

  getPendingPeers(): FederationPeer[] {
    const rows = this.db.prepare("SELECT * FROM federation_peers WHERE status = 'pending'").all() as PeerRow[];
    return rows.map(this.rowToPeer);
  }

  trustPeer(peerId: string): void {
    this.db.prepare("UPDATE federation_peers SET status = 'trusted' WHERE id = ?").run(peerId);
  }

  untrustPeer(peerId: string): void {
    this.db.prepare("UPDATE federation_peers SET status = 'untrusted' WHERE id = ?").run(peerId);
  }

  getMessageHistory(peerId: string, limit: number = 20): FederationMessage[] {
    const rows = this.db.prepare('SELECT * FROM federation_messages WHERE peer_id = ? ORDER BY created_at DESC LIMIT ?').all(peerId, limit) as MessageRow[];
    return rows.map(r => ({
      id: r.id,
      peerId: r.peer_id,
      type: r.type as FederationMessage['type'],
      payload: JSON.parse(r.payload),
      signature: r.signature,
      timestamp: r.created_at,
    }));
  }

  private signMessage(message: FederationMessage): string {
    const data = `${message.peerId}-${message.type}-${JSON.stringify(message.payload)}-${message.timestamp}`;
    return createHash('sha256').update(data).digest('hex');
  }

  private verifyMessage(message: FederationMessage, _publicKey: string): boolean {
    const expected = this.signMessage(message);
    return message.signature === expected;
  }

  private calculateUptime(lastSeen: string): number {
    const last = new Date(lastSeen).getTime();
    const now = Date.now();
    const hoursSince = (now - last) / 3600000;
    return Math.max(0, 1 - hoursSince / 24);
  }

  private rowToPeer(row: PeerRow): FederationPeer {
    return {
      id: row.id,
      endpoint: row.endpoint,
      publicKey: row.public_key,
      trustScore: row.trust_score,
      status: row.status as FederationPeer['status'],
      lastSeen: row.last_seen,
    };
  }
}
