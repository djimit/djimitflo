import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface GOAPAction {
  id: string;
  capabilityId: string;
  name: string;
  preconditions: Record<string, boolean>;
  effects: Record<string, boolean>;
  cost: number;
  runtime: string;
}

export interface GOAPGoal {
  id: string;
  name: string;
  desiredState: Record<string, boolean>;
  priority: number;
}

export interface GOAPPlan {
  actions: GOAPAction[];
  totalCost: number;
  estimatedSuccessRate: number;
}

interface ActionRow {
  id: string;
  capability_id: string;
  name: string;
  preconditions_json: string;
  effects_json: string;
  cost: number;
  success_rate: number;
}

interface PlanNode {
  state: Record<string, boolean>;
  g: number;
  f: number;
  parent: PlanNode | null;
  action: GOAPAction | null;
}

export class GOAPPlannerService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goap_actions (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        name TEXT NOT NULL,
        preconditions_json TEXT NOT NULL,
        effects_json TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 1.0,
        success_rate REAL NOT NULL DEFAULT 0.5
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_goap_capability ON goap_actions(capability_id)');
    this.seedDefaultActions();
  }

  plan(goal: GOAPGoal, currentState: Record<string, boolean>, actions?: GOAPAction[]): GOAPPlan | null {
    const availableActions = actions ?? this.getActionsForGoal(goal);

    if (availableActions.length === 0) return null;

    const plan = this.aStar(goal, currentState, availableActions);
    if (!plan) return null;

    const totalCost = plan.reduce((sum, a) => sum + a.cost, 0);
    const avgSuccess = plan.reduce((sum, a) => sum + (a.cost > 0 ? 1 / a.cost : 0.5), 0) / plan.length;

    return { actions: plan, totalCost, estimatedSuccessRate: avgSuccess };
  }

  replan(goal: GOAPGoal, failedActionId: string, currentState: Record<string, boolean>): GOAPPlan | null {
    const allActions = this.getActionsForGoal(goal);
    const filtered = allActions.filter(a => a.id !== failedActionId);
    return this.plan(goal, currentState, filtered);
  }

  estimateCost(capabilityId: string): number {
    const row = this.db.prepare(
      'SELECT AVG(cost) as avg_cost FROM goap_actions WHERE capability_id = ?'
    ).get(capabilityId) as { avg_cost: number | null };
    return row.avg_cost ?? 1.0;
  }

  getAvailableActions(capabilityId: string): GOAPAction[] {
    const rows = this.db.prepare(
      'SELECT * FROM goap_actions WHERE capability_id = ?'
    ).all(capabilityId) as ActionRow[];
    return rows.map(this.rowToAction);
  }

  addAction(action: Omit<GOAPAction, 'id'>): GOAPAction {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO goap_actions (id, capability_id, name, preconditions_json, effects_json, cost, success_rate)
      VALUES (?, ?, ?, ?, ?, ?, 0.5)
    `).run(id, action.capabilityId, action.name, JSON.stringify(action.preconditions), JSON.stringify(action.effects), action.cost);
    return { ...action, id };
  }

  getActionsForGoal(goal: GOAPGoal): GOAPAction[] {
    const rows = this.db.prepare('SELECT * FROM goap_actions').all() as ActionRow[];
    return rows
      .map(this.rowToAction)
      .filter(action => {
        const providesUsefulEffect = Object.keys(action.effects).some(
          key => goal.desiredState[key] === true && action.effects[key] === true
        );
        return providesUsefulEffect;
      })
      .slice(0, 10);
  }

  private aStar(goal: GOAPGoal, startState: Record<string, boolean>, actions: GOAPAction[]): GOAPAction[] | null {
    const openSet: PlanNode[] = [{ state: { ...startState }, g: 0, f: this.heuristic(startState, goal), parent: null, action: null }];
    const visited = new Set<string>();

    while (openSet.length > 0) {
      openSet.sort((a, b) => a.f - b.f);
      const current = openSet.shift()!;
      const stateKey = JSON.stringify(current.state);

      if (visited.has(stateKey)) continue;
      visited.add(stateKey);

      if (this.satisfies(current.state, goal.desiredState)) {
        return this.reconstructPath(current);
      }

      for (const action of actions) {
        if (!this.satisfies(current.state, action.preconditions)) continue;

        const newState = { ...current.state };
        for (const [key, val] of Object.entries(action.effects)) {
          newState[key] = val;
        }

        const newStateKey = JSON.stringify(newState);
        if (visited.has(newStateKey)) continue;

        const g = current.g + action.cost;
        const f = g + this.heuristic(newState, goal);

        openSet.push({ state: newState, g, f, parent: current, action });
      }

      if (visited.size > 1000) return null;
    }

    return null;
  }

  private heuristic(state: Record<string, boolean>, goal: GOAPGoal): number {
    let unsatisfied = 0;
    for (const [key, desired] of Object.entries(goal.desiredState)) {
      if (desired && !state[key]) unsatisfied++;
    }
    return unsatisfied;
  }

  private satisfies(state: Record<string, boolean>, requirements: Record<string, boolean>): boolean {
    for (const [key, required] of Object.entries(requirements)) {
      if (required && !state[key]) return false;
    }
    return true;
  }

  private reconstructPath(node: PlanNode): GOAPAction[] {
    const actions: GOAPAction[] = [];
    let current: PlanNode | null = node;
    while (current?.action) {
      actions.unshift(current.action);
      current = current.parent;
    }
    return actions;
  }

  private rowToAction(row: ActionRow): GOAPAction {
    return {
      id: row.id,
      capabilityId: row.capability_id,
      name: row.name,
      preconditions: JSON.parse(row.preconditions_json) as Record<string, boolean>,
      effects: JSON.parse(row.effects_json) as Record<string, boolean>,
      cost: row.cost,
      runtime: 'codex',
    };
  }

  private seedDefaultActions(): void {
    const count = this.db.prepare('SELECT COUNT(*) as c FROM goap_actions').get() as { c: number };
    if (count.c > 0) return;

    const defaults: Array<Omit<GOAPAction, 'id'>> = [
      { capabilityId: 'ts-fix', name: 'Fix TypeScript errors', preconditions: { hasTypeScriptErrors: true }, effects: { typeCheckPass: true }, cost: 1.0, runtime: 'codex' },
      { capabilityId: 'lint-fix', name: 'Fix lint warnings', preconditions: { hasLintWarnings: true }, effects: { lintClean: true }, cost: 0.5, runtime: 'codex' },
      { capabilityId: 'doc-drift', name: 'Fix documentation drift', preconditions: { hasDocDrift: true }, effects: { docsUpdated: true }, cost: 1.5, runtime: 'codex' },
      { capabilityId: 'security-fix', name: 'Fix security issues', preconditions: { hasSecurityIssues: true }, effects: { securityClean: true }, cost: 2.0, runtime: 'codex' },
      { capabilityId: 'test-fix', name: 'Fix failing tests', preconditions: { hasFailingTests: true }, effects: { testsPass: true }, cost: 1.0, runtime: 'codex' },
    ];

    for (const d of defaults) {
      this.addAction(d);
    }
  }
}
