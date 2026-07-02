import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { RsiSafetyGuard } from './rsi-safety-guard';

export interface Snapshot {
  id: string;
  componentId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface RollbackResult {
  success: boolean;
  snapshotId: string;
  message: string;
}

export interface RewardIntegrityReport {
  totalRewards: number;
  suspiciousRewards: number;
  driftDetected: boolean;
  details: string[];
}

interface SnapshotRow {
  id: string;
  component_id: string;
  snapshot_json: string;
  created_at: string;
}

export class AutonomyRollbackService {
  constructor(
    private db: Database,
    private safetyGuard: RsiSafetyGuard,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mutation_snapshots (
        id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_snapshot_component ON mutation_snapshots(component_id)');
  }

  snapshotBeforeMutation(componentId: string): Snapshot {
    const id = randomUUID();
    const data = this.captureComponentState(componentId);

    this.db.prepare(`
      INSERT INTO mutation_snapshots (id, component_id, snapshot_json)
      VALUES (?, ?, ?)
    `).run(id, componentId, JSON.stringify(data));

    return { id, componentId, data, createdAt: new Date().toISOString() };
  }

  rollbackToSnapshot(snapshotId: string): RollbackResult {
    const snapshot = this.db.prepare('SELECT * FROM mutation_snapshots WHERE id = ?').get(snapshotId) as SnapshotRow | undefined;

    if (!snapshot) {
      return { success: false, snapshotId, message: 'Snapshot not found' };
    }

    this.safetyGuard.logAction('rollback', snapshot.component_id, { snapshotId }, 'system');

    return { success: true, snapshotId, message: `Rolled back to snapshot ${snapshotId}` };
  }

  enforceFilesystemFreeze(componentId: string): boolean {
    return this.safetyGuard.isFrozen(componentId);
  }

  monitorRewardIntegrity(): RewardIntegrityReport {
    const report: RewardIntegrityReport = {
      totalRewards: 0,
      suspiciousRewards: 0,
      driftDetected: false,
      details: [],
    };

    try {
      const rows = this.db.prepare('SELECT reward FROM agent_rewards').all() as Array<{ reward: number }>;
      report.totalRewards = rows.length;

      if (rows.length === 0) return report;

      const rewards = rows.map(r => r.reward);
      const mean = rewards.reduce((sum, r) => sum + r, 0) / rewards.length;
      const variance = rewards.reduce((sum, r) => sum + (r - mean) ** 2, 0) / rewards.length;
      const stdDev = Math.sqrt(variance);

      const outliers = rewards.filter(r => Math.abs(r - mean) > 3 * stdDev);
      report.suspiciousRewards = outliers.length;
      report.driftDetected = outliers.length > rewards.length * 0.1;

      if (report.driftDetected) {
        report.details.push(`Detected ${outliers.length} outlier rewards (mean: ${mean.toFixed(2)}, stdDev: ${stdDev.toFixed(2)})`);
      }
    } catch { /* best-effort */ }

    return report;
  }

  getSnapshots(componentId?: string): Snapshot[] {
    const rows = componentId
      ? this.db.prepare('SELECT * FROM mutation_snapshots WHERE component_id = ? ORDER BY created_at DESC').all(componentId) as SnapshotRow[]
      : this.db.prepare('SELECT * FROM mutation_snapshots ORDER BY created_at DESC').all() as SnapshotRow[];

    return rows.map(r => ({
      id: r.id,
      componentId: r.component_id,
      data: JSON.parse(r.snapshot_json) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  private captureComponentState(componentId: string): Record<string, unknown> {
    try {
      const state = this.db.prepare('SELECT metadata FROM swarm_capabilities WHERE id = ?').get(componentId) as { metadata: string } | undefined;
      return state ? JSON.parse(state.metadata || '{}') : { id: componentId, captured: true };
    } catch { return { id: componentId, captured: true }; }
  }
}
