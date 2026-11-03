import { describe, expect, it } from 'vitest';
import { parseGoal, validateGoalInput } from '../services/goal-service';
import type { GoalCreateInput } from '../services/goal-service';

describe('parseGoal', () => {
  it('parses a full database row into a GoalRecord', () => {
    const row = {
      id: 'goal-1',
      objective: 'Cover untested exports',
      constraints_json: JSON.stringify(['no-prod-edits']),
      acceptance_criteria_json: JSON.stringify(['test passes']),
      risk_class: 'low',
      budget_json: JSON.stringify({ max_tokens: 30000 }),
      status: 'created',
      owner_user_id: 'user-1',
      metadata: JSON.stringify({ goal_batch: { id: 'batch-1' } }),
      created_at: '2026-10-03T00:00:00.000Z',
      updated_at: '2026-10-03T00:00:01.000Z',
    };

    const goal = parseGoal(row);

    expect(goal).toEqual({
      id: 'goal-1',
      objective: 'Cover untested exports',
      constraints: ['no-prod-edits'],
      acceptance_criteria: ['test passes'],
      risk_class: 'low',
      budget: { max_tokens: 30000 },
      status: 'created',
      owner_user_id: 'user-1',
      metadata: { goal_batch: { id: 'batch-1' } },
      created_at: '2026-10-03T00:00:00.000Z',
      updated_at: '2026-10-03T00:00:01.000Z',
    });
  });

  it('defaults missing JSON fields to empty containers', () => {
    const goal = parseGoal({
      id: 'goal-2',
      objective: 'Minimal row',
      constraints_json: undefined,
      acceptance_criteria_json: undefined,
      budget_json: undefined,
      metadata: undefined,
      risk_class: undefined,
      status: undefined,
      owner_user_id: undefined,
      created_at: undefined,
      updated_at: undefined,
    });

    expect(goal.constraints).toEqual([]);
    expect(goal.acceptance_criteria).toEqual([]);
    expect(goal.budget).toEqual({});
    expect(goal.metadata).toEqual({});
    expect(goal.risk_class).toBe('low');
    expect(goal.status).toBe('created');
    expect(goal.owner_user_id).toBeNull();
    expect(goal.created_at).toBe('');
    expect(goal.updated_at).toBe('');
  });
});

describe('validateGoalInput', () => {
  it('passes for a well-formed input', () => {
    const input: GoalCreateInput = {
      objective: 'Add tests',
      acceptance_criteria: ['Tests pass'],
    };
    expect(() => validateGoalInput(input)).not.toThrow();
  });

  it('throws GOAL_OBJECTIVE_REQUIRED when objective is blank', () => {
    expect(() =>
      validateGoalInput({ objective: '   ', acceptance_criteria: ['x'] }),
    ).toThrow('GOAL_OBJECTIVE_REQUIRED');
  });

  it('throws GOAL_OBJECTIVE_REQUIRED when objective is missing', () => {
    expect(() =>
      validateGoalInput({ objective: '', acceptance_criteria: ['x'] } as GoalCreateInput),
    ).toThrow('GOAL_OBJECTIVE_REQUIRED');
  });

  it('throws GOAL_ACCEPTANCE_CRITERIA_REQUIRED when criteria is empty', () => {
    expect(() =>
      validateGoalInput({ objective: 'Add tests', acceptance_criteria: [] }),
    ).toThrow('GOAL_ACCEPTANCE_CRITERIA_REQUIRED');
  });

  it('throws GOAL_ACCEPTANCE_CRITERIA_REQUIRED when criteria is missing', () => {
    expect(() =>
      validateGoalInput({ objective: 'Add tests', acceptance_criteria: undefined } as unknown as GoalCreateInput),
    ).toThrow('GOAL_ACCEPTANCE_CRITERIA_REQUIRED');
  });
});