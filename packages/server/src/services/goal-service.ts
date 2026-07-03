/**
 * GoalService — goal CRUD operations.
 *
 * Extracted from LoopService (Phase B2 decomposition).
 * Handles: create, list, get, update, decompose goals + input validation.
 *
 * Note: getGoal is retained in LoopService as it is used widely across
 * the service. This service handles write operations and list/decompose.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface GoalBudget {
  max_tokens?: number;
  max_tokens_per_worker?: number;
  max_tokens_per_diff_line?: number;
  max_maker_workers?: number;
  max_workers?: number;
  max_retries?: number;
  max_failure_count?: number;
  max_runtime_ms?: number;
  max_dollars?: number;
}

export interface GoalCreateInput {
  objective: string;
  acceptance_criteria: string[];
  constraints?: string[];
  risk_class?: 'low' | 'medium' | 'high' | 'critical';
  budget?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GoalUpdateInput {
  objective?: string;
  acceptance_criteria?: string[];
  constraints?: string[];
  risk_class?: 'low' | 'medium' | 'high' | 'critical';
  budget?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: GoalStatus;
}

type GoalStatus = 'created' | 'decomposed' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface GoalRecord {
  id: string;
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  risk_class: 'low' | 'medium' | 'high' | 'critical';
  budget: Record<string, unknown>;
  status: GoalStatus;
  owner_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DecomposedLoopCandidate {
  loop_name: string;
  mode: string;
  reason: string;
  recommended_first: boolean;
  expected_outputs: string[];
  gates: string[];
}

/**
 * Parse a database row into a GoalRecord.
 * Exported for use by LoopService which retains getGoal for widespread access.
 */
export function parseGoal(row: Record<string, unknown>): GoalRecord {
  return {
    id: row.id as string,
    objective: row.objective as string,
    constraints: JSON.parse((row.constraints_json as string) || '[]'),
    acceptance_criteria: JSON.parse((row.acceptance_criteria_json as string) || '[]'),
    risk_class: (row.risk_class as GoalRecord['risk_class']) || 'low',
    budget: JSON.parse((row.budget_json as string) || '{}'),
    status: (row.status as GoalStatus) || 'created',
    owner_user_id: (row.owner_user_id as string) || null,
    metadata: JSON.parse((row.metadata as string) || '{}'),
    created_at: (row.created_at as string) || '',
    updated_at: (row.updated_at as string) || '',
  };
}

export function validateGoalInput(input: GoalCreateInput): void {
  if (!input.objective?.trim()) {
    throw new Error('GOAL_OBJECTIVE_REQUIRED');
  }
  if (!input.acceptance_criteria?.length) {
    throw new Error('GOAL_ACCEPTANCE_CRITERIA_REQUIRED');
  }
}

export class GoalService {
  constructor(private db: Database) {}

  createGoal(input: GoalCreateInput, ownerUserId?: string): GoalRecord {
    validateGoalInput(input);

    const id = randomUUID();
    const now = new Date().toISOString();
    const riskClass = input.risk_class || 'low';

    this.db.prepare(`
      INSERT INTO goals (
        id, objective, constraints_json, acceptance_criteria_json, risk_class,
        budget_json, status, owner_user_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.objective.trim(),
      JSON.stringify(input.constraints || []),
      JSON.stringify(input.acceptance_criteria),
      riskClass,
      JSON.stringify(input.budget || {}),
      'created',
      ownerUserId || null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

    return this.getGoalById(id);
  }

  listGoals(): GoalRecord[] {
    const rows = this.db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(parseGoal);
  }

  getGoalById(id: string): GoalRecord {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('GOAL_NOT_FOUND');
    }
    return parseGoal(row);
  }

  updateGoal(id: string, input: GoalUpdateInput): GoalRecord {
    const existing = this.getGoalById(id);
    const next: GoalCreateInput = {
      objective: input.objective ?? existing.objective,
      constraints: input.constraints ?? existing.constraints,
      acceptance_criteria: input.acceptance_criteria ?? existing.acceptance_criteria,
      risk_class: input.risk_class ?? existing.risk_class,
      budget: input.budget ?? existing.budget,
      metadata: input.metadata ?? existing.metadata,
    };
    validateGoalInput(next);

    const validStatuses: GoalStatus[] = ['created', 'decomposed', 'running', 'blocked', 'completed', 'failed', 'cancelled'];
    const status = input.status ?? existing.status;
    if (!validStatuses.includes(status)) {
      throw new Error('GOAL_STATUS_INVALID');
    }

    this.db.prepare(`
      UPDATE goals
      SET objective = ?,
          constraints_json = ?,
          acceptance_criteria_json = ?,
          risk_class = ?,
          budget_json = ?,
          status = ?,
          metadata = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      next.objective.trim(),
      JSON.stringify(next.constraints || []),
      JSON.stringify(next.acceptance_criteria),
      next.risk_class || 'low',
      JSON.stringify(next.budget || {}),
      status,
      JSON.stringify(next.metadata || {}),
      new Date().toISOString(),
      id
    );

    return this.getGoalById(id);
  }

  decomposeGoal(id: string, contracts: Array<{ name: string; mode: string; description: string; verification: string[] }>, primaryLoopName: string): { goal: GoalRecord; candidates: DecomposedLoopCandidate[] } {
    const goal = this.getGoalById(id);
    const candidates: DecomposedLoopCandidate[] = contracts.map((contract) => ({
      loop_name: contract.name,
      mode: contract.mode,
      reason: contract.description,
      recommended_first: contract.name === primaryLoopName,
      expected_outputs: ['findings', 'bounded_task_plan', 'loop_state_file', 'review_bundle'],
      gates: contract.verification,
    }));

    this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?')
      .run('decomposed', new Date().toISOString(), id);

    return { goal: this.getGoalById(goal.id), candidates };
  }
}
