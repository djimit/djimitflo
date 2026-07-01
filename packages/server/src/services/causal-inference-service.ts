import type { Database } from 'better-sqlite3';

export interface CausalPrediction {
  predictedSuccessRate: number;
  confidence: number;
  evidence: number;
}

export interface RuntimeComparison {
  a: { successRate: number; cost: number; nRuns: number };
  b: { successRate: number; cost: number; nRuns: number };
  recommendation: string;
  confidence: number;
}

interface ParsedObservation {
  runtime: string;
  capability_type: string;
  success: number;
}

export class CausalInferenceService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS causal_observations (
        id TEXT PRIMARY KEY,
        features_json TEXT NOT NULL,
        outcome INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  recordObservation(features: Record<string, string>, outcome: number): void {
    try {
      this.db.prepare(`
        INSERT INTO causal_observations (id, features_json, outcome, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(this.generateId(), JSON.stringify(features), outcome);
    } catch { /* table may not exist */ }
  }

  predictIntervention(intervention: Record<string, string>): CausalPrediction {
    const observations = this.getParsedObservations();
    if (observations.length < 5) {
      return { predictedSuccessRate: 0.5, confidence: 0.1, evidence: observations.length };
    }

    const capType = intervention.capability_type || intervention.capability_id || '';
    const similar = observations.filter(o =>
      (!intervention.runtime || o.runtime === intervention.runtime) &&
      (!capType || o.capability_type === capType)
    );

    if (similar.length < 3) {
      return { predictedSuccessRate: 0.5, confidence: 0.2, evidence: similar.length };
    }

    const successes = similar.filter(o => o.success === 1).length;
    const rate = successes / similar.length;
    const confidence = Math.min(0.9, similar.length / 20);

    return { predictedSuccessRate: rate, confidence, evidence: similar.length };
  }

  compareRuntimes(capabilityId: string, runtimeA: string, runtimeB: string): RuntimeComparison {
    const observations = this.getParsedObservations();

    const aObs = observations.filter(o => o.capability_type === capabilityId && o.runtime === runtimeA);
    const bObs = observations.filter(o => o.capability_type === capabilityId && o.runtime === runtimeB);

    const aRate = aObs.length > 0 ? aObs.filter(o => o.success === 1).length / aObs.length : 0;
    const bRate = bObs.length > 0 ? bObs.filter(o => o.success === 1).length / bObs.length : 0;

    let recommendation: string;
    if (aRate > bRate + 0.1) recommendation = runtimeA;
    else if (bRate > aRate + 0.1) recommendation = runtimeB;
    else recommendation = aObs.length >= bObs.length ? runtimeA : runtimeB;

    const confidence = Math.min(0.8, (aObs.length + bObs.length) / 20);

    return {
      a: { successRate: aRate, cost: 0, nRuns: aObs.length },
      b: { successRate: bRate, cost: 0, nRuns: bObs.length },
      recommendation,
      confidence,
    };
  }

  private getParsedObservations(): ParsedObservation[] {
    try {
      const rows = this.db.prepare('SELECT features_json, outcome FROM causal_observations').all() as Array<{ features_json: string; outcome: number }>;
      return rows.map(r => {
        try {
          const features = JSON.parse(r.features_json) as Record<string, string>;
          return { runtime: features.runtime || '', capability_type: features.capability_type || '', success: r.outcome };
        } catch { return { runtime: '', capability_type: '', success: r.outcome }; }
      });
    } catch { return []; }
  }

  private generateId(): string {
    return 'causal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }
}
