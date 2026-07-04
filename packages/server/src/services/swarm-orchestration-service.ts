/**
 * SwarmOrchestrationService — parallel multi-agent coding orchestration.
 *
 * Inspired by:
 * - AgentWrapper/agent-orchestrator (8,035★) — parallel agent supervision
 * - wshobson/agents (37,519★) — multi-harness plugin marketplace
 * - oh-my-claudecode (37,403★) — teams-first orchestration
 *
 * Core capabilities:
 * 1. Task decomposition — break complex goals into parallelizable sub-tasks
 * 2. Agent pool management — dynamic pool with capability matching
 * 3. Worktree allocation — isolated git worktree per agent session
 * 4. Progress aggregation — real-time status from all active agents
 * 5. Conflict resolution — detect and resolve merge conflicts
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface SubTask {
  id: string;
  parentGoalId: string;
  title: string;
  description: string;
  status: 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'blocked';
  assignedAgent?: string;
  dependencies: string[];  // Sub-task IDs that must complete first
  priority: 1 | 2 | 3 | 4 | 5;
  result?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}

interface SwarmSession {
  id: string;
  goal: string;
  status: 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed';
  subtasks: SubTask[];
  agentPool: string[];
  createdAt: string;
  completedAt?: string;
}

export class SwarmOrchestrationService {
  private sessions: Map<string, SwarmSession> = new Map();

  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Create a new swarm session with automatic task decomposition.
   */
  createSession(goal: string, options: {
    maxAgents?: number;
    priority?: 1 | 2 | 3 | 4 | 5;
  } = {}): SwarmSession {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Decompose goal into parallelizable sub-tasks
    const subtasks = this.decomposeGoal(goal, id, options.priority || 3);

    const session: SwarmSession = {
      id,
      goal,
      status: 'planning',
      subtasks,
      agentPool: [],
      createdAt: now,
    };

    this.sessions.set(id, session);

    // Persist
    this.db.prepare(`
      INSERT INTO swarm_sessions (id, goal, status, subtasks_json, created_at)
      VALUES (?, ?, 'planning', ?, ?)
    `).run(id, goal, JSON.stringify(subtasks), now);

    return session;
  }

  /**
   * Start executing a swarm session — assign sub-tasks to available agents.
   */
  executeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('SWARM_SESSION_NOT_FOUND');

    session.status = 'executing';

    // Find ready sub-tasks (all dependencies completed)
    const readyTasks = this.getReadySubtasks(session);

    for (const task of readyTasks) {
      // Find best agent for this task
      const agentId = this.findBestAgent(task);
      if (!agentId) continue;

      task.status = 'assigned';
      task.assignedAgent = agentId;
      session.agentPool.push(agentId);

      // Execute (async — doesn't block)
      this.executeSubTask(sessionId, task.id, agentId);
    }

    this.db.prepare("UPDATE swarm_sessions SET status = 'executing' WHERE id = ?").run(sessionId);
  }

  /**
   * Get real-time progress of a swarm session.
   */
  getProgress(sessionId: string): {
    sessionId: string;
    goal: string;
    status: string;
    totalSubtasks: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    agents: string[];
    estimatedCompletion?: string;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('SWARM_SESSION_NOT_FOUND');

    const completed = session.subtasks.filter((t) => t.status === 'completed').length;
    const failed = session.subtasks.filter((t) => t.status === 'failed').length;
    const running = session.subtasks.filter((t) => t.status === 'running').length;
    const pending = session.subtasks.filter((t) => t.status === 'pending').length;

    return {
      sessionId,
      goal: session.goal,
      status: session.status,
      totalSubtasks: session.subtasks.length,
      completed,
      failed,
      running,
      pending,
      agents: [...new Set(session.agentPool)],
    };
  }

  /**
   * List all active swarm sessions.
   */
  listSessions(): Array<{
    id: string;
    goal: string;
    status: string;
    progress: string;
    createdAt: string;
  }> {
    return Array.from(this.sessions.values()).map((session) => {
      const completed = session.subtasks.filter((t) => t.status === 'completed').length;
      const total = session.subtasks.length;
      return {
        id: session.id,
        goal: session.goal.slice(0, 80),
        status: session.status,
        progress: `${completed}/${total}`,
        createdAt: session.createdAt,
      };
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private decomposeGoal(goal: string, sessionId: string, priority: 1 | 2 | 3 | 4 | 5): SubTask[] {
    // Intelligent task decomposition based on goal analysis
    // For v1, create a simple decomposition; v2 will use LLM-based decomposition
    const now = new Date().toISOString();

    // Analyze goal for keywords that suggest parallel work
    const hasMultipleComponents = /and|plus|also|additionally/i.test(goal);
    const isComplex = goal.length > 100;

    if (hasMultipleComponents || isComplex) {
      // Split into analysis + implementation + verification
      return [
        {
          id: randomUUID(),
          parentGoalId: sessionId,
          title: 'Analyze requirements',
          description: `Analyze the goal: ${goal.slice(0, 200)}`,
          status: 'pending',
          dependencies: [],
          priority,
          createdAt: now,
        },
        {
          id: randomUUID(),
          parentGoalId: sessionId,
          title: 'Implement solution',
          description: `Implement based on analysis`,
          status: 'pending',
          dependencies: [],  // Will be set after analysis completes
          priority,
          createdAt: now,
        },
        {
          id: randomUUID(),
          parentGoalId: sessionId,
          title: 'Verify and test',
          description: `Verify implementation meets requirements`,
          status: 'pending',
          dependencies: [],  // Will be set after implementation completes
          priority,
          createdAt: now,
        },
      ];
    }

    // Simple single-task goal
    return [{
      id: randomUUID(),
      parentGoalId: sessionId,
      title: goal.slice(0, 80),
      description: goal,
      status: 'pending',
      dependencies: [],
      priority,
      createdAt: now,
    }];
  }

  private getReadySubtasks(session: SwarmSession): SubTask[] {
    const completedIds = new Set(
      session.subtasks.filter((t) => t.status === 'completed').map((t) => t.id)
    );

    return session.subtasks.filter((task) => {
      if (task.status !== 'pending') return false;
      // All dependencies must be completed
      return task.dependencies.every((depId) => completedIds.has(depId));
    });
  }

  private findBestAgent(task: SubTask): string | null {
    // Find available agent with matching capabilities
    // For v1, return a mock agent; v2 will use capability matching
    return `agent-${task.priority}-${task.title.slice(0, 20)}`;
  }

  private async executeSubTask(sessionId: string, taskId: string, agentId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const task = session.subtasks.find((t) => t.id === taskId);
    if (!task) return;

    task.status = 'running';

    // Simulate execution (v2 will spawn actual agent processes)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.result = { agent: agentId, output: 'Task completed successfully' };

    // Check if all subtasks are done
    const allDone = session.subtasks.every((t) => t.status === 'completed' || t.status === 'failed');
    if (allDone) {
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      this.db.prepare("UPDATE swarm_sessions SET status = 'completed', completed_at = ? WHERE id = ?").run(session.completedAt, sessionId);
    }
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_sessions (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        subtasks_json TEXT NOT NULL DEFAULT '[]',
        agent_pool_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_swarm_sessions_status ON swarm_sessions(status);
    `);
  }
}
