import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { SelfModelService } from './self-model-service';

export interface Observation {
  id: string;
  runId: string;
  observationType: string;
  data: Record<string, unknown>;
  confidence: number;
  timestamp: string;
}

export interface Anomaly {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  runId: string;
}

export interface CalibrationResult {
  domain: string;
  bins: Array<{ predicted: number; observed: number; count: number }>;
  calibrationError: number;
  trend: 'improving' | 'stable' | 'degrading';
}

export interface QualityScore {
  runId: string;
  score: number;
  factors: Array<{ name: string; value: number }>;
}

interface ObservationRow {
  id: string;
  run_id: string;
  observation_type: string;
  data_json: string;
  confidence: number;
  created_at: string;
}

export class MetacognitiveObserver {
  constructor(
    private db: Database,
    private selfModel: SelfModelService,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metacognitive_observations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        observation_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mo_run ON metacognitive_observations(run_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mo_type ON metacognitive_observations(observation_type)');
  }

  observeRun(runId: string): Observation {
    const confidence = this.estimateConfidence(runId);
    const observation: Observation = {
      id: randomUUID(),
      runId,
      observationType: 'run_quality',
      data: { estimatedConfidence: confidence },
      confidence,
      timestamp: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO metacognitive_observations (id, run_id, observation_type, data_json, confidence)
      VALUES (?, ?, ?, ?, ?)
    `).run(observation.id, runId, observation.observationType, JSON.stringify(observation.data), confidence);

    return observation;
  }

  detectAnomalies(runId: string): Anomaly[] {
    const anomalies: Anomaly[] = [];

    try {
      const observations = this.db.prepare(
        'SELECT confidence, data_json FROM metacognitive_observations WHERE run_id = ? ORDER BY created_at DESC LIMIT 5'
      ).all(runId) as Array<{ confidence: number; data_json: string }>;

      if (observations.length === 0) return anomalies;

      const avgConfidence = observations.reduce((sum, o) => sum + o.confidence, 0) / observations.length;
      const run = this.db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(runId) as { status: string } | undefined;

      if (run && run.status === 'failed' && avgConfidence > 0.7) {
        anomalies.push({
          type: 'overconfidence',
          severity: 'high',
          description: `Run failed but confidence was ${(avgConfidence * 100).toFixed(0)}%`,
          runId,
        });
      }

      if (run && run.status === 'completed' && avgConfidence < 0.3) {
        anomalies.push({
          type: 'underconfidence',
          severity: 'medium',
          description: `Run succeeded but confidence was only ${(avgConfidence * 100).toFixed(0)}%`,
          runId,
        });
      }
    } catch { /* best-effort */ }

    return anomalies;
  }

  calibrateConfidence(domain: string): CalibrationResult {
    const calibration = this.selfModel.getCalibration(domain);
    return {
      domain,
      bins: calibration.confidenceBins.map(b => ({ predicted: b.predictedConfidence, observed: b.observedAccuracy, count: b.count })),
      calibrationError: calibration.calibrationError,
      trend: calibration.trend,
    };
  }

  getReasoningQuality(runId: string): QualityScore {
    const anomalies = this.detectAnomalies(runId);
    const baseScore = 1.0;
    const deductions = anomalies.reduce((sum, a) => {
      if (a.severity === 'high') return sum + 0.3;
      if (a.severity === 'medium') return sum + 0.15;
      return sum + 0.05;
    }, 0);

    return {
      runId,
      score: Math.max(0, baseScore - deductions),
      factors: anomalies.map(a => ({ name: a.type, value: a.severity === 'high' ? 0.3 : 0.15 })),
    };
  }

  getObservationsByType(type: string, limit: number = 20): Observation[] {
    const rows = this.db.prepare('SELECT * FROM metacognitive_observations WHERE observation_type = ? ORDER BY created_at DESC LIMIT ?').all(type, limit) as ObservationRow[];
    return rows.map(r => ({
      id: r.id,
      runId: r.run_id,
      observationType: r.observation_type,
      data: JSON.parse(r.data_json) as Record<string, unknown>,
      confidence: r.confidence,
      timestamp: r.created_at,
    }));
  }

  private estimateConfidence(runId: string): number {
    try {
      const leases = this.db.prepare('SELECT capability_id FROM worker_leases WHERE loop_run_id = ?').all(runId) as Array<{ capability_id: string | null }>;
      let totalConf = 0;
      let count = 0;
      for (const lease of leases) {
        if (lease.capability_id) {
          const cal = this.selfModel.getCalibration(lease.capability_id);
          totalConf += cal.recommendedConfidence;
          count++;
        }
      }
      return count > 0 ? totalConf / count : 0.5;
    } catch { return 0.5; }
  }
}
