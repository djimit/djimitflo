/**
 * SEGML ↔ SkillEvolutionEngine Bridge.
 *
 * Integrates governance scores into the skill evolution fitness function
 * and enables governance-aware skill promotion/quarantine.
 *
 * Problem: SkillEvolutionEngine's fitness function considers only
 * efficiency, reliability, generality, complexity, adaptability.
 * A skill that is efficient but fails governance gets high fitness.
 *
 * Solution: Governance score becomes a fitness dimension.
 * - Skills with governance score < 2.0 are auto-quarantined
 * - Skills with governance score > 4.0 get fitness bonus
 * - Governance-weighted fitness prevents "efficient but dangerous" skills
 *
 * This implements §6.3 "Tool Governance Metacognition" from
 * arXiv 2607.13104 — tools (skills) that self-evaluate their governance.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';

interface GovernanceFitnessInput {
  skillId: string;
  baseTraits: {
    efficiency: number;
    reliability: number;
    generality: number;
    complexity: number;
    adaptability: number;
  };
  governanceScore: number;
  categoryScores: Record<string, number>;
}

interface GovernanceFitnessResult {
  skillId: string;
  baseFitness: number;
  governanceWeightedFitness: number;
  governancePenalty: number;
  governanceBonus: number;
  quarantined: boolean;
  promotionApproved: boolean;
  details: string;
}

interface SkillGovernanceRecord {
  skillId: string;
  overallScore: number;
  categoryScores: Record<string, number>;
  fitnessBefore: number;
  fitnessAfter: number;
  quarantined: boolean;
  assessedAt: string;
}

export class SegmlSkillEvolutionBridge {
  private readonly GOVERNANCE_WEIGHT = 0.25;
  private readonly QUARANTINE_THRESHOLD = 2.0;
  private readonly PROMOTION_THRESHOLD = 4.0;

  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_skill_governance (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        overall_score REAL NOT NULL DEFAULT 0,
        category_scores_json TEXT NOT NULL DEFAULT '{}',
        fitness_before REAL NOT NULL DEFAULT 0,
        fitness_after REAL NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0,
        assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_sg_skill ON segml_skill_governance(skill_id);
      CREATE INDEX IF NOT EXISTS idx_segml_sg_quarantined ON segml_skill_governance(quarantined);
      CREATE INDEX IF NOT EXISTS idx_segml_sg_score ON segml_skill_governance(overall_score);
    `);
  }

  /**
   * Calculate governance-weighted fitness for a skill.
   * Replaces the naive fitness function with governance-aware scoring.
   *
   * New fitness = (1 - wg) * baseFitness + wg * governanceComponent
   * where governanceComponent includes penalty/bonus logic.
   */
  calculateGovernanceFitness(input: GovernanceFitnessInput): GovernanceFitnessResult {
    const baseFitness = (
      input.baseTraits.efficiency * 0.3 +
      input.baseTraits.reliability * 0.3 +
      input.baseTraits.generality * 0.15 +
      (1 - input.baseTraits.complexity) * 0.15 +
      input.baseTraits.adaptability * 0.1
    );

    // Governance component: normalize score from [0,5] to [0,1]
    const normalizedGovScore = input.governanceScore / 5.0;

    // Penalty for low governance scores (steep drop below threshold)
    let governancePenalty = 0;
    let governanceBonus = 0;
    let quarantined = false;
    let promotionApproved = false;

    if (input.governanceScore < this.QUARANTINE_THRESHOLD) {
      // Severe penalty: exponential decay below threshold
      const severity = (this.QUARANTINE_THRESHOLD - input.governanceScore) / this.QUARANTINE_THRESHOLD;
      governancePenalty = severity * 0.5; // Up to 50% fitness reduction
      quarantined = true;
    } else if (input.governanceScore >= this.PROMOTION_THRESHOLD) {
      // Bonus for excellent governance
      const excellence = (input.governanceScore - this.PROMOTION_THRESHOLD) / (5.0 - this.PROMOTION_THRESHOLD);
      governanceBonus = excellence * 0.15; // Up to 15% fitness bonus
      promotionApproved = true;
    }

    // Weighted fitness combination
    const governanceComponent = normalizedGovScore - governancePenalty + governanceBonus;
    const governanceWeightedFitness =
      (1 - this.GOVERNANCE_WEIGHT) * baseFitness +
      this.GOVERNANCE_WEIGHT * Math.max(0, Math.min(1, governanceComponent));

    const details = quarantined
      ? `QUARANTINED: Governance score ${input.governanceScore.toFixed(2)} < ${this.QUARANTINE_THRESHOLD} (penalty: -${(governancePenalty * 100).toFixed(0)}%)`
      : promotionApproved
      ? `PROMOTED: Governance score ${input.governanceScore.toFixed(2)} >= ${this.PROMOTION_THRESHOLD} (bonus: +${(governanceBonus * 100).toFixed(0)}%)`
      : `STANDARD: Governance score ${input.governanceScore.toFixed(2)} (weight: ${(this.GOVERNANCE_WEIGHT * 100).toFixed(0)}%)`;

    return {
      skillId: input.skillId,
      baseFitness,
      governanceWeightedFitness,
      governancePenalty,
      governanceBonus,
      quarantined,
      promotionApproved,
      details,
    };
  }

  /**
   * Record governance assessment for a skill.
   */
  recordAssessment(record: SkillGovernanceRecord): void {
    this.db.prepare(`
      INSERT INTO segml_skill_governance
      (id, skill_id, overall_score, category_scores_json, fitness_before, fitness_after, quarantined, assessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), record.skillId, record.overallScore,
      JSON.stringify(record.categoryScores), record.fitnessBefore,
      record.fitnessAfter, record.quarantined ? 1 : 0, record.assessedAt
    );

    if (record.quarantined) {
      swarmEventBus.emit('segml:skill:quarantined', {
        skillId: record.skillId,
        score: record.overallScore,
        reason: 'Governance score below quarantine threshold',
      });
    }
  }

  /**
   * Get quarantined skills.
   */
  getQuarantinedSkills(): SkillGovernanceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM segml_skill_governance WHERE quarantined = 1 ORDER BY assessed_at DESC
    `).all() as any[];

    return rows.map(r => ({
      skillId: r.skill_id,
      overallScore: r.overall_score,
      categoryScores: JSON.parse(r.category_scores_json || '{}'),
      fitnessBefore: r.fitness_before,
      fitnessAfter: r.fitness_after,
      quarantined: true,
      assessedAt: r.assessed_at,
    }));
  }

  /**
   * Get governance fitness history for a skill.
   */
  getSkillHistory(skillId: string, limit = 20): SkillGovernanceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM segml_skill_governance WHERE skill_id = ? ORDER BY assessed_at DESC LIMIT ?
    `).all(skillId, limit) as any[];

    return rows.map(r => ({
      skillId: r.skill_id,
      overallScore: r.overall_score,
      categoryScores: JSON.parse(r.category_scores_json || '{}'),
      fitnessBefore: r.fitness_before,
      fitnessAfter: r.fitness_after,
      quarantined: r.quarantined === 1,
      assessedAt: r.assessed_at,
    }));
  }

  /**
   * Get bridge status.
   */
  getStatus(): {
    totalAssessed: number;
    quarantined: number;
    promoted: number;
    avgGovernanceScore: number;
  } {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM segml_skill_governance').get() as { c: number };
    const quarantined = this.db.prepare('SELECT COUNT(*) as c FROM segml_skill_governance WHERE quarantined = 1').get() as { c: number };
    const promoted = this.db.prepare('SELECT COUNT(*) as c FROM segml_skill_governance WHERE overall_score >= ?').get(this.PROMOTION_THRESHOLD) as { c: number };
    const avgScore = this.db.prepare('SELECT AVG(overall_score) as avg FROM segml_skill_governance').get() as { avg: number };

    return {
      totalAssessed: total.c,
      quarantined: quarantined.c,
      promoted: promoted.c,
      avgGovernanceScore: avgScore.avg || 0,
    };
  }
}
