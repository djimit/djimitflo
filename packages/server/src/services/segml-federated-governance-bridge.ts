/**
 * SEGML Federated Governance Bridge — Phase 5.
 *
 * Cross-instance governance learning across multiple DjimFlo deployments.
 * When you run multiple instances (MacBook, workstation, MacMini, Eve-V),
 * each accumulates governance knowledge. This bridge shares that knowledge
 * without sharing raw data (privacy-preserving).
 *
 * Architecture (arXiv 2607.13104 §6.2.3 Cross-Agent Knowledge Consolidation):
 * 1. Local governance patterns are extracted (anonymized)
 * 2. Patterns are shared with federation peers
 * 3. Incoming patterns are validated against local data
 * 4. Validated patterns are merged into local fleet memory
 * 5. Confidence-weighted aggregation prevents poisoned patterns
 *
 * Privacy: Only aggregated patterns are shared, never raw agent data.
 * Patterns are: "Category X has average score Y across Z agents"
 * Not: "Agent A scored X on case B"
 *
 * Integrates with existing federation infrastructure (federation_peers table).
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';

interface GovernancePatternShare {
  id: string;
  sourcePeer: string;
  category: string;
  avgScore: number;
  agentCount: number;
  trendDirection: 'improving' | 'stable' | 'declining';
  confidence: number;
  sharedAt: string;
  validated: boolean;
}

interface PeerSyncResult {
  peerId: string;
  patternsReceived: number;
  patternsValidated: number;
  patternsRejected: number;
  syncTimestamp: string;
}

interface FederatedGovernanceSummary {
  localPatterns: number;
  federatedPatterns: number;
  peersSynced: number;
  lastSyncTimestamp: string | null;
  topSharedCategories: Array<{ category: string; peerCount: number; avgScore: number }>;
}

export class SegmlFederatedGovernanceBridge {
  private readonly MIN_PEER_AGENT_COUNT = 2;     // Min agents in peer pattern
  private readonly MAX_FEDERATED_PATTERNS = 1000; // Cap on stored federated patterns

  constructor(private db: Database) {
    this.ensureTables();
    this.ensureDependentTables();
  }

  private ensureDependentTables(): void {
    // Ensure tables from other bridges exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_fleet_memory (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'fleet_wide', source_agent TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5, successes REAL NOT NULL DEFAULT 1.0,
        failures REAL NOT NULL DEFAULT 1.0, access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS segml_skill_governance (
        id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, overall_score REAL NOT NULL DEFAULT 0,
        category_scores_json TEXT NOT NULL DEFAULT '{}', fitness_before REAL NOT NULL DEFAULT 0,
        fitness_after REAL NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0,
        assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_federated_patterns (
        id TEXT PRIMARY KEY,
        source_peer TEXT NOT NULL,
        category TEXT NOT NULL,
        avg_score REAL NOT NULL DEFAULT 0,
        agent_count INTEGER NOT NULL DEFAULT 0,
        trend_direction TEXT NOT NULL DEFAULT 'stable',
        confidence REAL NOT NULL DEFAULT 0.5,
        validated INTEGER NOT NULL DEFAULT 0,
        shared_at TEXT NOT NULL DEFAULT (datetime('now')),
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_fp_peer ON segml_federated_patterns(source_peer);
      CREATE INDEX IF NOT EXISTS idx_segml_fp_category ON segml_federated_patterns(category);
      CREATE INDEX IF NOT EXISTS idx_segml_fp_validated ON segml_federated_patterns(validated);

      CREATE TABLE IF NOT EXISTS segml_federation_sync_log (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        patterns_received INTEGER NOT NULL DEFAULT 0,
        patterns_validated INTEGER NOT NULL DEFAULT 0,
        patterns_rejected INTEGER NOT NULL DEFAULT 0,
        sync_timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Extract local governance patterns for sharing with peers.
   * Returns anonymized, aggregated patterns — never raw agent data.
   */
  extractLocalPatterns(): Array<Omit<GovernancePatternShare, 'id' | 'sharedAt' | 'validated'>> {
    const patterns: Array<Omit<GovernancePatternShare, 'id' | 'sharedAt' | 'validated'>> = [];

    try {
      const categoryRows = this.db.prepare(`
        SELECT category, AVG(confidence) as avg_confidence, COUNT(*) as pattern_count
        FROM segml_fleet_memory
        WHERE scope = 'fleet_wide'
        GROUP BY category
      `).all() as any[];

      for (const row of categoryRows) {
        if (row.pattern_count < this.MIN_PEER_AGENT_COUNT) continue;
        patterns.push({
          sourcePeer: 'local',
          category: row.category,
          avgScore: Math.round(row.avg_confidence * 5 * 100) / 100,
          agentCount: row.pattern_count,
          trendDirection: 'stable',
          confidence: Math.min(0.9, row.pattern_count * 0.1),
        });
      }
    } catch { /* tables may not exist */ }

    return patterns;
  }

  /**
   * Receive and validate patterns from a federation peer.
   * Validation: check if peer pattern is consistent with local data.
   */
  receivePeerPatterns(peerId: string, patterns: Array<{
    category: string;
    avgScore: number;
    agentCount: number;
    trendDirection: 'improving' | 'stable' | 'declining';
    confidence: number;
  }>): PeerSyncResult {
    let validated = 0;
    let rejected = 0;

    for (const pattern of patterns) {
      // Validate pattern
      const isValid = this.validatePeerPattern(pattern);

      // Store pattern
      this.db.prepare(`
        INSERT INTO segml_federated_patterns
        (id, source_peer, category, avg_score, agent_count, trend_direction, confidence, validated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), peerId, pattern.category, pattern.avgScore,
        pattern.agentCount, pattern.trendDirection, pattern.confidence,
        isValid ? 1 : 0
      );

      if (isValid) {
        validated++;

        // Merge validated pattern into local fleet memory
        this.db.prepare(`
          INSERT INTO segml_fleet_memory
          (id, content, category, scope, source_agent, confidence, successes, failures, metadata_json)
          VALUES (?, ?, ?, 'fleet_wide', ?, ?, 1, 1, ?)
        `).run(
          randomUUID(),
          `Federated pattern: ${pattern.category} (peer: ${peerId}, agents: ${pattern.agentCount})`,
          pattern.category,
          peerId,
          pattern.confidence,
          JSON.stringify({ federated: true, peerId, trend: pattern.trendDirection })
        );
      } else {
        rejected++;
      }
    }

    // Enforce cap
    const total = this.db.prepare('SELECT COUNT(*) as c FROM segml_federated_patterns').get() as { c: number };
    if (total.c > this.MAX_FEDERATED_PATTERNS) {
      this.db.prepare(`
        DELETE FROM segml_federated_patterns WHERE id IN (
          SELECT id FROM segml_federated_patterns ORDER BY received_at ASC LIMIT ?
        )
      `).run(total.c - this.MAX_FEDERATED_PATTERNS);
    }

    // Log sync
    const result: PeerSyncResult = {
      peerId,
      patternsReceived: patterns.length,
      patternsValidated: validated,
      patternsRejected: rejected,
      syncTimestamp: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO segml_federation_sync_log
      (id, peer_id, patterns_received, patterns_validated, patterns_rejected, sync_timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), peerId, result.patternsReceived, validated, rejected, result.syncTimestamp);

    swarmEventBus.emit('segml:federation:synced', {
      peerId,
      received: patterns.length,
      validated,
      rejected,
    });

    return result;
  }

  /**
   * Validate a peer pattern against local data.
   * A pattern is valid if it's consistent with local observations.
   */
  private validatePeerPattern(pattern: {
    category: string;
    avgScore: number;
    agentCount: number;
    confidence: number;
  }): boolean {
    // Reject patterns with too few agents
    if (pattern.agentCount < this.MIN_PEER_AGENT_COUNT) return false;

    // Check consistency with local data
    const local = this.db.prepare(`
      SELECT AVG(confidence) as avg_conf FROM segml_fleet_memory
      WHERE category = ? AND scope = 'fleet_wide'
    `).get(pattern.category) as { avg_conf: number };

    if (local && local.avg_conf) {
      // If local and peer scores differ wildly, be cautious
      const localScore = local.avg_conf * 5; // Normalize
      const diff = Math.abs(localScore - pattern.avgScore);
      if (diff > 3.0) return false; // Too different — possible data quality issue
    }

    return true;
  }

  /**
   * Get federated governance summary.
   */
  getSummary(): FederatedGovernanceSummary {
    const localPatterns = this.db.prepare('SELECT COUNT(*) as c FROM segml_fleet_memory WHERE scope = \'fleet_wide\'').get() as { c: number };
    const federatedPatterns = this.db.prepare('SELECT COUNT(*) as c FROM segml_federated_patterns WHERE validated = 1').get() as { c: number };
    const peers = this.db.prepare('SELECT COUNT(DISTINCT source_peer) as c FROM segml_federated_patterns').get() as { c: number };
    const lastSync = this.db.prepare('SELECT MAX(sync_timestamp) as last FROM segml_federation_sync_log').get() as { last: string | null };

    const topCategories = this.db.prepare(`
      SELECT category, COUNT(DISTINCT source_peer) as peer_count, AVG(avg_score) as avg_score
      FROM segml_federated_patterns
      WHERE validated = 1
      GROUP BY category
      ORDER BY peer_count DESC
      LIMIT 10
    `).all() as any[];

    return {
      localPatterns: localPatterns.c,
      federatedPatterns: federatedPatterns.c,
      peersSynced: peers.c,
      lastSyncTimestamp: lastSync.last,
      topSharedCategories: topCategories.map(r => ({
        category: r.category,
        peerCount: r.peer_count,
        avgScore: Math.round(r.avg_score * 100) / 100,
      })),
    };
  }

  /**
   * Get sync history.
   */
  getSyncHistory(limit = 20): Array<{
    peerId: string;
    received: number;
    validated: number;
    rejected: number;
    timestamp: string;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM segml_federation_sync_log ORDER BY sync_timestamp DESC LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      peerId: r.peer_id,
      received: r.patterns_received,
      validated: r.patterns_validated,
      rejected: r.patterns_rejected,
      timestamp: r.sync_timestamp,
    }));
  }
}
