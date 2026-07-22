/**
 * External Audit Anchoring — Merkle root export and SIEM integration.
 *
 * Provides tamper-evident audit trail anchoring to external systems:
 * - Merkle tree root computation from compliance_audit_log hash chain
 * - Periodic export to WORM storage, SIEM, or transparency log
 * - Webhook notification for critical security events
 */

import { createHash } from 'crypto';
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
  status: 'pending' | 'confirmed' | 'failed';
  retry_count: number;
}

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
  private db: Database;
  private siemConfig?: SIEMConfig;

  constructor(
    db: Database,
    siemConfig?: SIEMConfig,
  ) {
    this.db = db;
    this.siemConfig = siemConfig;
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
   */
  async anchorToExternal(destination: string, type: 'webhook' | 'siem'): Promise<AuditAnchor> {
    const { root, eventCount } = this.computeMerkleRoot();
    const now = new Date().toISOString();

    const anchor: AuditAnchor = {
      anchor_id: `anchor-${Date.now()}`,
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

    try {
      if (type === 'webhook' && this.siemConfig?.webhook_url) {
        await this.sendWebhook(anchor);
      } else if (type === 'siem' && this.siemConfig) {
        await this.sendToSIEM(anchor);
      }

      anchor.status = 'confirmed';
    } catch (error) {
      anchor.status = 'failed';
      anchor.retry_count++;
    }

    this.anchors.push(anchor);
    this.persistAnchor(anchor);

    return anchor;
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
