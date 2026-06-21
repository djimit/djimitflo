import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface CapabilityContract {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  side_effects: string[];
  token_budget: number;
  wall_clock_budget_ms: number;
}

export interface SwarmCapability {
  id: string;
  kind: 'skill' | 'specialist' | 'loop_template';
  name: string;
  version: string;
  owner: string;
  status: 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
  risk_ceiling: 'low' | 'medium' | 'high' | 'critical';
  contract: CapabilityContract;
  eval_score?: number;
  eval_evidence_refs?: string[];
  allowed_actions: string[];
  forbidden_actions: string[];
  metadata: {
    created_by: string;
    created_at: string;
    promoted_at?: string;
    promoted_by?: string;
    last_executed_at?: string;
    execution_count: number;
  };
  created_at: string;
  updated_at: string;
}

export interface CreateCapabilityInput {
  kind: 'skill' | 'specialist' | 'loop_template';
  name: string;
  version: string;
  risk_ceiling: 'low' | 'medium' | 'high' | 'critical';
  contract: CapabilityContract;
  allowed_actions?: string[];
  forbidden_actions?: string[];
}

export class CapabilityRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a new capability in draft status with input validation.
   */
  create(input: CreateCapabilityInput, ownerUserId: string): SwarmCapability {
    if (!input.name || !input.name.trim()) {
      throw new Error('CAPABILITY_NAME_REQUIRED');
    }
    if (!input.version || !/^\d+\.\d+\.\d+/.test(input.version)) {
      throw new Error('CAPABILITY_VERSION_INVALID');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, name, version, owner, status, risk_ceiling,
        contract, allowed_actions, forbidden_actions, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metadata = {
      created_by: ownerUserId,
      created_at: now,
      execution_count: 0,
    };

    stmt.run(
      id,
      input.kind,
      input.name,
      input.version,
      ownerUserId,
      'draft',
      input.risk_ceiling,
      JSON.stringify(input.contract),
      JSON.stringify(input.allowed_actions || []),
      JSON.stringify(input.forbidden_actions || []),
      JSON.stringify(metadata),
      now,
      now
    );

    return this.getById(id)!;
  }

  /**
   * Fetch capability by ID.
   */
  getById(id: string): SwarmCapability | null {
    const stmt = this.db.prepare(`
      SELECT * FROM swarm_capabilities WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    return row ? this.deserialize(row) : null;
  }

  /**
   * List capabilities with optional filters.
   */
  list(filters?: {
    kind?: string;
    status?: string;
    owner?: string;
    name?: string;
  }): SwarmCapability[] {
    let query = 'SELECT * FROM swarm_capabilities WHERE 1=1';
    const params: any[] = [];

    if (filters?.kind) {
      query += ' AND kind = ?';
      params.push(filters.kind);
    }
    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.owner) {
      query += ' AND owner = ?';
      params.push(filters.owner);
    }
    if (filters?.name) {
      query += ' AND name LIKE ?';
      params.push(`%${filters.name}%`);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => this.deserialize(row));
  }

  /**
   * Promote capability status with validation rules.
   * Valid transitions:
   * - draft → candidate
   * - candidate → validated (requires eval_score >= 80)
   * - candidate → draft
   * - validated → deprecated
   * - validated → disabled
   * - deprecated → disabled
   */
  promote(id: string, to_status: 'candidate' | 'validated' | 'deprecated' | 'disabled', promoted_by: string): SwarmCapability {
    const capability = this.getById(id);
    if (!capability) {
      throw new Error('CAPABILITY_NOT_FOUND');
    }

    const validTransitions: Record<string, string[]> = {
      draft: ['candidate'],
      candidate: ['validated', 'draft'],
      validated: ['deprecated', 'disabled'],
      deprecated: ['disabled'],
      disabled: [],
    };

    if (!validTransitions[capability.status].includes(to_status)) {
      throw new Error(`INVALID_STATUS_TRANSITION: ${capability.status} → ${to_status}`);
    }

    if (to_status === 'validated' && (!capability.eval_score || capability.eval_score < 80)) {
      throw new Error('EVAL_THRESHOLD_NOT_MET: require eval_score >= 80');
    }

    const now = new Date().toISOString();
    const metadata = capability.metadata;
    if (to_status === 'validated') {
      metadata.promoted_at = now;
      metadata.promoted_by = promoted_by;
    }

    const stmt = this.db.prepare(`
      UPDATE swarm_capabilities
      SET status = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(to_status, JSON.stringify(metadata), now, id);
    return this.getById(id)!;
  }

  /**
   * Update eval score (0–100) and evidence references.
   */
  updateEvalScore(id: string, eval_score: number, evidence_refs: string[]): SwarmCapability {
    if (eval_score < 0 || eval_score > 100) {
      throw new Error('EVAL_SCORE_OUT_OF_RANGE');
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE swarm_capabilities
      SET eval_score = ?, eval_evidence_refs = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(eval_score, JSON.stringify(evidence_refs), now, id);
    return this.getById(id)!;
  }

  /**
   * Check if capability can route workers (only validated status).
   */
  canRoute(id: string): boolean {
    const capability = this.getById(id);
    if (!capability) return false;

    return capability.status === 'validated';
  }

  /**
   * Record execution: increment execution count and update last_executed_at.
   */
  recordExecution(id: string, _tokens_used: number): void {
    const capability = this.getById(id);
    if (!capability) {
      throw new Error('CAPABILITY_NOT_FOUND');
    }

    const now = new Date().toISOString();
    const metadata = capability.metadata;
    metadata.last_executed_at = now;
    metadata.execution_count += 1;

    const stmt = this.db.prepare(`
      UPDATE swarm_capabilities
      SET metadata = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(JSON.stringify(metadata), now, id);
  }

  private deserialize(row: any): SwarmCapability {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      version: row.version,
      owner: row.owner,
      status: row.status,
      risk_ceiling: row.risk_ceiling,
      contract: JSON.parse(row.contract),
      eval_score: row.eval_score,
      eval_evidence_refs: row.eval_evidence_refs ? JSON.parse(row.eval_evidence_refs) : undefined,
      allowed_actions: JSON.parse(row.allowed_actions),
      forbidden_actions: JSON.parse(row.forbidden_actions),
      metadata: JSON.parse(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
