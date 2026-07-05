/**
 * AgiGoalReasoningEngine — autonomous goal deduction and planning.
 *
 * This is the "consciousness" layer of DjimFlo. It:
 * 1. Observes system state and identifies opportunities
 * 2. Deduces high-level goals from first principles
 * 3. Plans multi-step strategies to achieve goals
 * 4. Monitors progress and adapts strategies
 * 5. Learns from outcomes to improve future reasoning
 *
 * Architecture:
 *   Observe → Deduce → Plan → Execute → Monitor → Learn
 *
 * Inspired by:
 * - OpenAI o1/o3 chain-of-thought reasoning
 * - Anthropic's constitutional AI (self-reflection)
 * - Ruflo's GOAP A* planner
 * - DjimFlo's cognitive loop closure
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface GoalHypothesis {
  id: string;
  statement: string;
  confidence: number;
  evidence: string[];
  reasoning: string;
  parentGoalId?: string;
  status: 'hypothesis' | 'validated' | 'invalidated' | 'in_progress' | 'achieved';
  createdAt: string;
}

interface ReasoningStep {
  id: string;
  goalId: string;
  phase: 'observe' | 'deduce' | 'plan' | 'execute' | 'monitor' | 'learn';
  input: string;
  output: string;
  confidence: number;
  durationMs: number;
  timestamp: string;
}

interface StrategyNode {
  id: string;
  goalId: string;
  action: string;
  preconditions: string[];
  effects: string[];
  children: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  priority: number;
}

export class AgiGoalReasoningEngine {
  private reasoningLog: ReasoningStep[] = [];

  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Observe the system state and identify opportunities.
   */
  observe(): {
    observations: string[];
    anomalies: string[];
    opportunities: string[];
  } {
    const observations: string[] = [];
    const anomalies: string[] = [];
    const opportunities: string[] = [];

    // Observe loop health
    const loopStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
      FROM loop_runs
      WHERE created_at > datetime('now', '-24 hours')
    `).get() as any;

    observations.push(`Loop health: ${loopStats.running || 0} running, ${loopStats.failed || 0} failed, ${loopStats.blocked || 0} blocked`);

    if ((loopStats.failed || 0) > (loopStats.running || 0)) {
      anomalies.push('Failure rate exceeds success rate');
      opportunities.push('Investigate root cause of loop failures');
    }

    // Observe governance health
    const govStats = this.db.prepare(`
      SELECT COUNT(*) as total,
             AVG(overall_score) as avg_score
      FROM openmythos_eval_runs
      WHERE status = 'completed'
    `).get() as any;

    if (govStats.avg_score && govStats.avg_score < 3.5) {
      anomalies.push(`Governance score below threshold: ${govStats.avg_score.toFixed(1)}/5.0`);
      opportunities.push('Run governance re-certification for low-scoring agents');
    }

    // Observe test coverage
    const untestedCount = this.db.prepare(`
      SELECT COUNT(*) as c FROM goals WHERE status = 'created'
    `).get() as any;

    if (untestedCount.c > 10) {
      opportunities.push(`${untestedCount.c} goals awaiting decomposition`);
    }

    // Observe agent utilization
    const agentStats = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM agents
    `).get() as any;

    if (agentStats.total > 0 && (agentStats.active || 0) === 0) {
      anomalies.push('No active agents despite registered agents');
      opportunities.push('Activate idle agents for pending work');
    }

    return { observations, anomalies, opportunities };
  }

  /**
   * Deduce high-level goals from observations.
   */
  deduceGoals(observations: {
    observations: string[];
    anomalies: string[];
    opportunities: string[];
  }): GoalHypothesis[] {
    const hypotheses: GoalHypothesis[] = [];
    const now = new Date().toISOString();

    for (const opportunity of observations.opportunities) {
      const hypothesis: GoalHypothesis = {
        id: randomUUID(),
        statement: opportunity,
        confidence: this.calculateInitialConfidence(opportunity),
        evidence: observations.observations,
        reasoning: `Deduced from observation: ${opportunity}`,
        status: 'hypothesis',
        createdAt: now,
      };

      hypotheses.push(hypothesis);

      this.db.prepare(`
        INSERT INTO goal_hypotheses (id, statement, confidence, evidence_json, reasoning, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'hypothesis', ?)
      `).run(hypothesis.id, hypothesis.statement, hypothesis.confidence, JSON.stringify(hypothesis.evidence), hypothesis.reasoning, now);
    }

    return hypotheses;
  }

  /**
   * Plan a multi-step strategy to achieve a goal.
   */
  planStrategy(goalId: string): StrategyNode[] {
    const goal = this.db.prepare('SELECT * FROM goal_hypotheses WHERE id = ?').get(goalId) as any;
    if (!goal) return [];

    const steps = this.decomposeGoal(goal.statement);
    const nodes: StrategyNode[] = [];

    for (let i = 0; i < steps.length; i++) {
      const node: StrategyNode = {
        id: randomUUID(),
        goalId,
        action: steps[i],
        preconditions: i > 0 ? [nodes[i - 1].id] : [],
        effects: [`${steps[i]} completed`],
        children: [],
        status: 'pending',
        priority: steps.length - i,
      };

      if (i > 0) {
        nodes[i - 1].children.push(node.id);
      }

      nodes.push(node);

      this.db.prepare(`
        INSERT INTO strategy_nodes (id, goal_id, action, preconditions_json, effects_json, children_json, status, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(node.id, node.goalId, node.action, JSON.stringify(node.preconditions), JSON.stringify(node.effects), JSON.stringify(node.children), node.priority, new Date().toISOString());
    }

    return nodes;
  }

  /**
   * Execute reasoning chain: Observe → Deduce → Plan.
   */
  reason(): {
    observations: { observations: string[]; anomalies: string[]; opportunities: string[] };
    hypotheses: GoalHypothesis[];
    strategies: StrategyNode[][];
  } {
    const startTime = Date.now();

    // Phase 1: Observe
    const observations = this.observe();
    this.logReasoning('observe', 'system_state', JSON.stringify(observations), 1.0, Date.now() - startTime);

    // Phase 2: Deduce
    const hypotheses = this.deduceGoals(observations);
    this.logReasoning('deduce', JSON.stringify(observations.opportunities), JSON.stringify(hypotheses.map(h => h.statement)), 0.8, Date.now() - startTime);

    // Phase 3: Plan
    const strategies: StrategyNode[][] = [];
    for (const hypothesis of hypotheses.slice(0, 3)) {
      const strategy = this.planStrategy(hypothesis.id);
      strategies.push(strategy);
    }
    this.logReasoning('plan', JSON.stringify(hypotheses.map(h => h.id)), JSON.stringify(strategies.map(s => s.length)), 0.7, Date.now() - startTime);

    return { observations, hypotheses, strategies };
  }

  /**
   * Get reasoning statistics.
   */
  getStats(): {
    totalHypotheses: number;
    validatedHypotheses: number;
    totalStrategies: number;
    totalReasoningSteps: number;
  } {
    const hypotheses = (this.db.prepare('SELECT COUNT(*) as c FROM goal_hypotheses').get() as any)?.c || 0;
    const validated = (this.db.prepare("SELECT COUNT(*) as c FROM goal_hypotheses WHERE status = 'validated'").get() as any)?.c || 0;
    const strategies = (this.db.prepare('SELECT COUNT(*) as c FROM strategy_nodes').get() as any)?.c || 0;
    const steps = this.reasoningLog.length;

    return {
      totalHypotheses: hypotheses,
      validatedHypotheses: validated,
      totalStrategies: strategies,
      totalReasoningSteps: steps,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private calculateInitialConfidence(opportunity: string): number {
    // Higher confidence for specific, actionable opportunities
    let confidence = 0.5;
    if (/investigate|fix|improve|implement/i.test(opportunity)) confidence += 0.2;
    if (/critical|urgent|blocking/i.test(opportunity)) confidence += 0.2;
    if (opportunity.length > 20) confidence += 0.1;
    return Math.min(1, confidence);
  }

  private decomposeGoal(goal: string): string[] {
    // Simple decomposition; v2 will use LLM-based decomposition
    const steps: string[] = [];

    if (/investigate|analyze|understand/i.test(goal)) {
      steps.push('Gather relevant data');
      steps.push('Analyze patterns and anomalies');
      steps.push('Formulate findings');
    } else if (/fix|repair|resolve/i.test(goal)) {
      steps.push('Identify root cause');
      steps.push('Design fix');
      steps.push('Implement fix');
      steps.push('Verify resolution');
    } else if (/implement|build|create/i.test(goal)) {
      steps.push('Design architecture');
      steps.push('Implement core functionality');
      steps.push('Add tests');
      steps.push('Document and ship');
    } else {
      steps.push('Analyze requirements');
      steps.push('Plan approach');
      steps.push('Execute plan');
      steps.push('Validate results');
    }

    return steps;
  }

  private logReasoning(phase: ReasoningStep['phase'], input: string, output: string, confidence: number, durationMs: number): void {
    this.reasoningLog.push({
      id: randomUUID(),
      goalId: 'system',
      phase,
      input: input.slice(0, 500),
      output: output.slice(0, 500),
      confidence,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_hypotheses (
        id TEXT PRIMARY KEY,
        statement TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        reasoning TEXT NOT NULL DEFAULT '',
        parent_goal_id TEXT,
        status TEXT NOT NULL DEFAULT 'hypothesis' CHECK(status IN ('hypothesis', 'validated', 'invalidated', 'in_progress', 'achieved')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS strategy_nodes (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT '',
        preconditions_json TEXT NOT NULL DEFAULT '[]',
        effects_json TEXT NOT NULL DEFAULT '[]',
        children_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
        priority INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (goal_id) REFERENCES goal_hypotheses(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_goal_hypotheses_status ON goal_hypotheses(status);
      CREATE INDEX IF NOT EXISTS idx_strategy_nodes_goal_id ON strategy_nodes(goal_id);
    `);
  }
}
