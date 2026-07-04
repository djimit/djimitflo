/**
 * GovernanceImprovementService — auto-creates improvement goals on governance failure.
 *
 * Subscribes to SwarmEventBus governance:guard:blocked and governance:improvement:triggered
 * events, creates LoopService goals for weak categories, and triggers re-evaluation.
 *
 * Wave 3: Closed RSI loop with governance verification.
 */

import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';

interface WeakCategory {
  category: string;
  score: number;
}

interface ImprovementGoal {
  skillId: string;
  weakCategories: WeakCategory[];
  attempt: number;
  maxAttempts: number;
}

const MAX_IMPROVEMENT_ATTEMPTS = 3;

export class GovernanceImprovementService {
  private improvementGoals: Map<string, ImprovementGoal> = new Map();

  constructor(private db: Database) {
    this.subscribeToEvents();
  }

  /**
   * Subscribe to governance events for auto-improvement.
   */
  private subscribeToEvents(): void {
    swarmEventBus.subscribe((event) => {
      if (event.type === 'governance:improvement:triggered') {
        this.handleImprovementTriggered(event.data as {
          skillId: string;
          weakCategories: string[];
          overallScore: number;
        });
      }

      if (event.type === 'eval:run:complete') {
        this.handleEvalComplete(event.data as {
          agentId: string;
          overallScore: number;
          categoryScores: Record<string, number>;
        });
      }
    });
  }

  /**
   * Handle improvement triggered event.
   * Creates a LoopService goal for the weak categories.
   */
  private handleImprovementTriggered(data: {
    skillId: string;
    weakCategories: string[];
    overallScore: number;
  }): void {
    if (process.env.GOVERNANCE_AUTO_IMPROVEMENT_ENABLED === 'false') {
      return;
    }

    const existing = this.improvementGoals.get(data.skillId);
    const attempt = (existing?.attempt ?? 0) + 1;

    if (attempt > MAX_IMPROVEMENT_ATTEMPTS) {
      console.log(`[GovernanceImprovement] Max attempts reached for ${data.skillId}, escalating to human`);
      this.escalateToHuman(data.skillId, data.weakCategories, attempt);
      return;
    }

    const weakCategories: WeakCategory[] = data.weakCategories.map(cat => ({
      category: cat,
      score: 0,
    }));

    this.improvementGoals.set(data.skillId, {
      skillId: data.skillId,
      weakCategories,
      attempt,
      maxAttempts: MAX_IMPROVEMENT_ATTEMPTS,
    });

    const goalId = `gov-improve-${data.skillId}-${attempt}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO goals (id, description, status, priority, metadata, created_at)
      VALUES (?, ?, 'pending', 'high', ?, ?)
    `).run(
      goalId,
      `Governance improvement for ${data.skillId}: strengthen ${data.weakCategories.join(", ")} (attempt ${attempt}/${MAX_IMPROVEMENT_ATTEMPTS})`,
      JSON.stringify({
        type: 'governance_improvement',
        skillId: data.skillId,
        weakCategories: data.weakCategories,
        attempt,
        source: 'governance_improvement_service',
      }),
      new Date().toISOString(),
    );

    console.log(`[GovernanceImprovement] Created goal ${goalId} for ${data.skillId} (attempt ${attempt})`);
  }

  /**
   * Handle eval run completion.
   * Checks if an improvement goal exists and if the score improved.
   */
  private handleEvalComplete(data: {
    agentId: string;
    overallScore: number;
    categoryScores: Record<string, number>;
  }): void {
    const goal = this.improvementGoals.get(data.agentId);
    if (!goal) return;

    const allPassed = goal.weakCategories.every(
      wc => (data.categoryScores[wc.category] ?? 0) >= 3.5
    );

    if (allPassed) {
      console.log(`[GovernanceImprovement] ${data.agentId} improved — clearing improvement goal`);
      this.improvementGoals.delete(data.agentId);
    } else if (goal.attempt >= goal.maxAttempts) {
      this.escalateToHuman(
        data.agentId,
        goal.weakCategories.map(w => w.category),
        goal.attempt
      );
    }
  }

  /**
   * Escalate to human review after max attempts.
   */
  private escalateToHuman(skillId: string, weakCategories: string[], attempt: number): void {
    const escalateId = `escalate-${skillId}-${Date.now()}`;
    this.db.prepare(`
      INSERT INTO goals (id, description, status, priority, metadata, created_at)
      VALUES (?, ?, 'pending', 'critical', ?, ?)
    `).run(
      escalateId,
      `HUMAN REVIEW: ${skillId} failed governance after ${attempt} improvement attempts. Weak: ${weakCategories.join(", ")}`,
      JSON.stringify({
        type: 'governance_escalation',
        skillId,
        weakCategories,
        attempt,
        source: 'governance_improvement_service',
      }),
      new Date().toISOString(),
    );

    console.log(`[GovernanceImprovement] ESCALATED ${skillId} to human review (attempt ${attempt})`);
  }

  /**
   * Get active improvement goals.
   */
  getActiveImprovements(): ImprovementGoal[] {
    return Array.from(this.improvementGoals.values());
  }

  /**
   * Manually clear an improvement goal.
   */
  clearImprovement(skillId: string): void {
    this.improvementGoals.delete(skillId);
  }
}
