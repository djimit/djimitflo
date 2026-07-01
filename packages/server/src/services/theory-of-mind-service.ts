import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface IntentModel {
  agentId: string;
  beliefs: string[];
  goals: string[];
  plannedActions: string[];
  confidence: number;
  observationCount: number;
  lastUpdated: string;
}

interface IntentRow {
  agent_id: string;
  beliefs_json: string;
  goals_json: string;
  planned_actions_json: string;
  confidence: number;
  observation_count: number;
  last_updated: string;
}

interface ObservationRow {
  subject_ref: string;
  claim: string;
  status: string;
}

export class TheoryOfMindService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_intent_models (
        agent_id TEXT PRIMARY KEY,
        beliefs_json TEXT NOT NULL DEFAULT '[]',
        goals_json TEXT NOT NULL DEFAULT '[]',
        planned_actions_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.5,
        observation_count INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  modelAgentIntent(agentId: string, observations: string[] = []): IntentModel {
    const existing = this.db.prepare('SELECT * FROM agent_intent_models WHERE agent_id = ?').get(agentId) as IntentRow | undefined;

    const claims = this.db.prepare(
      'SELECT subject_ref, claim, status FROM swarm_claims WHERE created_from = ? ORDER BY created_at DESC LIMIT 20'
    ).all(agentId) as ObservationRow[];

    const allObservations = [...observations, ...claims.map(c => c.claim)];

    const beliefs = this.extractBeliefs(allObservations);
    const goals = this.extractGoals(allObservations);
    const plannedActions = this.extractActions(allObservations);

    const observationCount = (existing?.observation_count ?? 0) + allObservations.length;
    const confidence = Math.min(0.95, 0.3 + observationCount * 0.05);

    const model: IntentModel = {
      agentId,
      beliefs,
      goals,
      plannedActions,
      confidence,
      observationCount,
      lastUpdated: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT OR REPLACE INTO agent_intent_models (agent_id, beliefs_json, goals_json, planned_actions_json, confidence, observation_count, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(agentId, JSON.stringify(beliefs), JSON.stringify(goals), JSON.stringify(plannedActions), confidence, observationCount);

    return model;
  }

  predictAgentAction(agentId: string, _context: Record<string, unknown> = {}): string {
    const model = this.db.prepare('SELECT * FROM agent_intent_models WHERE agent_id = ?').get(agentId) as IntentRow | undefined;
    if (!model) return 'unknown';

    const plannedActions = JSON.parse(model.planned_actions_json) as string[];
    if (plannedActions.length === 0) return 'observe';

    return plannedActions[0];
  }

  updateModel(agentId: string, actualAction: string): void {
    const model = this.db.prepare('SELECT * FROM agent_intent_models WHERE agent_id = ?').get(agentId) as IntentRow | undefined;
    if (!model) return;

    const plannedActions = JSON.parse(model.planned_actions_json) as string[];
    const wasCorrect = plannedActions.length > 0 && plannedActions[0] === actualAction;

    const confidence = wasCorrect
      ? Math.min(0.95, model.confidence + 0.05)
      : Math.max(0.1, model.confidence - 0.02);

    const updatedActions = plannedActions.filter(a => a !== actualAction);
    if (!wasCorrect) updatedActions.push(actualAction);

    this.db.prepare(`
      UPDATE agent_intent_models
      SET confidence = ?, planned_actions_json = ?, observation_count = observation_count + 1, last_updated = datetime('now')
      WHERE agent_id = ?
    `).run(confidence, JSON.stringify(updatedActions), agentId);
  }

  getIntentModel(agentId: string): IntentModel | null {
    const row = this.db.prepare('SELECT * FROM agent_intent_models WHERE agent_id = ?').get(agentId) as IntentRow | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      beliefs: JSON.parse(row.beliefs_json) as string[],
      goals: JSON.parse(row.goals_json) as string[],
      plannedActions: JSON.parse(row.planned_actions_json) as string[],
      confidence: row.confidence,
      observationCount: row.observation_count,
      lastUpdated: row.last_updated,
    };
  }

  getAllModels(): IntentModel[] {
    const rows = this.db.prepare('SELECT * FROM agent_intent_models ORDER BY confidence DESC').all() as IntentRow[];
    return rows.map(row => ({
      agentId: row.agent_id,
      beliefs: JSON.parse(row.beliefs_json) as string[],
      goals: JSON.parse(row.goals_json) as string[],
      plannedActions: JSON.parse(row.planned_actions_json) as string[],
      confidence: row.confidence,
      observationCount: row.observation_count,
      lastUpdated: row.last_updated,
    }));
  }

  private extractBeliefs(observations: string[]): string[] {
    const beliefs: string[] = [];
    for (const obs of observations) {
      if (obs.includes('error') || obs.includes('fail')) beliefs.push('task_has_issues');
      if (obs.includes('success') || obs.includes('complete')) beliefs.push('task_completed');
      if (obs.includes('test')) beliefs.push('testing_required');
      if (obs.includes('security')) beliefs.push('security_relevant');
    }
    return [...new Set(beliefs)];
  }

  private extractGoals(observations: string[]): string[] {
    const goals: string[] = [];
    for (const obs of observations) {
      if (obs.includes('fix')) goals.push('fix_issues');
      if (obs.includes('improve')) goals.push('improve_quality');
      if (obs.includes('add')) goals.push('add_features');
      if (obs.includes('document')) goals.push('improve_docs');
    }
    return [...new Set(goals)];
  }

  private extractActions(observations: string[]): string[] {
    const actions: string[] = [];
    for (const obs of observations) {
      if (obs.includes('code')) actions.push('write_code');
      if (obs.includes('test')) actions.push('run_tests');
      if (obs.includes('review')) actions.push('review_changes');
      if (obs.includes('deploy')) actions.push('deploy_changes');
    }
    return [...new Set(actions)];
  }
}
