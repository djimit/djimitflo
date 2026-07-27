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
  nPredictions: number;
  observedSuccessRate: number;
  successInterval95: [number, number] | null;
  meanPredictedConfidence: number | null;
  calibrationError: number | null;
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
  confidence: number | null;
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
        nPredictions: 0,
        observedSuccessRate: 0,
        successInterval95: null,
        meanPredictedConfidence: null,
        calibrationError: null,
        confidenceBins: [],
        recommendedConfidence: 0.5,
        trend: 'stable',
        lastCalibratedAt: now,
      };
    }

    const successes = rows.filter((row) => row.status === 'completed').length;
    const predictedRows = rows.filter((row): row is LeaseRow & { confidence: number } => row.confidence !== null);
    const bins: ConfidenceBin[] = Array.from({ length: 10 }, (_, i) => ({
      bin: i,
      predictedConfidence: (i + 0.5) / 10,
      observedAccuracy: 0,
      count: 0,
    }));
    const binCounts = new Array(10).fill(0);
    const binSuccesses = new Array(10).fill(0);

    let totalConfidence = 0;
    for (const row of predictedRows) {
      const success = row.status === 'completed' ? 1 : 0;
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
    const meanPredictedConfidence = predictedRows.length > 0 ? totalConfidence / predictedRows.length : null;

    let calibrationError: number | null = null;
    let errorTotal = 0;
    let binsWithData = 0;
    for (const bin of bins) {
      if (bin.count >= 3) {
        errorTotal += Math.abs(bin.predictedConfidence - bin.observedAccuracy);
        binsWithData++;
      }
    }
    if (binsWithData > 0) calibrationError = errorTotal / binsWithData;

    const recommendedConfidence = calibrationError === null
      ? observedSuccessRate
      : this.plattScale(observedSuccessRate, calibrationError);
    const trend = this.detectTrendFromRows(rows);

    return {
      capabilityId,
      nRuns,
      nPredictions: predictedRows.length,
      observedSuccessRate,
      successInterval95: this.wilsonInterval(successes, nRuns),
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
      } else if (cal.nPredictions < 3) {
        unknowns.push({
          domain: cap.id,
          reason: `missing_predictions: only ${cal.nPredictions} recorded predictions for ${cal.nRuns} outcomes`,
          detectedAt: now,
          nAttempts: cal.nRuns,
          recommendedAction: `Record predicted_confidence in worker lease metadata for capability '${cap.id}'.`,
        });
      } else if (cal.calibrationError !== null && cal.calibrationError > 0.2) {
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
    const hasLegacyConfidence = (this.db.prepare("SELECT 1 FROM pragma_table_info('worker_leases') WHERE name = 'confidence'").get() as unknown) !== undefined;
    const rows = this.db.prepare(`
      SELECT status, metadata, created_at${hasLegacyConfidence ? ', confidence' : ''}
      FROM worker_leases
      WHERE capability_id = ?
      ORDER BY created_at ASC
    `).all(capabilityId) as Array<{ status: string; metadata?: string; created_at: string; confidence?: number }>;
    return rows.map((row) => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>; } catch { /* malformed metadata has no prediction */ }
      const value = metadata.predicted_confidence ?? metadata.confidence ?? row.confidence;
      const confidence = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
      return { status: row.status, confidence, created_at: row.created_at };
    });
  }

  snapshot(): void {
    const model = this.getModel();
    const errors = Object.values(model.capabilityCalibration)
      .map((calibration) => calibration.calibrationError)
      .filter((error): error is number => error !== null);
    const avgCalibrationError = errors.reduce((sum, error) => sum + error, 0) / Math.max(1, errors.length);

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

  private wilsonInterval(successes: number, total: number): [number, number] | null {
    if (total === 0) return null;
    const z = 1.96;
    const rate = successes / total;
    const denominator = 1 + z * z / total;
    const center = (rate + z * z / (2 * total)) / denominator;
    const margin = z * Math.sqrt((rate * (1 - rate) + z * z / (4 * total)) / total) / denominator;
    return [Math.max(0, center - margin), Math.min(1, center + margin)];
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
