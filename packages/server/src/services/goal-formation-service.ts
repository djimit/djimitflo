import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { CuriosityService } from './curiosity-service';
import type { SelfModelService } from './self-model-service';

export interface AutonomousGoal {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  riskClass: 'low' | 'medium';
  source: 'curiosity' | 'pattern' | 'self_improvement';
}

export class GoalFormationService {
  private maxAutonomousFraction = 0.5;

  constructor(
    private db: Database,
    private curiosity?: CuriosityService,
    private selfModel?: SelfModelService,
  ) {}

  async generateAutonomousGoals(): Promise<AutonomousGoal[]> {
    const currentActive = this.getActiveGoalCount();
    const maxConcurrent = this.getMaxConcurrent();
    const maxAutonomous = Math.floor(maxConcurrent * this.maxAutonomousFraction);

    if (currentActive >= maxAutonomous) return [];

    const goals: AutonomousGoal[] = [];
    const remaining = maxAutonomous - currentActive;

    if (this.curiosity) {
      const gapReport = await this.curiosity.scanForGaps();
      for (const gap of gapReport.gaps.slice(0, Math.min(2, remaining))) {
        goals.push({
          id: randomUUID(),
          objective: `Investigate: ${gap.description}`,
          acceptanceCriteria: [
            `>= 1 new finding in domain '${gap.domain}'`,
            `Finding has confidence > 0.5`,
          ],
          riskClass: 'low',
          source: 'curiosity',
        });
      }
    }

    if (this.selfModel && goals.length < remaining) {
      const unknowns = this.selfModel.getKnownUnknowns();
      if (unknowns.length > 0) {
        goals.push({
          id: randomUUID(),
          objective: `Improve competence in: ${unknowns[0].domain}`,
          acceptanceCriteria: [
            `Calibration error < 0.2 for '${unknowns[0].domain}'`,
            `>= 5 successful runs`,
          ],
          riskClass: 'low',
          source: 'self_improvement',
        });
      }
    }

    return goals;
  }

  injectGoals(goals: AutonomousGoal[]): void {
    for (const goal of goals) {
      try {
        this.db.prepare(`
          INSERT INTO goals (id, objective, status, risk_class, acceptance_criteria_json, budget_json, metadata, created_at, updated_at)
          VALUES (?, ?, 'created', ?, ?, '{}', ?, datetime('now'), datetime('now'))
        `).run(
          goal.id,
          goal.objective,
          goal.riskClass,
          JSON.stringify(goal.acceptanceCriteria),
          JSON.stringify({ autonomous: true, source: goal.source }),
        );
      } catch { /* skip duplicates */ }
    }
  }

  private getActiveGoalCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c FROM goals WHERE status IN ('created', 'decomposed', 'running')
    `).get() as { c: number };
    return row.c;
  }

  private getMaxConcurrent(): number {
    return Number(process.env.GOAL_MAX_CONCURRENT) || 5;
  }
}
