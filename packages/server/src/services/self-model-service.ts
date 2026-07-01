import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface ConfidenceBin {
  bin: number;
  predictedConfidence: number;
  observedAccuracy: number;
  count: number;
}

export interface CapabilityCalibration {
  capabilityId: string;
  nRuns: number;
  observedSuccessRate: number;
  meanPredictedConfidence: number;
  calibrationError: number;
  confidenceBins: ConfidenceBin[];
  recommendedConfidence: number;
  trend: 'improving' | 'stable' | 'degrading';
  lastCalibratedAt: string;
}

export interface KnownUnknown {
  domain: string;
  reason: string;
  detectedAt: string;
  nAttempts: number;
  recommendedAction: string;
}

export interface SelfModel {
  version: number;
  lastUpdated: string;
  capabilityCalibration: Record<string, CapabilityCalibration>;
  knownUnknowns: KnownUnknown[];
}

interface LeaseRow {
  status: string;
  confidence: number;
  created_at: string;
}

interface CapabilityRow {
  id: string;
}

export class SelfModelService {
  private modelVersion = 0;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_model_snapshots (
        id TEXT PRIMARY KEY,
        model_json TEXT NOT NULL,
        calibration_error REAL NOT NULL,
        known_unknowns_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  calibrate(capabilityId: string): CapabilityCalibration {
    const rows = this.queryLeases(capabilityId);

    const nRuns = rows.length;
    const now = new Date().toISOString();

    if (nRuns === 0) {
      return {
        capabilityId,
        nRuns: 0,
        observedSuccessRate: 0,
        meanPredictedConfidence: 0.5,
        calibrationError: 0,
        confidenceBins: [],
        recommendedConfidence: 0.5,
        trend: 'stable',
        lastCalibratedAt: now,
      };
    }

    let successes = 0;
    const bins: ConfidenceBin[] = Array.from({ length: 10 }, (_, i) => ({
      bin: i,
      predictedConfidence: (i + 0.5) / 10,
      observedAccuracy: 0,
      count: 0,
    }));
    const binCounts = new Array(10).fill(0);
    const binSuccesses = new Array(10).fill(0);

    let totalConfidence = 0;

    for (const row of rows) {
      const success = row.status === 'completed' ? 1 : 0;
      successes += success;
      totalConfidence += row.confidence;

      const binIdx = Math.min(9, Math.floor(row.confidence * 10));
      binCounts[binIdx]++;
      binSuccesses[binIdx] += success;
    }

    for (let i = 0; i < 10; i++) {
      bins[i].count = binCounts[i];
      bins[i].observedAccuracy = binCounts[i] > 0 ? binSuccesses[i] / binCounts[i] : 0;
    }

    const observedSuccessRate = successes / nRuns;
    const meanPredictedConfidence = totalConfidence / nRuns;

    let calibrationError = 0;
    let binsWithData = 0;
    for (const bin of bins) {
      if (bin.count >= 3) {
        calibrationError += Math.abs(bin.predictedConfidence - bin.observedAccuracy);
        binsWithData++;
      }
    }
    calibrationError = binsWithData > 0 ? calibrationError / binsWithData : 0;

    const recommendedConfidence = this.plattScale(observedSuccessRate, calibrationError);
    const trend = this.detectTrendFromRows(rows);

    return {
      capabilityId,
      nRuns,
      observedSuccessRate,
      meanPredictedConfidence,
      calibrationError,
      confidenceBins: bins.filter(b => b.count > 0),
      recommendedConfidence,
      trend,
      lastCalibratedAt: now,
    };
  }

  getCalibration(capabilityId: string): CapabilityCalibration {
    return this.calibrate(capabilityId);
  }

  getKnownUnknowns(): KnownUnknown[] {
    const caps = this.db.prepare('SELECT id FROM swarm_capabilities').all() as CapabilityRow[];
    const unknowns: KnownUnknown[] = [];
    const now = new Date().toISOString();

    for (const cap of caps) {
      const cal = this.calibrate(cap.id);
      if (cal.nRuns < 3) {
        unknowns.push({
          domain: cap.id,
          reason: `insufficient_data: only ${cal.nRuns} runs (min 3 required)`,
          detectedAt: now,
          nAttempts: cal.nRuns,
          recommendedAction: `Execute more loop runs for capability '${cap.id}' to establish calibration baseline.`,
        });
      } else if (cal.calibrationError > 0.2) {
        unknowns.push({
          domain: cap.id,
          reason: `high_calibration_error: ${cal.calibrationError.toFixed(2)} (threshold 0.2)`,
          detectedAt: now,
          nAttempts: cal.nRuns,
          recommendedAction: `Review capability '${cap.id}' — predicted confidence does not match observed outcomes.`,
        });
      }
    }

    return unknowns;
  }

  detectTrend(capabilityId: string): 'improving' | 'stable' | 'degrading' {
    const rows = this.queryLeases(capabilityId).slice(-10);
    return this.detectTrendFromRows(rows);
  }

  private queryLeases(capabilityId: string): LeaseRow[] {
    try {
      return this.db.prepare(`
        SELECT status, COALESCE(confidence, 0.5) as confidence, created_at
        FROM worker_leases
        WHERE capability_id = ?
        ORDER BY created_at ASC
      `).all(capabilityId) as LeaseRow[];
    } catch {
      return this.db.prepare(`
        SELECT status, 0.5 as confidence, created_at
        FROM worker_leases
        WHERE capability_id = ?
        ORDER BY created_at ASC
      `).all(capabilityId) as LeaseRow[];
    }
  }

  snapshot(): void {
    const model = this.getModel();
    const avgCalibrationError = Object.values(model.capabilityCalibration)
      .reduce((sum, c) => sum + c.calibrationError, 0) / Math.max(1, Object.keys(model.capabilityCalibration).length);

    this.db.prepare(`
      INSERT INTO self_model_snapshots (id, model_json, calibration_error, known_unknowns_count, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(
      randomUUID(),
      JSON.stringify(model),
      avgCalibrationError,
      model.knownUnknowns.length,
    );
  }

  getModel(): SelfModel {
    const caps = this.db.prepare('SELECT id FROM swarm_capabilities').all() as CapabilityRow[];
    const calibration: Record<string, CapabilityCalibration> = {};

    for (const cap of caps) {
      calibration[cap.id] = this.calibrate(cap.id);
    }

    this.modelVersion++;

    return {
      version: this.modelVersion,
      lastUpdated: new Date().toISOString(),
      capabilityCalibration: calibration,
      knownUnknowns: this.getKnownUnknowns(),
    };
  }

  private plattScale(observedSuccessRate: number, calibrationError: number): number {
    if (calibrationError < 0.05) return observedSuccessRate;
    const rawOdds = (observedSuccessRate + 0.01) / (1.02 - observedSuccessRate);
    const calibrated = 1 / (1 + Math.exp(-(rawOdds - 1) * (1 - calibrationError)));
    return Math.max(0.05, Math.min(0.95, calibrated));
  }

  private detectTrendFromRows(rows: LeaseRow[]): 'improving' | 'stable' | 'degrading' {
    if (rows.length < 3) return 'stable';

    const outcomes = rows.map(r => r.status === 'completed' ? 1 : 0);
    const n = outcomes.length;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += outcomes[i];
      sumXY += i * outcomes[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / Math.max(1, (n * sumX2 - sumX * sumX));

    if (slope > 0.05) return 'improving';
    if (slope < -0.05) return 'degrading';
    return 'stable';
  }
}
