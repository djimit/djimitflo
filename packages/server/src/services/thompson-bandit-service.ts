import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface BanditArm {
  runtime: string;
  alpha: number;
  beta: number;
  totalTrials: number;
}

export interface BanditStats {
  capabilityId: string;
  arms: BanditArm[];
  bestRuntime: string;
  confidence: number;
}

interface BanditRow {
  runtime: string;
  alpha: number;
  beta: number;
  total_trials: number;
}

export class ThompsonBanditService {
  private decayFactor = 0.95;
  private decayInterval = 50; // trials between decays

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thompson_bandits (
        capability_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        alpha REAL NOT NULL DEFAULT 1.0,
        beta REAL NOT NULL DEFAULT 1.0,
        total_trials INTEGER NOT NULL DEFAULT 0,
        last_decay_at TEXT,
        PRIMARY KEY (capability_id, runtime)
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_bandit_capability ON thompson_bandits(capability_id)');
  }

  selectArm(capabilityId: string): string {
    const rows = this.db.prepare(
      'SELECT runtime, alpha, beta, total_trials FROM thompson_bandits WHERE capability_id = ?'
    ).all(capabilityId) as BanditRow[];

    if (rows.length === 0) return 'codex';

    let bestRuntime = rows[0].runtime;
    let bestSample = -1;

    for (const row of rows) {
      const sample = this.sampleBeta(row.alpha, row.beta);
      if (sample > bestSample) {
        bestSample = sample;
        bestRuntime = row.runtime;
      }
    }

    return bestRuntime;
  }

  recordOutcome(capabilityId: string, runtime: string, success: boolean): void {
    const existing = this.db.prepare(
      'SELECT alpha, beta, total_trials FROM thompson_bandits WHERE capability_id = ? AND runtime = ?'
    ).get(capabilityId, runtime) as BanditRow | undefined;

    if (!existing) {
      this.db.prepare(
        'INSERT INTO thompson_bandits (capability_id, runtime, alpha, beta, total_trials) VALUES (?, ?, ?, ?, 1)'
      ).run(
        capabilityId,
        runtime,
        success ? 2.0 : 1.0,
        success ? 1.0 : 2.0
      );
    } else {
      const newAlpha = success ? existing.alpha + 1 : existing.alpha;
      const newBeta = success ? existing.beta : existing.beta + 1;
      const newTrials = existing.total_trials + 1;

      this.db.prepare(
        'UPDATE thompson_bandits SET alpha = ?, beta = ?, total_trials = ? WHERE capability_id = ? AND runtime = ?'
      ).run(newAlpha, newBeta, newTrials, capabilityId, runtime);

      if (newTrials % this.decayInterval === 0) {
        this.decay(capabilityId, runtime);
      }
    }
  }

  getDistribution(capabilityId: string, runtime: string): BanditArm {
    const row = this.db.prepare(
      'SELECT runtime, alpha, beta, total_trials FROM thompson_bandits WHERE capability_id = ? AND runtime = ?'
    ).get(capabilityId, runtime) as BanditRow | undefined;

    if (!row) {
      return { runtime, alpha: 1, beta: 1, totalTrials: 0 };
    }

    return { runtime: row.runtime, alpha: row.alpha, beta: row.beta, totalTrials: row.total_trials };
  }

  getArmStats(capabilityId: string): BanditStats {
    const rows = this.db.prepare(
      'SELECT runtime, alpha, beta, total_trials FROM thompson_bandits WHERE capability_id = ?'
    ).all(capabilityId) as BanditRow[];

    const arms: BanditArm[] = rows.map(r => ({
      runtime: r.runtime,
      alpha: r.alpha,
      beta: r.beta,
      totalTrials: r.total_trials,
    }));

    let bestRuntime = 'codex';
    let bestMean = 0;
    let confidence = 0;

    for (const arm of arms) {
      const mean = arm.alpha / (arm.alpha + arm.beta);
      if (mean > bestMean) {
        bestMean = mean;
        bestRuntime = arm.runtime;
      }
    }

    if (arms.length > 0 && arms[0].totalTrials > 0) {
      confidence = Math.min(0.95, arms[0].totalTrials / 20);
    }

    return { capabilityId, arms, bestRuntime, confidence };
  }

  decayAll(factor: number = this.decayFactor): void {
    this.db.prepare(
      "UPDATE thompson_bandits SET alpha = MAX(1.0, alpha * ?), beta = MAX(1.0, beta * ?), last_decay_at = datetime('now')"
    ).run(factor, factor);
  }

  getTrialsCount(capabilityId: string): number {
    const row = this.db.prepare(
      'SELECT SUM(total_trials) as total FROM thompson_bandits WHERE capability_id = ?'
    ).get(capabilityId) as { total: number | null };
    return row.total ?? 0;
  }

  private decay(capabilityId: string, runtime: string): void {
    this.db.prepare(
      "UPDATE thompson_bandits SET alpha = MAX(1.0, alpha * ?), beta = MAX(1.0, beta * ?), last_decay_at = datetime('now') WHERE capability_id = ? AND runtime = ?"
    ).run(this.decayFactor, this.decayFactor, capabilityId, runtime);
  }

  private sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha, 1);
    const y = this.sampleGamma(beta, 1);
    return x / (x + y);
  }

  private sampleGamma(shape: number, scale: number): number {
    if (shape <= 0 || scale <= 0) return 0;

    if (shape < 1) {
      const u = Math.random();
      return this.sampleGamma(1 + shape, scale) * Math.pow(u, 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x: number;
      let v: number;
      do {
        x = this.randn();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * x * x * x * x) {
        return d * v * scale;
      }

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v * scale;
      }
    }
  }

  private randn(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
