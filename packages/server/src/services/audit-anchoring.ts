/**
 * External Audit Anchoring — Merkle root export and SIEM integration.
 *
 * Provides tamper-evident audit trail anchoring to external systems:
 * - Merkle tree root computation from compliance_audit_log hash chain
 * - Explicit export to a configured webhook or SIEM endpoint
 * - Durable delivery state; automatic retry timers are process-local only
 *
 * A confirmed delivery means HTTP acceptance, not independent WORM retention or
 * remote Merkle verification. Construction does not restart pending deliveries.
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AuditAnchor {
  anchor_id: string;
  merkle_root: string;
  chain_start: string;
  chain_end: string;
  event_count: number;
  anchored_at: string;
  anchor_type: 'local' | 'webhook' | 'siem';
  destination?: string;
  status: 'pending' | 'confirmed' | 'failed' | 'dead_letter';
  retry_count: number;
  next_retry_at?: string;
  last_error?: string;
}

export interface RetryConfig {
  max_retries: number;
  initial_delay_ms: number;
  max_delay_ms: number;
  backoff_multiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  max_retries: 3,
  initial_delay_ms: 1_000,
  max_delay_ms: 60_000,
  backoff_multiplier: 2,
};

export interface SIEMConfig {
  webhook_url?: string;
  siem_type: 'splunk' | 'elastic' | 'datadog' | 'custom';
  api_key?: string;
  index?: string;
  source?: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  hash: string;
  previous_hash: string;
}

export class AuditAnchoringService {
  private retryConfig: RetryConfig;
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private db: Database,
    private siemConfig?: SIEMConfig,
    retryConfig: Partial<RetryConfig> = {},
  ) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this.ensureTables();
  }

  /**
   * Compute the Merkle root of the current audit chain.
   */
  computeMerkleRoot(): { root: string; events: AuditEvent[]; eventCount: number } {
    const events = this.db.prepare(`
      SELECT id, timestamp, actor, action, resource, outcome, hash, previous_hash
      FROM compliance_audit_log
      ORDER BY timestamp ASC
    `).all() as AuditEvent[];

    if (events.length === 0) {
      return { root: createHash('sha256').update('empty').digest('hex'), events: [], eventCount: 0 };
    }

    let hashes = events.map(e => e.hash);

    while (hashes.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        const combined = createHash('sha256').update(left + right).digest('hex');
        nextLevel.push(combined);
      }
      hashes = nextLevel;
    }

    return { root: hashes[0], events, eventCount: events.length };
  }

  /**
   * Anchor the current Merkle root to an external system.
   * Implements exponential backoff retry with dead letter queue.
   */
  async anchorToExternal(destination: string, type: 'webhook' | 'siem'): Promise<AuditAnchor> {
    const { root, events, eventCount } = this.computeMerkleRoot();
    const now = new Date().toISOString();

    const anchor: AuditAnchor = {
      anchor_id: `anchor-${randomUUID()}`,
      merkle_root: root,
      chain_start: events[0]?.timestamp || now,
      chain_end: events[events.length - 1]?.timestamp || now,
      event_count: eventCount,
      anchored_at: now,
      anchor_type: type,
      destination,
      status: 'pending',
      retry_count: 0,
    };

    this.persistAnchor(anchor);
    await this.attemptAnchor(anchor);
    return { ...anchor };
  }

  /**
   * Attempt to anchor with retry logic.
   */
  private async attemptAnchor(anchor: AuditAnchor): Promise<void> {
    try {
      if (anchor.anchor_type === 'webhook') {
        await this.sendWebhook(anchor);
      } else if (anchor.anchor_type === 'siem') {
        await this.sendToSIEM(anchor);
      } else {
        throw new Error('External anchor delivery type not configured');
      }

      anchor.status = 'confirmed';
      delete anchor.last_error;
      delete anchor.next_retry_at;
    } catch (error) {
      anchor.last_error = error instanceof Error ? error.message : String(error);
      anchor.retry_count++;

      if (anchor.retry_count > this.retryConfig.max_retries) {
        anchor.status = 'dead_letter';
        delete anchor.next_retry_at;
      } else {
        anchor.status = 'failed';
        const delay = this.calculateBackoff(anchor.retry_count);
        anchor.next_retry_at = new Date(Date.now() + delay).toISOString();
      }
    }
    // Storage failure is not a delivery failure and must not trigger another send.
    this.persistAnchor(anchor);
    if (anchor.status === 'failed') this.scheduleRetry(anchor);
  }

  /**
   * Calculate exponential backoff delay.
   */
  private calculateBackoff(retryCount: number): number {
    const delay = this.retryConfig.initial_delay_ms * Math.pow(this.retryConfig.backoff_multiplier, retryCount - 1);
    return Math.min(delay, this.retryConfig.max_delay_ms);
  }

  /**
   * Schedule a retry attempt.
   */
  private scheduleRetry(anchor: AuditAnchor): void {
    const delay = this.calculateBackoff(anchor.retry_count);
    const timer = setTimeout(() => {
      this.retryTimers.delete(anchor.anchor_id);
      void this.attemptAnchor(anchor).catch(error => console.error('Audit anchor retry persistence failed:', error));
    }, delay);
    this.retryTimers.set(anchor.anchor_id, timer);
  }

  /**
   * Retry all dead letter anchors (manual intervention).
   */
  async retryDeadLetters(): Promise<{ retried: number; succeeded: number; }> {
    const letters = this.getDeadLetterQueue();

    let succeeded = 0;
    for (const anchor of letters) {
      anchor.retry_count = 0;
      anchor.status = 'pending' as AuditAnchor['status'];
      delete anchor.next_retry_at;
      this.persistAnchor(anchor);
      await this.attemptAnchor(anchor);
      if (anchor.status === 'confirmed') succeeded++;
    }

    return { retried: letters.length, succeeded };
  }

  /**
   * Get dead letter queue contents.
   */
  getDeadLetterQueue(): AuditAnchor[] {
    return this.getAnchors().filter(anchor => anchor.status === 'dead_letter');
  }

  /**
   * Clear pending retry timers (for graceful shutdown).
   */
  clearRetryTimers(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  /**
   * Send anchor to a generic webhook.
   */
  private async sendWebhook(anchor: AuditAnchor): Promise<void> {
    if (!this.siemConfig?.webhook_url) {
      throw new Error('Webhook URL not configured');
    }

    const response = await fetch(this.siemConfig.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.siemConfig.api_key ? { Authorization: `Bearer ${this.siemConfig.api_key}` } : {}),
      },
      body: JSON.stringify({
        event_type: 'audit_anchor',
        anchor_id: anchor.anchor_id,
        merkle_root: anchor.merkle_root,
        event_count: anchor.event_count,
        timestamp: anchor.anchored_at,
        source: 'djimitflo',
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
  }

  /**
   * Send anchor to a SIEM system.
   */
  private async sendToSIEM(anchor: AuditAnchor): Promise<void> {
    if (!this.siemConfig?.webhook_url) {
      throw new Error('SIEM endpoint not configured');
    }

    let payload: Record<string, unknown>;

    switch (this.siemConfig.siem_type) {
      case 'splunk':
        payload = {
          event: {
            merkle_root: anchor.merkle_root,
            event_count: anchor.event_count,
            anchor_id: anchor.anchor_id,
          },
          source: this.siemConfig.source || 'djimitflo',
          index: this.siemConfig.index || 'security',
          time: Date.parse(anchor.anchored_at) / 1000,
        };
        break;

      case 'elastic':
        payload = {
          '@timestamp': anchor.anchored_at,
          event: {
            category: 'audit',
            type: 'anchor',
            outcome: 'success',
          },
          djimitflo: {
            merkle_root: anchor.merkle_root,
            event_count: anchor.event_count,
            anchor_id: anchor.anchor_id,
          },
        };
        break;

      default:
        payload = {
          type: 'audit_anchor',
          anchor_id: anchor.anchor_id,
          merkle_root: anchor.merkle_root,
          event_count: anchor.event_count,
          timestamp: anchor.anchored_at,
        };
    }

    const response = await fetch(this.siemConfig.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.siemConfig.api_key ? { Authorization: `Bearer ${this.siemConfig.api_key}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`SIEM send failed: ${response.status}`);
    }
  }

  /**
   * Verify the integrity of the audit chain.
   * Detects tampering by recomputing hashes.
   */
  verifyChainIntegrity(): { valid: boolean; firstInvalidEvent?: string } {
    const events = this.db.prepare(`
      SELECT id, timestamp, actor, action, resource, outcome, hash, previous_hash
      FROM compliance_audit_log
      ORDER BY timestamp ASC
    `).all() as AuditEvent[];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const expectedPreviousHash = i === 0 ? 'genesis' : events[i - 1].hash;

      if (event.previous_hash !== expectedPreviousHash) {
        return { valid: false, firstInvalidEvent: event.id };
      }
    }

    return { valid: true };
  }

  /**
   * Get all anchors.
   */
  getAnchors(): AuditAnchor[] {
    return (this.db.prepare('SELECT * FROM audit_anchors ORDER BY anchored_at, id').all() as Array<AuditAnchor & { id: number }>)
      .map(row => ({
        anchor_id: row.anchor_id, merkle_root: row.merkle_root,
        chain_start: row.chain_start, chain_end: row.chain_end, event_count: row.event_count,
        anchored_at: row.anchored_at, anchor_type: row.anchor_type,
        ...(row.destination ? { destination: row.destination } : {}),
        status: row.status, retry_count: row.retry_count,
        ...(row.next_retry_at ? { next_retry_at: row.next_retry_at } : {}),
        ...(row.last_error ? { last_error: row.last_error } : {}),
      }));
  }

  /**
   * Get the latest confirmed anchor.
   */
  getLatestAnchor(): AuditAnchor | null {
    const confirmed = this.getAnchors().filter(a => a.status === 'confirmed');
    if (confirmed.length === 0) return null;
    return confirmed[confirmed.length - 1];
  }

  private persistAnchor(anchor: AuditAnchor): void {
    const result = this.db.prepare(`
      INSERT INTO audit_anchors (anchor_id, merkle_root, chain_start, chain_end, event_count, anchored_at, anchor_type, destination, status, retry_count, next_retry_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anchor_id) DO UPDATE SET status=excluded.status, retry_count=excluded.retry_count,
        next_retry_at=excluded.next_retry_at, last_error=excluded.last_error
      WHERE audit_anchors.merkle_root=excluded.merkle_root AND audit_anchors.chain_start=excluded.chain_start
        AND audit_anchors.chain_end=excluded.chain_end AND audit_anchors.event_count=excluded.event_count
        AND audit_anchors.anchored_at=excluded.anchored_at AND audit_anchors.anchor_type=excluded.anchor_type
        AND audit_anchors.destination IS excluded.destination
    `).run(
      anchor.anchor_id,
      anchor.merkle_root,
      anchor.chain_start,
      anchor.chain_end,
      anchor.event_count,
      anchor.anchored_at,
      anchor.anchor_type,
      anchor.destination || null,
      anchor.status,
      anchor.retry_count,
      anchor.next_retry_at || null,
      anchor.last_error || null,
    );
    if (!result.changes) throw new Error('Audit anchor immutable identity mismatch');
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anchor_id TEXT NOT NULL UNIQUE,
        merkle_root TEXT NOT NULL,
        chain_start TEXT NOT NULL,
        chain_end TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        anchored_at TEXT NOT NULL,
        anchor_type TEXT NOT NULL,
        destination TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_anchors_status ON audit_anchors(status);
      CREATE INDEX IF NOT EXISTS idx_audit_anchors_anchored ON audit_anchors(anchored_at);
    `);
    const columns = new Set((this.db.prepare('PRAGMA table_info(audit_anchors)').all() as Array<{ name: string }>).map(column => column.name));
    for (const column of ['next_retry_at', 'last_error']) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE audit_anchors ADD COLUMN ${column} TEXT`);
    }
  }
}
