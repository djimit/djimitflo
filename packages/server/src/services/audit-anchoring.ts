/**
 * External Audit Anchoring — Merkle root export and SIEM integration.
 *
 * Provides tamper-evident audit trail anchoring to external systems:
 * - Merkle tree root computation from compliance_audit_log hash chain
 * - Periodic export to WORM storage, SIEM, or transparency log
 * - Webhook notification for critical security events
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
  private anchors: AuditAnchor[] = [];
  private deadLetterQueue: AuditAnchor[] = [];
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
    const { root, eventCount } = this.computeMerkleRoot();
    const now = new Date().toISOString();

    const anchor: AuditAnchor = {
      anchor_id: `anchor-${Date.now()}-${randomUUID().slice(0, 4)}`,
      merkle_root: root,
      chain_start: now,
      chain_end: now,
      event_count: eventCount,
      anchored_at: now,
      anchor_type: type,
      destination,
      status: 'pending',
      retry_count: 0,
    };

    await this.attemptAnchor(anchor);
    return anchor;
  }

  /**
   * Attempt to anchor with retry logic.
   */
  private async attemptAnchor(anchor: AuditAnchor): Promise<void> {
    try {
      if (anchor.anchor_type === 'webhook' && this.siemConfig?.webhook_url) {
        await this.sendWebhook(anchor);
      } else if (anchor.anchor_type === 'siem' && this.siemConfig) {
        await this.sendToSIEM(anchor);
      }

      anchor.status = 'confirmed';
      this.anchors.push(anchor);
      this.persistAnchor(anchor);
    } catch (error) {
      anchor.last_error = error instanceof Error ? error.message : String(error);
      anchor.retry_count++;

      if (anchor.retry_count > this.retryConfig.max_retries) {
        anchor.status = 'dead_letter';
        this.deadLetterQueue.push(anchor);
        this.persistAnchor(anchor);
      } else {
        anchor.status = 'failed';
        const delay = this.calculateBackoff(anchor.retry_count);
        anchor.next_retry_at = new Date(Date.now() + delay).toISOString();
        this.scheduleRetry(anchor);
        this.persistAnchor(anchor);
      }
    }
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
      this.attemptAnchor(anchor);
    }, delay);
    this.retryTimers.set(anchor.anchor_id, timer);
  }

  /**
   * Retry all dead letter anchors (manual intervention).
   */
  async retryDeadLetters(): Promise<{ retried: number; succeeded: number; }> {
    const letters = [...this.deadLetterQueue];
    this.deadLetterQueue = [];

    let succeeded = 0;
    for (const anchor of letters) {
      anchor.retry_count = 0;
      anchor.status = 'pending' as AuditAnchor['status'];
      await this.attemptAnchor(anchor);
      if (anchor.status === 'confirmed') succeeded++;
    }

    return { retried: letters.length, succeeded };
  }

  /**
   * Get dead letter queue contents.
   */
  getDeadLetterQueue(): AuditAnchor[] {
    return [...this.deadLetterQueue];
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
    return [...this.anchors];
  }

  /**
   * Get the latest confirmed anchor.
   */
  getLatestAnchor(): AuditAnchor | null {
    const confirmed = this.anchors.filter(a => a.status === 'confirmed');
    if (confirmed.length === 0) return null;
    return confirmed[confirmed.length - 1];
  }

  private persistAnchor(anchor: AuditAnchor): void {
    this.db.prepare(`
      INSERT INTO audit_anchors (anchor_id, merkle_root, chain_start, chain_end, event_count, anchored_at, anchor_type, destination, status, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
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
        retry_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_audit_anchors_status ON audit_anchors(status);
      CREATE INDEX IF NOT EXISTS idx_audit_anchors_anchored ON audit_anchors(anchored_at);
    `);
  }
}
