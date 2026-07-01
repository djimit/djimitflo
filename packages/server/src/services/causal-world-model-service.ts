import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface CausalEdge {
  id: string;
  cause: string;
  effect: string;
  strength: number;
  evidence: number;
  mechanism: string;
}

export interface CausalQuery {
  intervention: Record<string, string>;
  outcome: string;
  predictedProbability: number;
  confidence: number;
}

export interface CounterfactualQuery {
  observedFacts: Record<string, string>;
  counterfactualChange: Record<string, string>;
  predictedOutcome: string;
  probability: number;
}

interface CausalEdgeRow {
  id: string;
  cause: string;
  effect: string;
  strength: number;
  evidence: number;
  mechanism: string;
}

export class CausalWorldModelService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS causal_model_edges (
        id TEXT PRIMARY KEY,
        cause TEXT NOT NULL,
        effect TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        evidence INTEGER NOT NULL DEFAULT 1,
        mechanism TEXT NOT NULL DEFAULT 'correlation',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS causal_observations (
        id TEXT PRIMARY KEY,
        cause TEXT NOT NULL,
        effect TEXT NOT NULL,
        outcome INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS counterfactual_log (
        id TEXT PRIMARY KEY,
        observed_json TEXT NOT NULL,
        counterfactual_json TEXT NOT NULL,
        predicted_outcome TEXT NOT NULL,
        probability REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_causal_cause ON causal_model_edges(cause)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_causal_effect ON causal_model_edges(effect)');
  }

  learnFromOutcome(cause: string, effect: string, success: boolean): void {
    const outcome = success ? 1 : 0;

    this.db.prepare(`
      INSERT INTO causal_observations (id, cause, effect, outcome)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), cause, effect, outcome);

    const existing = this.db.prepare(
      'SELECT id, strength, evidence FROM causal_model_edges WHERE cause = ? AND effect = ?'
    ).get(cause, effect) as CausalEdgeRow | undefined;

    if (existing) {
      const newStrength = (existing.strength * existing.evidence + outcome) / (existing.evidence + 1);
      this.db.prepare(`
        UPDATE causal_model_edges SET strength = ?, evidence = evidence + 1, updated_at = datetime('now') WHERE id = ?
      `).run(newStrength, existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO causal_model_edges (id, cause, effect, strength, evidence, mechanism)
        VALUES (?, ?, ?, ?, 1, 'learned')
      `).run(randomUUID(), cause, effect, outcome === 1 ? 0.8 : 0.2);
    }
  }

  predictIntervention(intervention: Record<string, string>, outcome: string): CausalQuery {
    let maxProb = 0;
    let totalConfidence = 0;
    let matchCount = 0;

    for (const [cause, value] of Object.entries(intervention)) {
      const edge = this.db.prepare(
        'SELECT strength, evidence FROM causal_model_edges WHERE cause = ? AND effect = ?'
      ).get(cause, outcome) as { strength: number; evidence: number } | undefined;

      if (edge) {
        const weight = value === 'true' || value === '1' ? 1 : 0;
        maxProb = Math.max(maxProb, edge.strength * weight);
        totalConfidence += Math.min(1, edge.evidence / 10);
        matchCount++;
      }
    }

    const confidence = matchCount > 0 ? totalConfidence / matchCount : 0.1;

    return {
      intervention,
      outcome,
      predictedProbability: maxProb,
      confidence,
    };
  }

  predictCounterfactual(observed: Record<string, string>, change: Record<string, string>, outcome: string): CounterfactualQuery {
    const baseProb = this.calculateBaseProbability(observed, outcome);
    const changedProb = this.calculateBaseProbability({ ...observed, ...change }, outcome);

    const delta = changedProb - baseProb;
    const predictedOutcome = delta > 0 ? outcome : 'no_' + outcome;

    this.db.prepare(`
      INSERT INTO counterfactual_log (id, observed_json, counterfactual_json, predicted_outcome, probability)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), JSON.stringify(observed), JSON.stringify(change), predictedOutcome, Math.abs(delta));

    return {
      observedFacts: observed,
      counterfactualChange: change,
      predictedOutcome,
      probability: Math.min(1, Math.max(0, Math.abs(delta))),
    };
  }

  getCausalEdges(node: string): CausalEdge[] {
    const rows = this.db.prepare(
      'SELECT * FROM causal_model_edges WHERE cause = ? OR effect = ? ORDER BY strength DESC'
    ).all(node, node) as CausalEdgeRow[];
    return rows.map(r => ({
      id: r.id,
      cause: r.cause,
      effect: r.effect,
      strength: r.strength,
      evidence: r.evidence,
      mechanism: r.mechanism,
    }));
  }

  getStrongestCauses(effect: string, limit: number = 5): CausalEdge[] {
    const rows = this.db.prepare(
      'SELECT * FROM causal_model_edges WHERE effect = ? ORDER BY strength DESC LIMIT ?'
    ).all(effect, limit) as CausalEdgeRow[];
    return rows.map(r => ({
      id: r.id,
      cause: r.cause,
      effect: r.effect,
      strength: r.strength,
      evidence: r.evidence,
      mechanism: r.mechanism,
    }));
  }

  getModelSize(): { edges: number; observations: number } {
    const edges = this.db.prepare('SELECT COUNT(*) as c FROM causal_model_edges').get() as { c: number };
    const obs = this.db.prepare('SELECT COUNT(*) as c FROM causal_observations').get() as { c: number };
    return { edges: edges.c, observations: obs.c };
  }

  private calculateBaseProbability(facts: Record<string, string>, outcome: string): number {
    let prob = 0.5;
    let count = 0;

    for (const [cause, value] of Object.entries(facts)) {
      const edge = this.db.prepare(
        'SELECT strength FROM causal_model_edges WHERE cause = ? AND effect = ?'
      ).get(cause, outcome) as { strength: number } | undefined;

      if (edge) {
        const weight = value === 'true' || value === '1' ? 1 : 0;
        prob += (edge.strength - 0.5) * weight;
        count++;
      }
    }

    return count > 0 ? Math.min(1, Math.max(0, prob / count + 0.5)) : 0.5;
  }
}
