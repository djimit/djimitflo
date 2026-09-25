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
  candidates?: ReturnType<LoopService['decomposeGoal']>['candidates'];
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
    _db: Database,
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
      const { candidates } = this.loops.decomposeGoal(goalId);
      return {
        goal_id: goalId,
        nodes: [],
        fallback: true,
        candidates,
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
    this.loops.updateGoal(goalId, {
      status: 'decomposed',
      metadata: { ...meta, dag: nodes, decomposed_at: new Date().toISOString() },
    });

    swarmEventBus.emit('convergence', {
      decomposition: 'dag_created',
      goal_id: goalId,
      steps: nodes.map(n => n.step),
      fallback: false,
    });

    // Register the DAG as an observed mission/tasks in Swarm Mission Control,
    // so capability/claim-driven planning has somewhere to land instead of
    // living only in goal.metadata. Default-off: creates rows in 'observed'
    // status only (see SwarmIntelligenceService.createMission/createTask) —
    // nothing here executes anything; a human (or a separately gated policy
    // check) still has to transition the mission forward.
    if (process.env.GOAL_DECOMPOSER_AUTO_MISSIONS === 'true') {
      this.registerMission(goalId, goal.objective, nodes);
    }

    return {
      goal_id: goalId,
      nodes,
      fallback: false,
    };
  }

  private registerMission(goalId: string, objective: string, nodes: DAGNode[]): void {
    try {
      const mission = this.intelligence.createMission({
        goal_id: goalId,
        title: objective.slice(0, 120),
        description: `Auto-decomposed from goal ${goalId} by GoalDecomposer`,
        risk_class: 'medium',
        metadata: { source: 'goal-decomposer-auto' },
      });
      for (const node of nodes) {
        this.intelligence.createTask({
          mission_id: mission.id,
          title: `${node.step} (${node.role})`,
          description: `Step '${node.step}', depends on: ${node.dependencies.join(', ') || 'none'}`,
          capability_id: node.capability_id,
          metadata: { source: 'goal-decomposer-auto', runtime: node.runtime },
        });
      }
    } catch (err) {
      // Best-effort: a mission-registration failure must not block decomposition.
      swarmEventBus.emit('convergence', {
        decomposition: 'auto_mission_failed',
        goal_id: goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
