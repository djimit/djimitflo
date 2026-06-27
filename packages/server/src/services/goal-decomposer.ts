import type { Database } from 'better-sqlite3';
import { LoopService } from './loop-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { swarmEventBus } from './swarm-event-bus';

/**
 * G21: GoalDecomposer — decomposes arbitrary goals into capability DAGs.
 *
 * The current decomposeGoal maps to fixed LOOP_CONTRACTS (predefined loop shapes).
 * This service extends it: it parses the goal's objective into steps, matches each
 * step to a capability, and builds a DAG with dependencies.
 *
 * The decomposition can use the runtime (codex, headless) for natural-language parsing.
 * If the runtime is unavailable, it falls back to a keyword-based heuristic.
 * If that also fails, it falls back to the existing decomposeGoal (predefined loops).
 */

export interface DAGNode {
  step: string;
  capability_id: string | null;
  role: string;
  runtime: string;
  dependencies: string[]; // step names this depends on
}

export interface CapabilityDAG {
  goal_id: string;
  nodes: DAGNode[];
  fallback: boolean; // true if fell back to predefined loops
}

const STEP_KEYWORDS: Array<{ keywords: string[]; step: string; role: string }> = [
  { keywords: ['analyse', 'analyze', 'investigate', 'understand', 'review'], step: 'analyse', role: 'maker' },
  { keywords: ['implement', 'add', 'create', 'build', 'write', 'develop'], step: 'implement', role: 'maker' },
  { keywords: ['test', 'verify', 'validate', 'check'], step: 'test', role: 'checker' },
  { keywords: ['document', 'docs', 'readme', 'comment'], step: 'document', role: 'maker' },
  { keywords: ['fix', 'repair', 'patch', 'resolve'], step: 'fix', role: 'maker' },
  { keywords: ['refactor', 'restructure', 'clean', 'simplify'], step: 'refactor', role: 'maker' },
  { keywords: ['deploy', 'release', 'publish', 'ship'], step: 'deploy', role: 'governance_guard' },
  { keywords: ['review', 'approve', 'accept'], step: 'review', role: 'checker' },
];

export class GoalDecomposer {
  constructor(
    private db: Database,
    private loops: LoopService,
    private intelligence: SwarmIntelligenceService,
  ) {}

  /**
   * Decompose a goal into a capability DAG.
   * Tries keyword-based heuristic first; falls back to predefined loops.
   */
  decomposeGoalToDAG(goalId: string): CapabilityDAG {
    const goal = this.loops.getGoal(goalId);
    const objective = goal.objective.toLowerCase();

    // 1. Parse the objective into steps using keyword matching.
    const steps: Array<{ step: string; role: string }> = [];
    for (const { keywords, step, role } of STEP_KEYWORDS) {
      if (keywords.some(kw => objective.includes(kw))) {
        if (!steps.find(s => s.step === step)) {
          steps.push({ step, role });
        }
      }
    }

    // If no steps matched, fall back to predefined loops.
    if (steps.length === 0) {
      this.loops.decomposeGoal(goalId);
      return {
        goal_id: goalId,
        nodes: [],
        fallback: true,
      };
    }

    // 2. Match each step to a capability.
    const caps = this.intelligence.listCapabilities()
      .filter(c => c.status === 'validated' || c.status === 'candidate');

    // 3. Build the DAG with dependencies (sequential by default).
    const nodes: DAGNode[] = steps.map((s, i) => {
      const matching = caps.find(c => {
        const meta = c.metadata as Record<string, unknown> | undefined;
        const name = meta?.name as string | undefined;
        return name && name.toLowerCase().includes(s.step);
      });

      return {
        step: s.step,
        capability_id: matching?.id ?? null,
        role: s.role,
        runtime: 'codex',
        dependencies: i > 0 ? [steps[i - 1].step] : [],
      };
    });

    // 4. Store the DAG in the goal's metadata.
    const meta = typeof goal.metadata === 'object' ? goal.metadata : {};
    this.db.prepare('UPDATE goals SET metadata = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...meta, dag: nodes, decomposed_at: new Date().toISOString() }),
        'decomposed',
        new Date().toISOString(),
        goalId,
      );

    swarmEventBus.emit('convergence', {
      decomposition: 'dag_created',
      goal_id: goalId,
      steps: nodes.map(n => n.step),
      fallback: false,
    });

    return {
      goal_id: goalId,
      nodes,
      fallback: false,
    };
  }
}
