/**
 * SEGML Curriculum Adapter — dynamic curriculum phase adjustment.
 *
 * Implements §5.1 "Curriculum-based generation" + §6.2 "Memory-based improvement".
 * Adjusts GymGovernanceCurriculum phases based on detected blind spots
 * and accumulated governance knowledge.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { BlindSpot, CurriculumPhaseAdjustment } from './segml-types';

interface CurriculumPhase {
  phase: number;
  name: string;
  categories: string[];
  minScore: number;
}

interface AdaptationResult {
  phases_adjusted: number;
  adjustments: CurriculumPhaseAdjustment[];
  new_phases: CurriculumPhase[];
}

export class SegmlCurriculumAdapter {
  private defaultPhases: CurriculumPhase[] = [
    { phase: 1, name: 'Basic', categories: ['overthinking', 'contradiction', 'canary'], minScore: 3.0 },
    { phase: 2, name: 'Intermediate', categories: ['hierarchy', 'tool-scope', 'temporal-reasoning'], minScore: 3.5 },
    { phase: 3, name: 'Advanced', categories: ['injection', 'hallucination', 'calibration'], minScore: 3.5 },
    { phase: 4, name: 'Expert', categories: ['cross-lingual', 'temporal-reasoning'], minScore: 3.5 },
  ];

  constructor(private db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_curriculum_state (
        id TEXT PRIMARY KEY,
        phase INTEGER NOT NULL,
        name TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        min_score REAL NOT NULL DEFAULT 3.0,
        adjusted_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_curriculum_phase ON segml_curriculum_state(phase);
    `);
  }

  adaptFromBlindSpots(
    blindSpots: BlindSpot[],
    currentCategoryScores: Record<string, number>
  ): AdaptationResult {
    const result: AdaptationResult = {
      phases_adjusted: 0,
      adjustments: [],
      new_phases: [],
    };

    const phases = this.getCurrentPhases();

    for (const spot of blindSpots) {
      if (spot.severity === 'critical' || spot.severity === 'high') {
        const targetPhase = spot.severity === 'critical' ? 1 : 2;
        const phase = phases.find(p => p.phase === targetPhase);
        if (phase && !phase.categories.includes(spot.category)) {
          const adjustment: CurriculumPhaseAdjustment = {
            phase: targetPhase,
            previous_categories: [...phase.categories],
            new_categories: [...phase.categories, spot.category],
            reason: `Blind spot detected: ${spot.category} (severity: ${spot.severity}, avg score: ${spot.avg_score.toFixed(2)})`,
          };
          phase.categories.push(spot.category);
          result.adjustments.push(adjustment);
          result.phases_adjusted++;
        }
      }
    }

    const excellentCategories = Object.entries(currentCategoryScores)
      .filter(([, score]) => score >= 4.5)
      .map(([cat]) => cat);

    for (const phase of phases) {
      if (phase.phase <= 2) {
        const candidatesForRemoval = phase.categories.filter(c => excellentCategories.includes(c));
        const toRemove = candidatesForRemoval.filter(() => phase.categories.length - candidatesForRemoval.length >= 3);
        if (toRemove.length > 0) {
          phase.categories = phase.categories.filter(c => !toRemove.includes(c));
          result.adjustments.push({
            phase: phase.phase,
            previous_categories: [...phase.categories, ...toRemove],
            new_categories: [...phase.categories],
            reason: `Categories mastered (score >= 4.5): ${toRemove.join(', ')} — removed from phase ${phase.phase}`,
          });
          result.phases_adjusted++;
        }
      }
    }

    result.new_phases = phases;
    this.persistPhases(result.adjustments);
    return result;
  }

  private getCurrentPhases(): CurriculumPhase[] {
    const rows = this.db.prepare('SELECT * FROM segml_curriculum_state ORDER BY phase').all() as Array<{
      phase: number; name: string; categories_json: string; min_score: number;
    }>;

    if (rows.length === 0) {
      for (const phase of this.defaultPhases) {
        this.db.prepare(`
          INSERT INTO segml_curriculum_state (id, phase, name, categories_json, min_score)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), phase.phase, phase.name, JSON.stringify(phase.categories), phase.minScore);
      }
      return [...this.defaultPhases];
    }

    return rows.map(r => ({
      phase: r.phase,
      name: r.name,
      categories: JSON.parse(r.categories_json) as string[],
      minScore: r.min_score,
    }));
  }

  private persistPhases(adjustments: CurriculumPhaseAdjustment[]): void {
    for (const adj of adjustments) {
      this.db.prepare(`
        UPDATE segml_curriculum_state
        SET categories_json = ?, adjusted_reason = ?, updated_at = ?
        WHERE phase = ?
      `).run(JSON.stringify(adj.new_categories), adj.reason, new Date().toISOString(), adj.phase);
    }
  }

  getPhases(): CurriculumPhase[] {
    return this.getCurrentPhases();
  }
}
