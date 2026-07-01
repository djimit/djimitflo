import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { SelfModelService } from './self-model-service';
import type { GoalFormationService } from './goal-formation-service';

export interface LearningGoal {
  id: string;
  domain: string;
  objective: string;
  acceptanceCriteria: string[];
  estimatedImpact: number;
  estimatedEffort: number;
  roi: number;
  status: 'proposed' | 'approved' | 'in_progress' | 'completed' | 'failed';
  createdAt: string;
}

interface LearningGoalRow {
  id: string;
  domain: string;
  objective: string;
  acceptance_criteria_json: string;
  estimated_impact: number;
  estimated_effort: number;
  roi: number;
  status: string;
  created_at: string;
}

export class MetacognitivePlanner {
  constructor(
    private db: Database,
    private selfModel: SelfModelService,
    _goalFormation: GoalFormationService,
  ) {
    void _goalFormation;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_goals (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        objective TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        estimated_impact REAL NOT NULL DEFAULT 0.5,
        estimated_effort REAL NOT NULL DEFAULT 1.0,
        roi REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_lg_status ON learning_goals(status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_lg_domain ON learning_goals(domain)');
  }

  generateLearningCurriculum(): LearningGoal[] {
    const unknowns = this.selfModel.getKnownUnknowns();
    const goals: LearningGoal[] = [];

    for (const unknown of unknowns) {
      const impact = this.estimateImpact(unknown);
      const effort = this.estimateEffort(unknown);
      const roi = effort > 0 ? impact / effort : 0;

      goals.push({
        id: randomUUID(),
        domain: unknown.domain,
        objective: `Improve competence in: ${unknown.domain} (${unknown.reason})`,
        acceptanceCriteria: [
          `Calibration error < 0.2 for '${unknown.domain}'`,
          `>= 5 successful runs for '${unknown.domain}'`,
          `Trend is 'improving' or 'stable'`,
        ],
        estimatedImpact: impact,
        estimatedEffort: effort,
        roi,
        status: 'proposed',
        createdAt: new Date().toISOString(),
      });
    }

    goals.sort((a, b) => b.roi - a.roi);
    const topGoals = goals.slice(0, 3);

    for (const goal of topGoals) {
      this.db.prepare(`
        INSERT OR IGNORE INTO learning_goals (id, domain, objective, acceptance_criteria_json, estimated_impact, estimated_effort, roi, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')
      `).run(goal.id, goal.domain, goal.objective, JSON.stringify(goal.acceptanceCriteria), goal.estimatedImpact, goal.estimatedEffort, goal.roi);
    }

    return topGoals;
  }

  estimateImpact(unknown: { domain: string; reason: string }): number {
    if (unknown.reason.includes('insufficient_data')) return 0.8;
    if (unknown.reason.includes('high_calibration_error')) return 0.6;
    if (unknown.reason.includes('contradiction')) return 0.7;
    if (unknown.reason.includes('competence')) return 0.9;
    return 0.5;
  }

  estimateEffort(unknown: { domain: string; reason: string }): number {
    if (unknown.reason.includes('insufficient_data')) return 0.3;
    if (unknown.reason.includes('high_calibration_error')) return 0.7;
    if (unknown.reason.includes('contradiction')) return 0.8;
    if (unknown.reason.includes('competence')) return 0.6;
    return 0.5;
  }

  recordLearningOutcome(goalId: string, outcome: 'success' | 'failure'): void {
    this.db.prepare(
      "UPDATE learning_goals SET status = ? WHERE id = ?"
    ).run(outcome === 'success' ? 'completed' : 'failed', goalId);
  }

  adjustStrategy(goalId: string, outcome: 'success' | 'failure'): void {
    const goal = this.db.prepare('SELECT domain, estimated_impact, estimated_effort FROM learning_goals WHERE id = ?').get(goalId) as { domain: string; estimated_impact: number; estimated_effort: number } | undefined;
    if (!goal) return;

    const adjustment = outcome === 'success' ? 0.9 : 1.2;
    const newEffort = Math.min(2.0, goal.estimated_effort * adjustment);

    this.db.prepare(
      'UPDATE learning_goals SET estimated_effort = ? WHERE domain = ? AND status = ?'
    ).run(newEffort, goal.domain, 'proposed');
  }

  getActiveLearningGoals(): LearningGoal[] {
    const rows = this.db.prepare(
      "SELECT * FROM learning_goals WHERE status IN ('proposed', 'in_progress') ORDER BY roi DESC"
    ).all() as LearningGoalRow[];
    return rows.map(this.rowToGoal);
  }

  getCompletedGoals(limit: number = 10): LearningGoal[] {
    const rows = this.db.prepare(
      "SELECT * FROM learning_goals WHERE status IN ('completed', 'failed') ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as LearningGoalRow[];
    return rows.map(this.rowToGoal);
  }

  approveGoal(goalId: string): void {
    this.db.prepare(
      "UPDATE learning_goals SET status = 'approved' WHERE id = ?"
    ).run(goalId);
  }

  startGoal(goalId: string): void {
    this.db.prepare(
      "UPDATE learning_goals SET status = 'in_progress' WHERE id = ?"
    ).run(goalId);
  }

  private rowToGoal(row: LearningGoalRow): LearningGoal {
    return {
      id: row.id,
      domain: row.domain,
      objective: row.objective,
      acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
      estimatedImpact: row.estimated_impact,
      estimatedEffort: row.estimated_effort,
      roi: row.roi,
      status: row.status as LearningGoal['status'],
      createdAt: row.created_at,
    };
  }
}
