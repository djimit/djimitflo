/**
 * SEGML ↔ AdversarialRedTeamService Bridge.
 *
 * Integrates red team adversarial findings into SEGML's case generation
 * pipeline and feeds SEGML blind spots back as red team campaign targets.
 *
 * Direction 1: Red team findings → SEGML seed cases
 *   Missed attacks become high-priority seed cases for SEGML's CaseGenerator.
 *   These are real-world adversarial patterns, not synthetic mutations.
 *
 * Direction 2: SEGML blind spots → Red team campaign targets
 *   When SEGML detects a blind spot, the red team launches targeted campaigns.
 *
 * Direction 3: Co-evolution
 *   Red team evolves attacks → SEGML detects → curriculum adapts → agent improves
 *   → red team evolves harder attacks → repeat.
 *
 * This implements the "adversarial co-improvement loop" from
 * arXiv 2705.12989 (Self-Improving Jailbreak Resistance).
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';
import type { GeneratedCase } from './segml-types';

interface RedTeamSeed {
  id: string;
  attackCategory: string;
  payload: string;
  expectedDefense: string;
  missedBy: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  converted: boolean;
  createdAt: string;
}

interface CampaignTarget {
  agentId: string;
  category: string;
  priority: number;
  source: 'segml_blind_spot' | 'fleet_pattern' | 'compliance_gap';
}

export class SegmlRedTeamBridge {
  private seeds: RedTeamSeed[] = [];

  constructor(private db: Database) {
    this.ensureTables();
    this.subscribeToEvents();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_red_team_seeds (
        id TEXT PRIMARY KEY,
        attack_category TEXT NOT NULL,
        payload TEXT NOT NULL,
        expected_defense TEXT NOT NULL,
        missed_by TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        converted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_rts_converted ON segml_red_team_seeds(converted);
      CREATE INDEX IF NOT EXISTS idx_segml_rts_category ON segml_red_team_seeds(attack_category);

      CREATE TABLE IF NOT EXISTS segml_campaign_targets (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 5,
        source TEXT NOT NULL DEFAULT 'segml_blind_spot',
        launched INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_ct_launched ON segml_campaign_targets(launched);
    `);
  }

  private subscribeToEvents(): void {
    // When SEGML completes a cycle with blind spots, trigger red team campaign
    swarmEventBus.subscribe((event) => {
      if (event.type === 'segml:cycle:complete' && event.data) {
        const data = event.data as { agentId?: string; blindSpots?: string[] };
        if (data.agentId && data.blindSpots && data.blindSpots.length > 0) {
          this.queueCampaignTargets(data.agentId, data.blindSpots);
        }
      }
    });
  }

  /**
   * Convert red team findings into SEGML seed cases.
   * Missed attacks become high-quality training cases.
   */
  convertRedTeamFindings(findings: Array<{
    vectorId: string;
    category: string;
    payload: string;
    expectedDefense: string;
    blocked: boolean;
    severity: 'low' | 'medium' | 'high' | 'critical';
    recommendation: string;
  }>): GeneratedCase[] {
    const seeds: RedTeamSeed[] = [];
    const generated: GeneratedCase[] = [];

    for (const finding of findings) {
      // Only convert missed attacks (these are the real gaps)
      if (finding.blocked) continue;

      const seed: RedTeamSeed = {
        id: randomUUID(),
        attackCategory: finding.category,
        payload: finding.payload,
        expectedDefense: finding.expectedDefense,
        missedBy: finding.vectorId,
        severity: finding.severity,
        converted: false,
        createdAt: new Date().toISOString(),
      };
      seeds.push(seed);

      // Convert to SEGML GeneratedCase format
      generated.push({
        id: `segml-rts-${randomUUID().slice(0, 8)}`,
        parent_case_id: finding.vectorId,
        category: finding.category,
        subcategory: 'red_team_seed',
        difficulty: finding.severity === 'critical' ? 5 : finding.severity === 'high' ? 4 : 3,
        prompt: finding.payload,
        expected_behavior: finding.expectedDefense,
        failure_mode: `Red team bypass: ${finding.recommendation}`,
        rationale: `Converted from red team finding ${finding.vectorId} — missed attack in category ${finding.category}`,
        generation_method: 'adversarial',
      });
    }

    // Persist seeds
    const stmt = this.db.prepare(`
      INSERT INTO segml_red_team_seeds (id, attack_category, payload, expected_defense, missed_by, severity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const seed of seeds) {
      stmt.run(seed.id, seed.attackCategory, seed.payload, seed.expectedDefense, seed.missedBy, seed.severity);
    }

    this.seeds.push(...seeds);
    return generated;
  }

  /**
   * Queue red team campaign targets based on SEGML blind spots.
   */
  private queueCampaignTargets(agentId: string, blindSpots: string[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO segml_campaign_targets (id, agent_id, category, priority, source)
      VALUES (?, ?, ?, ?, 'segml_blind_spot')
    `);

    for (const category of blindSpots) {
      // Priority based on how many agents are affected
      const affectedCount = this.db.prepare(`
        SELECT COUNT(DISTINCT agent_id) as c FROM segml_campaign_targets WHERE category = ?
      `).get(category) as { c: number };

      const priority = Math.max(1, 10 - affectedCount.c);
      stmt.run(randomUUID(), agentId, category, priority, 'segml_blind_spot');
    }

    swarmEventBus.emit('segml:red_team:campaign_queued', {
      agentId,
      categories: blindSpots,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get unconverted red team seeds for SEGML processing.
   */
  getUnconvertedSeeds(limit = 20): RedTeamSeed[] {
    const rows = this.db.prepare(`
      SELECT * FROM segml_red_team_seeds WHERE converted = 0 ORDER BY created_at ASC LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      id: r.id,
      attackCategory: r.attack_category,
      payload: r.payload,
      expectedDefense: r.expected_defense,
      missedBy: r.missed_by,
      severity: r.severity as 'low' | 'medium' | 'high' | 'critical',
      converted: false,
      createdAt: r.created_at,
    }));
  }

  /**
   * Mark seeds as converted (used by SEGML).
   */
  markConverted(seedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE segml_red_team_seeds SET converted = 1 WHERE id = ?');
    for (const id of seedIds) {
      stmt.run(id);
    }
  }

  /**
   * Get pending campaign targets for red team execution.
   */
  getPendingCampaigns(limit = 10): CampaignTarget[] {
    const rows = this.db.prepare(`
      SELECT * FROM segml_campaign_targets WHERE launched = 0 ORDER BY priority ASC LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      agentId: r.agent_id,
      category: r.category,
      priority: r.priority,
      source: r.source as 'segml_blind_spot' | 'fleet_pattern' | 'compliance_gap',
    }));
  }

  /**
   * Get bridge status.
   */
  getStatus(): {
    totalSeeds: number;
    unconvertedSeeds: number;
    pendingCampaigns: number;
    recentSeeds: RedTeamSeed[];
  } {
    const unconverted = this.db.prepare('SELECT COUNT(*) as c FROM segml_red_team_seeds WHERE converted = 0').get() as { c: number };
    const pending = this.db.prepare('SELECT COUNT(*) as c FROM segml_campaign_targets WHERE launched = 0').get() as { c: number };

    return {
      totalSeeds: this.seeds.length,
      unconvertedSeeds: unconverted.c,
      pendingCampaigns: pending.c,
      recentSeeds: this.seeds.slice(-5),
    };
  }
}
