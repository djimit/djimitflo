import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface InfluenceRecord {
  leaseId: string;
  loopRunId: string;
  influence: number;
  claimsConfirmed: number;
  utility: number;
}

interface InfluenceRow {
  lease_id: string;
  loop_run_id: string;
  influence: number;
  claims_confirmed: number;
  utility: number;
  created_at: string;
}

interface LeaseRow {
  id: string;
  capability_id: string;
  metadata: string;
}

interface ClaimRow {
  id: string;
  confidence: number;
  status: string;
  created_from: string;
}

export class InfluenceAttributionService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS influence_attribution (
        id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        loop_run_id TEXT NOT NULL,
        influence REAL NOT NULL,
        claims_confirmed INTEGER NOT NULL DEFAULT 0,
        utility REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_influence_run ON influence_attribution(loop_run_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_influence_lease ON influence_attribution(lease_id)');
  }

  attributeInfluence(loopRunId: string): InfluenceRecord[] {
    const leases = this.db.prepare(
      "SELECT id, capability_id, metadata FROM worker_leases WHERE loop_run_id = ? AND role = 'maker'"
    ).all(loopRunId) as LeaseRow[];

    if (leases.length === 0) return [];

    const utilityMap = new Map<string, number>();
    let totalUtility = 0;

    for (const lease of leases) {
      const claims = this.db.prepare(
        'SELECT id, confidence, status, created_from FROM swarm_claims WHERE created_from = ?'
      ).get(lease.id) as ClaimRow | undefined;

      let utility = 0;
      if (claims && claims.status === 'supported') {
        utility = claims.confidence;
      }

      utilityMap.set(lease.id, utility);
      totalUtility += utility;
    }

    if (totalUtility === 0) {
      const equalShare = 1 / leases.length;
      for (const lease of leases) {
        utilityMap.set(lease.id, equalShare);
      }
      totalUtility = 1;
    }

    const records: InfluenceRecord[] = [];
    for (const lease of leases) {
      const utility = utilityMap.get(lease.id) ?? 0;
      const influence = utility / totalUtility;

      this.db.prepare(`
        INSERT INTO influence_attribution (id, lease_id, loop_run_id, influence, claims_confirmed, utility)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), lease.id, loopRunId, influence, utility > 0 ? 1 : 0, utility);

      records.push({ leaseId: lease.id, loopRunId, influence, claimsConfirmed: utility > 0 ? 1 : 0, utility });
    }

    return records;
  }

  getAgentInfluence(agentId: string): number {
    const row = this.db.prepare(`
      SELECT AVG(influence) as avg_influence FROM influence_attribution WHERE lease_id = ?
    `).get(agentId) as { avg_influence: number | null };
    return row.avg_influence ?? 0;
  }

  getTopContributors(loopRunId: string, limit: number = 5): InfluenceRecord[] {
    const rows = this.db.prepare(`
      SELECT lease_id, loop_run_id, influence, claims_confirmed, utility
      FROM influence_attribution
      WHERE loop_run_id = ?
      ORDER BY influence DESC
      LIMIT ?
    `).all(loopRunId, limit) as Array<{ lease_id: string; loop_run_id: string; influence: number; claims_confirmed: number; utility: number }>;

    return rows.map(r => ({
      leaseId: r.lease_id,
      loopRunId: r.loop_run_id,
      influence: r.influence,
      claimsConfirmed: r.claims_confirmed,
      utility: r.utility,
    }));
  }

  getRunInfluence(loopRunId: string): InfluenceRecord[] {
    const rows = this.db.prepare(`
      SELECT lease_id, loop_run_id, influence, claims_confirmed, utility
      FROM influence_attribution
      WHERE loop_run_id = ?
      ORDER BY influence DESC
    `).all(loopRunId) as Array<{ lease_id: string; loop_run_id: string; influence: number; claims_confirmed: number; utility: number }>;

    return rows.map(r => ({
      leaseId: r.lease_id,
      loopRunId: r.loop_run_id,
      influence: r.influence,
      claimsConfirmed: r.claims_confirmed,
      utility: r.utility,
    }));
  }
}
