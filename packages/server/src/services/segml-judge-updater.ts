/**
 * SEGML Judge Rubric Updater — self-learning judge from feedback patterns.
 *
 * Implements §5.2 "Intrinsic Evaluative Feedback" + §6.3 "Iterative Tool Refinement".
 * The judge analyzes its own scoring patterns and adjusts rubric weights
 * based on accumulated evidence from governance failures.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { JudgeRubricUpdate } from './segml-types';

interface CategoryScore {
  category: string;
  avgScore: number;
  caseCount: number;
  trend: 'improving' | 'stable' | 'declining';
}

interface RubricWeight {
  category: string;
  weight: number;
  evidence_count: number;
  last_updated: string;
}

interface UpdateResult {
  rubrics_updated: number;
  updates: JudgeRubricUpdate[];
  rollback_performed: boolean;
}

export class SegmlJudgeUpdater {
  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_judge_rubrics (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL UNIQUE,
        weight REAL NOT NULL DEFAULT 1.0,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_judge_rubrics_category ON segml_judge_rubrics(category);
    `);
  }

  updateRubricsFromPatterns(
    categoryScores: CategoryScore[],
    minEvidence: number
  ): UpdateResult {
    const result: UpdateResult = {
      rubrics_updated: 0,
      updates: [],
      rollback_performed: false,
    };

    for (const cs of categoryScores) {
      if (cs.caseCount < minEvidence) continue;

      const existing = this.getRubric(cs.category);
      const currentWeight = existing?.weight ?? 1.0;

      let newWeight = currentWeight;
      if (cs.avgScore < 2.0 && cs.trend === 'declining') {
        newWeight = Math.min(2.0, currentWeight * 1.2);
      } else if (cs.avgScore < 2.5 && cs.trend === 'stable') {
        newWeight = Math.min(1.8, currentWeight * 1.1);
      } else if (cs.avgScore > 4.0 && cs.trend === 'improving') {
        newWeight = Math.max(0.7, currentWeight * 0.95);
      }

      if (Math.abs(newWeight - currentWeight) > 0.01) {
        const update: JudgeRubricUpdate = {
          category: cs.category,
          previous_weight: currentWeight,
          new_weight: Math.round(newWeight * 1000) / 1000,
          rationale: this.generateRationale(cs, currentWeight, newWeight),
          evidence_count: cs.caseCount,
        };

        this.upsertRubric(cs.category, update.new_weight, cs.caseCount);
        result.updates.push(update);
        result.rubrics_updated++;
      }
    }

    return result;
  }

  private generateRationale(cs: CategoryScore, oldWeight: number, newWeight: number): string {
    const direction = newWeight > oldWeight ? 'increased' : 'decreased';
    return `Weight ${direction} from ${oldWeight.toFixed(3)} to ${newWeight.toFixed(3)} for category "${cs.category}" — avg score ${cs.avgScore.toFixed(2)} over ${cs.caseCount} cases, trend: ${cs.trend}`;
  }

  private getRubric(category: string): RubricWeight | null {
    const row = this.db.prepare('SELECT * FROM segml_judge_rubrics WHERE category = ?').get(category) as any;
    if (!row) return null;
    return {
      category: row.category,
      weight: row.weight,
      evidence_count: row.evidence_count,
      last_updated: row.last_updated,
    };
  }

  private upsertRubric(category: string, weight: number, evidenceCount: number): void {
    const existing = this.getRubric(category);
    if (existing) {
      this.db.prepare(`
        UPDATE segml_judge_rubrics
        SET weight = ?, evidence_count = ?, last_updated = ?
        WHERE category = ?
      `).run(weight, evidenceCount, new Date().toISOString(), category);
    } else {
      this.db.prepare(`
        INSERT INTO segml_judge_rubrics (id, category, weight, evidence_count)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), category, weight, evidenceCount);
    }
  }

  getRubricWeights(): Record<string, number> {
    const rows = this.db.prepare('SELECT category, weight FROM segml_judge_rubrics').all() as Array<{ category: string; weight: number }>;
    return rows.reduce((acc, row) => {
      acc[row.category] = row.weight;
      return acc;
    }, {} as Record<string, number>);
  }

  applyToScore(category: string, baseScore: number): number {
    const rubric = this.getRubric(category);
    if (!rubric) return baseScore;
    return Math.min(5, Math.max(0, baseScore * rubric.weight));
  }
}
