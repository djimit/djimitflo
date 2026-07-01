import type { Database } from 'better-sqlite3';

export type ConsensusStatus = 'confirmed' | 'falsified' | 'contested' | 'pending';

export interface ConsensusResult {
  claimId: string;
  status: ConsensusStatus;
  confidence: number;
  supportWeight: number;
  contradictWeight: number;
}

interface EdgeRow {
  from_ref: string;
  to_ref: string;
  relation: string;
}

interface ClaimRow {
  id: string;
  status: string;
  confidence: number;
  contradicts_ref: string | null;
}

export class DAGConsensusService {
  private consensusThreshold = 1.5;

  constructor(private db: Database) {}

  resolveConsensus(claimId: string): ConsensusResult {
    const claim = this.db.prepare('SELECT id, status, confidence, contradicts_ref FROM swarm_claims WHERE id = ?').get(claimId) as ClaimRow | undefined;

    if (!claim) {
      return { claimId, status: 'pending', confidence: 0, supportWeight: 0, contradictWeight: 0 };
    }

    const edges = this.db.prepare(
      'SELECT from_ref, to_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?'
    ).all(claimId) as EdgeRow[];

    let supportWeight = 0;
    let contradictWeight = 0;

    for (const edge of edges) {
      const source = this.db.prepare('SELECT confidence FROM swarm_claims WHERE id = ?').get(edge.from_ref) as { confidence: number } | undefined;
      const sourceConf = source?.confidence ?? 0.5;

      if (edge.relation === 'supports') {
        supportWeight += sourceConf;
      } else if (edge.relation === 'contradicts') {
        contradictWeight += sourceConf;
      }
    }

    if (claim.contradicts_ref) {
      contradictWeight += 0.5;
    }

    let dbStatus: string;
    let consensusStatus: ConsensusStatus;
    if (supportWeight > contradictWeight * this.consensusThreshold) {
      dbStatus = 'supported';
      consensusStatus = 'confirmed';
    } else if (contradictWeight > supportWeight * this.consensusThreshold) {
      dbStatus = 'rejected';
      consensusStatus = 'falsified';
    } else if (supportWeight > 0 || contradictWeight > 0) {
      dbStatus = 'review_required';
      consensusStatus = 'contested';
    } else {
      dbStatus = 'proposed';
      consensusStatus = 'pending';
    }

    const total = supportWeight + contradictWeight;
    const confidence = total > 0 ? supportWeight / total : 0.5;

    this.db.prepare('UPDATE swarm_claims SET status = ?, confidence = ? WHERE id = ?').run(dbStatus, confidence, claimId);

    return { claimId, status: consensusStatus, confidence, supportWeight, contradictWeight };
  }

  runConsensusRound(): { confirmed: number; falsified: number; contested: number; pending: number } {
    const claims = this.db.prepare("SELECT id FROM swarm_claims WHERE status IN ('proposed', 'supported', 'contradicted')").all() as Array<{ id: string }>;

    let confirmed = 0, falsified = 0, contested = 0, pending = 0;

    for (const claim of claims) {
      const result = this.resolveConsensus(claim.id);
      if (result.status === 'confirmed') confirmed++;
      else if (result.status === 'falsified') falsified++;
      else if (result.status === 'contested') contested++;
      else pending++;
    }

    return { confirmed, falsified, contested, pending };
  }

  getConsensusStatus(claimId: string): ConsensusStatus {
    const claim = this.db.prepare('SELECT status FROM swarm_claims WHERE id = ?').get(claimId) as { status: string } | undefined;
    if (!claim) return 'pending';
    switch (claim.status) {
      case 'supported': return 'confirmed';
      case 'rejected': return 'falsified';
      case 'review_required': return 'contested';
      default: return 'pending';
    }
  }

  getConfidence(claimId: string): number {
    const claim = this.db.prepare('SELECT confidence FROM swarm_claims WHERE id = ?').get(claimId) as { confidence: number } | undefined;
    return claim?.confidence ?? 0;
  }

  getByzantineTolerance(totalNodes: number, maliciousNodes: number): boolean {
    return maliciousNodes < totalNodes / 3;
  }
}
