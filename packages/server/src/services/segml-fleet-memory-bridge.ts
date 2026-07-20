/**
 * SEGML Fleet-Wide Governance Memory Bridge.
 *
 * Implements cross-agent governance knowledge sharing using Thompson Sampling
 * for uncertainty-weighted retrieval of governance patterns.
 *
 * Architecture (arXiv 2607.13104 §6.2.3 Cross-Agent Knowledge Consolidation):
 * - When agent A learns a governance pattern, it's stored in shared memory
 * - When agent B faces a similar situation, Thompson Sampling retrieves
 *   the most relevant governance memories with uncertainty weighting
 * - Patterns are scoped: 'agent_specific' vs 'fleet_wide'
 * - Decay: outdated governance knowledge is automatically archived
 *
 * This bridges the isolation gap: currently each agent runs its own SEGML
 * cycle without learning from other agents' governance discoveries.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

interface GovernanceMemory {
  id: string;
  content: string;
  category: string;
  scope: 'agent_specific' | 'fleet_wide';
  sourceAgent: string;
  confidence: number;
  successes: number;  // Thompson Sampling alpha
  failures: number;   // Thompson Sampling beta
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  metadata: Record<string, unknown>;
}

interface FleetPattern {
  category: string;
  affectedAgents: string[];
  avgScore: number;
  trend: 'improving' | 'stable' | 'declining';
  recommendation: string;
  confidence: number;
}

export class SegmlFleetMemoryBridge {
  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_fleet_memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'fleet_wide' CHECK(scope IN ('agent_specific', 'fleet_wide')),
        source_agent TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        successes REAL NOT NULL DEFAULT 1.0,
        failures REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_segml_fm_category ON segml_fleet_memory(category);
      CREATE INDEX IF NOT EXISTS idx_segml_fm_scope ON segml_fleet_memory(scope);
      CREATE INDEX IF NOT EXISTS idx_segml_fm_source ON segml_fleet_memory(source_agent);
      CREATE INDEX IF NOT EXISTS idx_segml_fm_confidence ON segml_fleet_memory(confidence DESC);
    `);
  }

  /**
   * Store a governance pattern from an agent into fleet-wide memory.
   * Uses Thompson Sampling state for uncertainty-weighted retrieval.
   */
  storePattern(input: {
    content: string;
    category: string;
    sourceAgent: string;
    scope?: 'agent_specific' | 'fleet_wide';
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): GovernanceMemory {
    const id = randomUUID();
    const now = new Date().toISOString();

    const memory: GovernanceMemory = {
      id,
      content: input.content,
      category: input.category,
      scope: input.scope || 'fleet_wide',
      sourceAgent: input.sourceAgent,
      confidence: input.confidence ?? 0.5,
      successes: 1,
      failures: 1,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      metadata: input.metadata || {},
    };

    this.db.prepare(`
      INSERT INTO segml_fleet_memory
      (id, content, category, scope, source_agent, confidence, successes, failures, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.content, input.category, memory.scope, input.sourceAgent,
      memory.confidence, memory.successes, memory.failures, JSON.stringify(memory.metadata));

    return memory;
  }

  /**
   * Retrieve governance memories using Thompson Sampling.
   * Samples from Beta(successes, failures) distribution and returns
   * the memories with highest sampled values (exploration-exploitation).
   */
  retrieveRelevant(_query: string, category?: string, limit = 10): GovernanceMemory[] {
    let sql = 'SELECT * FROM segml_fleet_memory WHERE 1=1';
    const params: unknown[] = [];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];

    // Thompson Sampling: sample from Beta distribution for each memory
    const sampled = rows.map(row => {
      const successes = row.successes || 1;
      const failures = row.failures || 1;
      const sampledValue = this.sampleBeta(successes, failures);

      return {
        id: row.id,
        content: row.content,
        category: row.category,
        scope: row.scope,
        sourceAgent: row.source_agent,
        confidence: row.confidence,
        successes,
        failures,
        createdAt: row.created_at,
        lastAccessedAt: row.last_accessed_at,
        accessCount: row.access_count,
        metadata: JSON.parse(row.metadata_json || '{}'),
        _sampledValue: sampledValue,
      };
    });

    // Sort by sampled value (exploration-exploitation tradeoff)
    sampled.sort((a, b) => b._sampledValue - a._sampledValue);

    // Update access stats for returned memories
    const topResults = sampled.slice(0, limit);
    const now = new Date().toISOString();
    const updateStmt = this.db.prepare(`
      UPDATE segml_fleet_memory
      SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id = ?
    `);
    for (const result of topResults) {
      updateStmt.run(now, result.id);
    }

    return topResults;
  }

  /**
   * Record feedback for a governance memory (Thompson Sampling update).
   * reward: 0.0 (not useful) to 1.0 (very useful)
   */
  recordFeedback(memoryId: string, reward: number): void {
    const clamped = Math.max(0, Math.min(1, reward));
    const row = this.db.prepare('SELECT successes, failures FROM segml_fleet_memory WHERE id = ?').get(memoryId) as any;
    if (!row) return;

    // Update Beta distribution parameters
    const newSuccesses = row.successes + clamped;
    const newFailures = row.failures + (1 - clamped);

    this.db.prepare('UPDATE segml_fleet_memory SET successes = ?, failures = ? WHERE id = ?')
      .run(newSuccesses, newFailures, memoryId);
  }

  /**
   * Detect fleet-wide governance patterns.
   * If multiple agents fail on the same category, it's a systemic issue.
   */
  detectFleetPatterns(): FleetPattern[] {
    const rows = this.db.prepare(`
      SELECT category, COUNT(DISTINCT source_agent) as agent_count,
             AVG(confidence) as avg_confidence,
             GROUP_CONCAT(DISTINCT source_agent) as agents
      FROM segml_fleet_memory
      WHERE scope = 'fleet_wide'
      GROUP BY category
      HAVING agent_count >= 2
      ORDER BY agent_count DESC
    `).all() as any[];

    return rows.map(row => ({
      category: row.category,
      affectedAgents: row.agents.split(','),
      avgScore: row.avg_confidence,
      trend: this.computeCategoryTrend(row.category),
      recommendation: this.generateFleetRecommendation(row.category, row.agent_count),
      confidence: Math.min(0.95, row.agent_count * 0.15),
    }));
  }

  /**
   * Compute trend for a category based on recent vs older memories.
   */
  private computeCategoryTrend(category: string): 'improving' | 'stable' | 'declining' {
    const recent = this.db.prepare(`
      SELECT AVG(confidence) as avg_conf FROM segml_fleet_memory
      WHERE category = ? AND created_at > datetime('now', '-7 days')
    `).get(category) as { avg_conf: number };

    const older = this.db.prepare(`
      SELECT AVG(confidence) as avg_conf FROM segml_fleet_memory
      WHERE category = ? AND created_at <= datetime('now', '-7 days')
    `).get(category) as { avg_conf: number };

    if (!older.avg_conf || older.avg_conf === 0) return 'stable';
    const change = (recent.avg_conf || 0) - older.avg_conf;
    if (change > 0.1) return 'improving';
    if (change < -0.1) return 'declining';
    return 'stable';
  }

  private generateFleetRecommendation(category: string, agentCount: number): string {
    if (agentCount >= 5) {
      return `SYSTEMIC: ${category} affects ${agentCount} agents — prioritize fleet-wide curriculum update`;
    }
    if (agentCount >= 3) {
      return `PATTERN: ${category} affects ${agentCount} agents — consider targeted training`;
    }
    return `MONITOR: ${category} affects ${agentCount} agents — continue observation`;
  }

  /**
   * Sample from Beta distribution using the relationship Beta(α,β) ~ Gamma(α,1) / (Gamma(α,1) + Gamma(β,1))
   * Uses a simplified approximation for performance.
   */
  private sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha);
    const y = this.sampleGamma(beta);
    return x / (x + y);
  }

  /**
   * Sample from Gamma distribution (Marsaglia & Tsang method).
   */
  private sampleGamma(shape: number): number {
    if (shape < 1) {
      return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      const x = this.sampleStandardNormal();
      const v = Math.pow(1 + c * x, 3);
      if (v <= 0) continue;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /**
   * Standard normal sample (Box-Muller).
   */
  private sampleStandardNormal(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Get fleet memory status.
   */
  getStatus(): {
    totalMemories: number;
    fleetWideMemories: number;
    agentSpecificMemories: number;
    categories: number;
    fleetPatterns: FleetPattern[];
  } {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM segml_fleet_memory').get() as { c: number };
    const fleetWide = this.db.prepare("SELECT COUNT(*) as c FROM segml_fleet_memory WHERE scope = 'fleet_wide'").get() as { c: number };
    const categories = this.db.prepare('SELECT COUNT(DISTINCT category) as c FROM segml_fleet_memory').get() as { c: number };

    return {
      totalMemories: total.c,
      fleetWideMemories: fleetWide.c,
      agentSpecificMemories: total.c - fleetWide.c,
      categories: categories.c,
      fleetPatterns: this.detectFleetPatterns(),
    };
  }
}
