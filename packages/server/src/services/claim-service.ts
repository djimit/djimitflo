/**
 * ClaimService — evidence-based claims ledger with lineage tracking.
 *
 * Extracted from SwarmIntelligenceService (Phase B1 decomposition).
 * Handles: claim creation, evidence edges, lineage queries.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type ClaimType = 'observation' | 'hypothesis' | 'decision' | 'memory' | 'capability' | 'backlog' | 'policy';
type ClaimStatus = 'proposed' | 'supported' | 'contradicted' | 'resolved' | 'rejected' | 'promoted' | 'review_required';

export interface ClaimLedgerRecord {
  id: string;
  claim: string;
  predicate: string | null;
  object: string | null;
  scope: string | null;
  claim_type: ClaimType;
  subject_ref: string;
  evidence_refs: string[];
  confidence: number;
  valid_until: string | null;
  status: ClaimStatus;
  verified_by_gate: string | null;
  invalidated_by: string | null;
  supports_ref: string | null;
  contradicts_ref: string | null;
  created_from: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class ClaimService {
  constructor(private db: Database) {}

  createClaim(input: {
    claim: string;
    claim_type: ClaimType;
    subject_ref: string;
    evidence_refs?: string[];
    confidence?: number;
    valid_until?: string | null;
    predicate?: string | null;
    object?: string | null;
    scope?: string | null;
    supports_ref?: string | null;
    contradicts_ref?: string | null;
    created_from: string;
    metadata?: Record<string, unknown>;
  }): ClaimLedgerRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO swarm_claims (
        id, claim, predicate, object, scope, claim_type, subject_ref,
        evidence_refs_json, confidence, valid_until, status, created_from,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)
    `).run(
      id, input.claim, input.predicate || null, input.object || null, input.scope || null,
      input.claim_type, input.subject_ref, JSON.stringify(input.evidence_refs || []),
      input.confidence ?? 0.5, input.valid_until || null, input.created_from,
      JSON.stringify(input.metadata || {}), now, now
    );

    return this.getClaim(id)!;
  }

  getClaim(id: string): ClaimLedgerRecord | null {
    const row = this.db.prepare('SELECT * FROM swarm_claims WHERE id = ?').get(id) as any;
    return row ? parseClaim(row) : null;
  }

  listClaims(limit = 100): ClaimLedgerRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_claims ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(parseClaim);
  }

  createEvidenceEdge(fromRef: string, toRef: string, relation: string, metadata: Record<string, unknown> = {}): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO swarm_evidence_edges (id, from_ref, to_ref, relation, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, fromRef, toRef, relation, JSON.stringify(metadata), new Date().toISOString());
    return id;
  }

  lineageForward(ref: string, maxDepth = 10): { ref: string; edges: Array<{ to: string; relation: string; depth: number }> } {
    const edges: Array<{ to: string; relation: string; depth: number }> = [];
    const visited = new Set<string>();
    let currentLevel = [ref];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextLevel: string[] = [];
      for (const node of currentLevel) {
        if (visited.has(node)) continue;
        visited.add(node);

        const rows = this.db.prepare('SELECT to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ?').all(node) as Array<{ to_ref: string; relation: string }>;
        for (const row of rows) {
          edges.push({ to: row.to_ref, relation: row.relation, depth });
          if (!visited.has(row.to_ref)) nextLevel.push(row.to_ref);
        }
      }
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    return { ref, edges };
  }

  lineageReverse(ref: string, maxDepth = 10): { ref: string; edges: Array<{ from: string; relation: string; depth: number }> } {
    const edges: Array<{ from: string; relation: string; depth: number }> = [];
    const visited = new Set<string>();
    let currentLevel = [ref];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextLevel: string[] = [];
      for (const node of currentLevel) {
        if (visited.has(node)) continue;
        visited.add(node);

        const rows = this.db.prepare('SELECT from_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?').all(node) as Array<{ from_ref: string; relation: string }>;
        for (const row of rows) {
          edges.push({ from: row.from_ref, relation: row.relation, depth });
          if (!visited.has(row.from_ref)) nextLevel.push(row.from_ref);
        }
      }
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    return { ref, edges };
  }

  evidenceGraphSummary(ref: string): { ref: string; forward_count: number; reverse_count: number; forward: Array<{ to: string; relation: string }>; reverse: Array<{ from: string; relation: string }> } {
    const forward = this.db.prepare('SELECT to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ?').all(ref) as Array<{ to_ref: string; relation: string }>;
    const reverse = this.db.prepare('SELECT from_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?').all(ref) as Array<{ from_ref: string; relation: string }>;

    return {
      ref,
      forward_count: forward.length,
      reverse_count: reverse.length,
      forward: forward.map((e) => ({ to: e.to_ref, relation: e.relation })),
      reverse: reverse.map((e) => ({ from: e.from_ref, relation: e.relation })),
    };
  }
}

function parseClaim(row: any): ClaimLedgerRecord {
  return {
    id: row.id,
    claim: row.claim,
    predicate: row.predicate,
    object: row.object,
    scope: row.scope,
    claim_type: row.claim_type,
    subject_ref: row.subject_ref,
    evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
    confidence: row.confidence,
    valid_until: row.valid_until,
    status: row.status,
    verified_by_gate: row.verified_by_gate,
    invalidated_by: row.invalidated_by,
    supports_ref: row.supports_ref,
    contradicts_ref: row.contradicts_ref,
    created_from: row.created_from,
    metadata: JSON.parse(row.metadata_json || '{}'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
