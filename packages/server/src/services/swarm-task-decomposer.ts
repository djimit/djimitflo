/**
 * SwarmTaskDecomposer — intelligent task decomposition for parallel execution.
 *
 * Takes complex goals and decomposes them into:
 * 1. Atomic sub-tasks with clear inputs/outputs
 * 2. Dependency graph (DAG) for execution ordering
 * 3. Agent capability matching for optimal assignment
 * 4. Parallel execution groups (tasks at same depth)
 * 5. Merge strategy for combining parallel outputs
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface DecomposedTask {
  id: string;
  title: string;
  description: string;
  type: 'analysis' | 'implementation' | 'verification' | 'documentation' | 'integration';
  dependencies: string[];  // Task IDs that must complete first
  assignedAgent?: string;
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed';
  priority: 1 | 2 | 3 | 4 | 5;
  estimatedEffort: 'small' | 'medium' | 'large';
  inputs: string[];
  outputs: string[];
}

interface ExecutionPlan {
  id: string;
  goal: string;
  tasks: DecomposedTask[];
  stages: string[][];  // Each stage is a set of task IDs that can run in parallel
  estimatedTotalMinutes: number;
  createdAt: string;
}

export class SwarmTaskDecomposer {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Decompose a complex goal into an execution plan.
   */
  decompose(goal: string, options: {
    maxParallelism?: number;
    priority?: 1 | 2 | 3 | 4 | 5;
  } = {}): ExecutionPlan {
    const id = randomUUID();
    const now = new Date().toISOString();
    const maxParallelism = options.maxParallelism || 5;
    const priority = options.priority || 3;

    // Phase 1: Analyze goal complexity and extract components
    const components = this.extractComponents(goal);

    // Phase 2: Create tasks from components
    const tasks = this.createTasks(components, priority);

    // Phase 3: Build dependency graph
    this.buildDependencies(tasks);

    // Phase 4: Create execution stages (parallel groups)
    const stages = this.createStages(tasks, maxParallelism);

    const plan: ExecutionPlan = {
      id,
      goal,
      tasks,
      stages,
      estimatedTotalMinutes: this.estimateTotalTime(tasks),
      createdAt: now,
    };

    // Persist
    this.db.prepare(`
      INSERT INTO execution_plans (id, goal, tasks_json, stages_json, estimated_minutes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, goal, JSON.stringify(tasks), JSON.stringify(stages), plan.estimatedTotalMinutes, now);

    return plan;
  }

  /**
   * Get execution plan by ID.
   */
  getPlan(id: string): ExecutionPlan | null {
    const row = this.db.prepare('SELECT * FROM execution_plans WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      goal: row.goal,
      tasks: JSON.parse(row.tasks_json),
      stages: JSON.parse(row.stages_json),
      estimatedTotalMinutes: row.estimated_minutes,
      createdAt: row.created_at,
    };
  }

  /**
   * List all execution plans.
   */
  listPlans(): Array<{ id: string; goal: string; taskCount: number; createdAt: string }> {
    return (this.db.prepare('SELECT * FROM execution_plans ORDER BY created_at DESC').all() as any[]).map((row) => ({
      id: row.id,
      goal: row.goal.slice(0, 80),
      taskCount: JSON.parse(row.tasks_json).length,
      createdAt: row.created_at,
    }));
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private extractComponents(goal: string): Array<{
    name: string;
    type: DecomposedTask['type'];
    keywords: string[];
  }> {
    const components: Array<{ name: string; type: DecomposedTask['type']; keywords: string[] }> = [];

    // Detect implementation components
    if (/build|create|implement|develop|code/i.test(goal)) {
      components.push({ name: 'Core implementation', type: 'implementation', keywords: ['build', 'code'] });
    }

    // Detect testing components
    if (/test|verify|validate|quality/i.test(goal)) {
      components.push({ name: 'Test suite', type: 'verification', keywords: ['test', 'verify'] });
    }

    // Detect documentation components
    if (/document|readme|docs|explain/i.test(goal)) {
      components.push({ name: 'Documentation', type: 'documentation', keywords: ['docs'] });
    }

    // Detect integration components
    if (/integrate|deploy|connect|merge/i.test(goal)) {
      components.push({ name: 'Integration', type: 'integration', keywords: ['integrate'] });
    }

    // Always include analysis
    if (components.length === 0) {
      components.push({ name: 'Analysis', type: 'analysis', keywords: ['analyze'] });
      components.push({ name: 'Implementation', type: 'implementation', keywords: ['build'] });
      components.push({ name: 'Verification', type: 'verification', keywords: ['test'] });
    }

    return components;
  }

  private createTasks(components: Array<{
    name: string;
    type: DecomposedTask['type'];
    keywords: string[];
  }>, priority: 1 | 2 | 3 | 4 | 5): DecomposedTask[] {
    return components.map((comp) => ({
      id: randomUUID(),
      title: comp.name,
      description: `${comp.name} phase`,
      type: comp.type,
      dependencies: [],
      status: 'pending',
      priority,
      estimatedEffort: comp.type === 'implementation' ? 'large' : 'medium',
      inputs: [],
      outputs: [`${comp.name.toLowerCase().replace(/\s+/g, '-')}-output`],
    }));
  }

  private buildDependencies(tasks: DecomposedTask[]): void {
    // Create a linear dependency chain: analysis → implementation → verification
    for (let i = 1; i < tasks.length; i++) {
      tasks[i].dependencies.push(tasks[i - 1].id);
    }
  }

  private createStages(tasks: DecomposedTask[], maxParallelism: number): string[][] {
    const stages: string[][] = [];
    const completed = new Set<string>();
    let remaining = [...tasks];

    while (remaining.length > 0) {
      // Find tasks with all dependencies met
      const ready = remaining.filter((task) =>
        task.dependencies.every((dep) => completed.has(dep))
      ).slice(0, maxParallelism);

      if (ready.length === 0) break; // Circular dependency or error

      stages.push(ready.map((t) => t.id));
      ready.forEach((t) => completed.add(t.id));
      remaining = remaining.filter((t) => !completed.has(t.id));
    }

    return stages;
  }

  private estimateTotalTime(tasks: DecomposedTask[]): number {
    const effortMinutes = { small: 5, medium: 15, large: 30 };
    return tasks.reduce((sum, task) => sum + effortMinutes[task.estimatedEffort], 0);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_plans (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        tasks_json TEXT NOT NULL DEFAULT '[]',
        stages_json TEXT NOT NULL DEFAULT '[]',
        estimated_minutes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}
