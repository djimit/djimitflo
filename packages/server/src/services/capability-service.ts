/**
 * CapabilityService — capability registration, promotion, and evaluation.
 *
 * Extracted from SwarmIntelligenceService (Phase B1 decomposition).
 * Handles: capability lifecycle, competence measurement, auto-promotion.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

type CapabilityKind = 'skill' | 'specialist_agent' | 'runtime_adapter' | 'deterministic_harness' | 'memory_source' | 'dashboard_action' | 'openai_agents_sdk' | 'openai_skill' | 'openai_mcp_connector';
type CapabilityStatus = 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';

export interface SwarmCapabilityRecord {
  id: string;
  kind: CapabilityKind;
  owner: string;
  version: string;
  status: CapabilityStatus;
  risk_ceiling: RiskClass;
  input_schema_ref: string;
  output_schema_ref: string;
  allowed_actions: string[];
  forbidden_actions: string[];
  required_evidence: string[];
  eval_score: number;
  eval_threshold: number;
  cost_model: Record<string, unknown>;
  removal_strategy: string;
  latest_validation_report: string | null;
  metadata: Record<string, unknown>;
  live_route_allowed: boolean;
  blocked_reasons: string[];
  created_at: string;
  updated_at: string;
}

export interface CapabilityInput {
  kind: CapabilityKind;
  owner: string;
  version: string;
  status?: CapabilityStatus;
  risk_ceiling?: RiskClass;
  input_schema_ref?: string;
  output_schema_ref?: string;
  allowed_actions?: string[];
  forbidden_actions?: string[];
  required_evidence?: string[];
  eval_threshold?: number;
  cost_model?: Record<string, unknown>;
  removal_strategy?: string;
  metadata?: Record<string, unknown>;
  live_route_allowed?: boolean;
}

export class CapabilityService {
  constructor(private db: Database) {}

  registerCapability(input: CapabilityInput): SwarmCapabilityRecord {
    this.validateCapabilityInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const status = input.status || 'candidate';
    const riskCeiling = input.risk_ceiling || 'low';

    this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
        eval_threshold, cost_model_json, removal_strategy, metadata_json, live_route_allowed,
        blocked_reasons_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id, input.kind, input.owner, input.version, status, riskCeiling,
      input.input_schema_ref || '', input.output_schema_ref || '',
      JSON.stringify(input.allowed_actions || []), JSON.stringify(input.forbidden_actions || []),
      JSON.stringify(input.required_evidence || []), input.eval_threshold || 0.8,
      JSON.stringify(input.cost_model || {}), input.removal_strategy || 'manual_review',
      JSON.stringify(input.metadata || {}), input.live_route_allowed ? 1 : 0, now, now
    );

    return this.getCapability(id)!;
  }

  createCandidate(input: Partial<CapabilityInput> & { kind: CapabilityKind; owner: string }): SwarmCapabilityRecord {
    return this.registerCapability({ ...input, status: 'candidate' } as CapabilityInput);
  }

  promoteCapability(id: string, _input: { evidence_refs?: string[]; approved_by?: string }): SwarmCapabilityRecord {
    const existing = this.getCapability(id);
    if (!existing) throw new Error('SWARM_CAPABILITY_NOT_FOUND');
    if (existing.status === 'validated') return existing;

    const now = new Date().toISOString();
    this.db.prepare("UPDATE swarm_capabilities SET status = 'validated', updated_at = ? WHERE id = ?").run(now, id);

    return this.getCapability(id)!;
  }

  listCapabilities(limit = 100): SwarmCapabilityRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_capabilities ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(parseCapability);
  }

  getCapability(id: string): SwarmCapabilityRecord | null {
    const row = this.db.prepare('SELECT * FROM swarm_capabilities WHERE id = ?').get(id) as any;
    return row ? parseCapability(row) : null;
  }

  evaluateCapability(id: string): { capability: SwarmCapabilityRecord; scorecard: Record<string, unknown>; status: 'passed' | 'failed' } {
    const capability = this.getCapability(id);
    if (!capability) throw new Error('SWARM_CAPABILITY_NOT_FOUND');

    const competence = this.measureCompetence(id);
    const scorecard = {
      competence,
      eval_score: capability.eval_score,
      eval_threshold: capability.eval_threshold,
      live_route_allowed: capability.live_route_allowed,
    };

    return { capability, scorecard, status: capability.eval_score >= capability.eval_threshold ? 'passed' : 'failed' };
  }

  measureCompetence(capabilityId: string): {
    n_runs: number;
    n_completed: number;
    success_rate: number;
    p50_cost: number | null;
    p95_cost: number | null;
  } {
    const runs = (this.db.prepare(`
      SELECT metadata FROM worker_leases WHERE capability_id = ?
    `).all(capabilityId) as Array<{ metadata: string }>);

    let totalTokens = 0;
    let completed = 0;
    for (const run of runs) {
      try {
        const meta = JSON.parse(run.metadata);
        if (meta.runtime_usage?.total_tokens) totalTokens += meta.runtime_usage.total_tokens;
        if (meta.verdict === 'accepted' || meta.status === 'completed') completed++;
      } catch { /* skip */ }
    }

    return {
      n_runs: runs.length,
      n_completed: completed,
      success_rate: runs.length > 0 ? completed / runs.length : 0,
      p50_cost: runs.length > 0 ? totalTokens / runs.length : null,
      p95_cost: null,
    };
  }

  autoPromoteFromEvidence(capabilityId: string, opts: { minSuccesses?: number; minSuccessRate?: number } = {}): {
    promoted: boolean;
    reason: string;
  } {
    const capability = this.getCapability(capabilityId);
    if (!capability) return { promoted: false, reason: 'Capability not found' };
    if (capability.status === 'validated') return { promoted: false, reason: 'Already validated' };

    const minSuccesses = opts.minSuccesses ?? 3;
    const minSuccessRate = opts.minSuccessRate ?? 0.8;
    const competence = this.measureCompetence(capabilityId);

    if (competence.n_completed < minSuccesses) {
      return { promoted: false, reason: `Need ${minSuccesses} successes, have ${competence.n_completed}` };
    }
    if (competence.success_rate < minSuccessRate) {
      return { promoted: false, reason: `Success rate ${competence.success_rate.toFixed(2)} below threshold ${minSuccessRate}` };
    }

    this.promoteCapability(capabilityId, {});
    return { promoted: true, reason: 'Auto-promoted based on evidence' };
  }

  private validateCapabilityInput(input: { kind: string; owner: string }): void {
    const validKinds: string[] = ['skill', 'specialist_agent', 'runtime_adapter', 'deterministic_harness', 'memory_source', 'dashboard_action', 'openai_agents_sdk', 'openai_skill', 'openai_mcp_connector'];
    if (!validKinds.includes(input.kind)) throw new Error(`SWARM_CAPABILITY_KIND_INVALID: ${input.kind}`);
    if (!input.owner?.trim()) throw new Error('SWARM_CAPABILITY_OWNER_REQUIRED');
  }
}

function parseCapability(row: any): SwarmCapabilityRecord {
  return {
    id: row.id,
    kind: row.kind,
    owner: row.owner,
    version: row.version,
    status: row.status,
    risk_ceiling: row.risk_ceiling,
    input_schema_ref: row.input_schema_ref,
    output_schema_ref: row.output_schema_ref,
    allowed_actions: JSON.parse(row.allowed_actions_json || '[]'),
    forbidden_actions: JSON.parse(row.forbidden_actions_json || '[]'),
    required_evidence: JSON.parse(row.required_evidence_json || '[]'),
    eval_score: row.eval_score,
    eval_threshold: row.eval_threshold,
    cost_model: JSON.parse(row.cost_model_json || '{}'),
    removal_strategy: row.removal_strategy,
    latest_validation_report: row.latest_validation_report,
    metadata: JSON.parse(row.metadata_json || '{}'),
    live_route_allowed: Boolean(row.live_route_allowed),
    blocked_reasons: JSON.parse(row.blocked_reasons_json || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
