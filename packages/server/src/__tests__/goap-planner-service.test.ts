import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { GOAPPlannerService, type GOAPGoal } from '../services/goap-planner-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let planner: GOAPPlannerService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  planner = new GOAPPlannerService(db);
});

afterEach(() => {
  db?.close();
});

describe('G47: GOAP A* Planner', () => {
  it('seeds default actions on construction', () => {
    const actions = planner.getActionsForGoal({ id: 'g1', name: 'test', desiredState: { typeCheckPass: true }, priority: 1 });
    expect(actions.length).toBeGreaterThan(0);
  });

  it('finds plan for simple goal', () => {
    const goal: GOAPGoal = {
      id: 'test-goal',
      name: 'Fix TypeScript',
      desiredState: { typeCheckPass: true },
      priority: 1,
    };
    const plan = planner.plan(goal, { hasTypeScriptErrors: true });
    expect(plan).not.toBeNull();
    expect(plan!.actions.length).toBeGreaterThan(0);
  });

  it('returns null for unreachable goal', () => {
    const goal: GOAPGoal = {
      id: 'impossible',
      name: 'Impossible',
      desiredState: { nonExistentState: true },
      priority: 1,
    };
    const plan = planner.plan(goal, {});
    expect(plan).toBeNull();
  });

  it('plan has correct total cost', () => {
    const goal: GOAPGoal = {
      id: 'cost-test',
      name: 'Fix lint',
      desiredState: { lintClean: true },
      priority: 1,
    };
    const plan = planner.plan(goal, { hasLintWarnings: true });
    expect(plan).not.toBeNull();
    expect(plan!.totalCost).toBeGreaterThan(0);
  });

  it('replan excludes failed action', () => {
    planner.addAction({
      capabilityId: 'alt-ts-fix',
      name: 'Alt TS fix',
      preconditions: { hasTypeScriptErrors: true },
      effects: { typeCheckPass: true },
      cost: 2.0,
      runtime: 'opencode',
    });

    const goal: GOAPGoal = {
      id: 'replan-test',
      name: 'Multi-step',
      desiredState: { typeCheckPass: true },
      priority: 1,
    };
    const firstPlan = planner.plan(goal, { hasTypeScriptErrors: true });
    expect(firstPlan).not.toBeNull();
    expect(firstPlan!.actions.length).toBeGreaterThan(0);

    const failedActionId = firstPlan!.actions[0].id;
    const replanned = planner.replan(goal, failedActionId, { hasTypeScriptErrors: true });
    expect(replanned).not.toBeNull();
    expect(replanned!.actions.every(a => a.id !== failedActionId)).toBe(true);
  });

  it('estimateCost returns average cost for capability', () => {
    const cost = planner.estimateCost('ts-fix');
    expect(cost).toBeGreaterThan(0);
  });

  it('getAvailableActions filters by capability', () => {
    const actions = planner.getAvailableActions('ts-fix');
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.capabilityId).toBe('ts-fix');
    }
  });

  it('addAction creates new action', () => {
    const action = planner.addAction({
      capabilityId: 'custom',
      name: 'Custom action',
      preconditions: { needsCustom: true },
      effects: { customDone: true },
      cost: 2.0,
      runtime: 'codex',
    });
    expect(action.id).toBeDefined();
    const retrieved = planner.getAvailableActions('custom');
    expect(retrieved.length).toBe(1);
  });

  it('plan with no preconditions needed returns empty plan', () => {
    const goal: GOAPGoal = {
      id: 'already-done',
      name: 'Already done',
      desiredState: { typeCheckPass: true },
      priority: 1,
    };
    const plan = planner.plan(goal, { typeCheckPass: true });
    expect(plan).not.toBeNull();
    expect(plan!.actions.length).toBe(0);
  });

  it('plan respects action preconditions', () => {
    const goal: GOAPGoal = {
      id: 'precond-test',
      name: 'Security fix',
      desiredState: { securityClean: true },
      priority: 1,
    };
    const planWithoutPrecond = planner.plan(goal, {});
    expect(planWithoutPrecond).toBeNull();

    const planWithPrecond = planner.plan(goal, { hasSecurityIssues: true });
    expect(planWithPrecond).not.toBeNull();
  });

  it('plan finds shortest path among alternatives', () => {
    planner.addAction({
      capabilityId: 'fast-fix',
      name: 'Fast fix',
      preconditions: { needsFix: true },
      effects: { fixed: true },
      cost: 0.5,
      runtime: 'codex',
    });
    planner.addAction({
      capabilityId: 'slow-fix',
      name: 'Slow fix',
      preconditions: { needsFix: true },
      effects: { fixed: true },
      cost: 3.0,
      runtime: 'codex',
    });

    const goal: GOAPGoal = {
      id: 'shortest-path',
      name: 'Fix it',
      desiredState: { fixed: true },
      priority: 1,
    };
    const plan = planner.plan(goal, { needsFix: true });
    expect(plan).not.toBeNull();
    expect(plan!.totalCost).toBeLessThan(3.0);
  });

  it('estimated success rate is between 0 and 1', () => {
    const goal: GOAPGoal = {
      id: 'success-rate',
      name: 'Fix TS',
      desiredState: { typeCheckPass: true },
      priority: 1,
    };
    const plan = planner.plan(goal, { hasTypeScriptErrors: true });
    expect(plan).not.toBeNull();
    expect(plan!.estimatedSuccessRate).toBeGreaterThan(0);
    expect(plan!.estimatedSuccessRate).toBeLessThanOrEqual(1);
  });

  it('plan with custom actions overrides defaults', () => {
    const customActions = [
      { id: 'custom-1', capabilityId: 'custom', name: 'Step 1', preconditions: {}, effects: { step1: true }, cost: 1.0, runtime: 'codex' },
      { id: 'custom-2', capabilityId: 'custom', name: 'Step 2', preconditions: { step1: true }, effects: { done: true }, cost: 1.0, runtime: 'codex' },
    ];
    const goal: GOAPGoal = {
      id: 'custom-plan',
      name: 'Custom plan',
      desiredState: { done: true },
      priority: 1,
    };
    const plan = planner.plan(goal, {}, customActions);
    expect(plan).not.toBeNull();
    expect(plan!.actions.length).toBe(2);
  });
});
