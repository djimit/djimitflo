/**
 * SwarmCapabilityOpsService — capability lifecycle operations.
 *
 * Extracted from SwarmIntelligenceService (~180 LOC) to isolate the
 * capability registration, promotion, and evaluation logic.
 */

import type { Database } from 'better-sqlite3';
import { stringArray, normalizedScore, rejectSecretLike } from '../utils/swarm-helpers';
import { SkillTrainingPromotionGate } from './skill-training-promotion-gate';

type CapabilityKind = 'skill' | 'specialist_agent' | 'runtime_adapter' | 'deterministic_harness' | 'memory_source' | 'dashboard_action' | 'openai_agents_sdk' | 'openai_skill' | 'openai_mcp_connector';
type CapabilityStatus = 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';
const CAPABILITY_KINDS: CapabilityKind[] = ['skill', 'specialist_agent', 'runtime_adapter', 'deterministic_harness', 'memory_source', 'dashboard_action', 'openai_agents_sdk', 'openai_skill', 'openai_mcp_connector'];
const CAPABILITY_STATUSES: CapabilityStatus[] = ['draft', 'candidate', 'validated', 'deprecated', 'disabled'];
const RISK_CLASSES: RiskClass[] = ['low', 'medium', 'high', 'critical'];

export interface SwarmCapabilityRecord {
  id: string; kind: CapabilityKind; owner: string; version: string;
  status: CapabilityStatus; risk_ceiling: RiskClass;
  input_schema_ref: string; output_schema_ref: string;
  allowed_actions: string[]; forbidden_actions: string[];
  required_evidence: string[]; eval_score: number; eval_threshold: number;
  cost_model: Record<string, unknown>; removal_strategy: string;
  latest_validation_report: string | null; metadata: Record<string, unknown>;
  live_route_allowed: boolean; blocked_reasons: string[];
  created_at: string; updated_at: string;
}

export class SwarmCapabilityOpsService {
  private skillTrainingGate = new SkillTrainingPromotionGate();

  constructor(private db: Database) {}

  registerCapability(input: {
    id?: string; kind?: CapabilityKind; owner?: string; version?: string;
    status?: CapabilityStatus; risk_ceiling?: RiskClass;
    input_schema_ref?: string; output_schema_ref?: string;
    allowed_actions?: string[]; forbidden_actions?: string[];
    required_evidence?: string[]; eval_score?: number; eval_threshold?: number;
    cost_model?: Record<string, unknown>; removal_strategy?: string;
    latest_validation_report?: string | null; metadata?: Record<string, unknown>;
  }): SwarmCapabilityRecord {
    if (!input.id?.trim()) throw new Error('SWARM_CAPABILITY_ID_REQUIRED');
    if (!input.kind || !CAPABILITY_KINDS.includes(input.kind)) throw new Error('SWARM_CAPABILITY_KIND_INVALID');
    if (!input.owner?.trim()) throw new Error('SWARM_CAPABILITY_OWNER_REQUIRED');
    if (!input.version?.trim()) throw new Error('SWARM_CAPABILITY_VERSION_REQUIRED');
    if (!input.status || !CAPABILITY_STATUSES.includes(input.status)) throw new Error('SWARM_CAPABILITY_STATUS_INVALID');
    if (!input.risk_ceiling || !RISK_CLASSES.includes(input.risk_ceiling)) throw new Error('SWARM_CAPABILITY_RISK_INVALID');
    const allowed = stringArray(input.allowed_actions);
    const forbidden = stringArray(input.forbidden_actions);
    const evidence = stringArray(input.required_evidence);
    if (!input.input_schema_ref?.trim()) throw new Error('SWARM_CAPABILITY_INPUT_SCHEMA_REQUIRED');
    if (!input.output_schema_ref?.trim()) throw new Error('SWARM_CAPABILITY_OUTPUT_SCHEMA_REQUIRED');
    if (!allowed.length) throw new Error('SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED');
    if (!forbidden.length) throw new Error('SWARM_CAPABILITY_FORBIDDEN_ACTIONS_REQUIRED');
    if (!evidence.length) throw new Error('SWARM_CAPABILITY_REQUIRED_EVIDENCE_REQUIRED');
    if (!input.removal_strategy?.trim()) throw new Error('SWARM_CAPABILITY_REMOVAL_STRATEGY_REQUIRED');
    rejectSecretLike(input);

    const evalScore = normalizedScore(input.eval_score ?? 0);
    const evalThreshold = normalizedScore(input.eval_threshold ?? 0.75);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
        eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, owner = excluded.owner, version = excluded.version,
        status = excluded.status, risk_ceiling = excluded.risk_ceiling,
        input_schema_ref = excluded.input_schema_ref, output_schema_ref = excluded.output_schema_ref,
        allowed_actions_json = excluded.allowed_actions_json,
        forbidden_actions_json = excluded.forbidden_actions_json,
        required_evidence_json = excluded.required_evidence_json,
        eval_score = excluded.eval_score, eval_threshold = excluded.eval_threshold,
        cost_model_json = excluded.cost_model_json, removal_strategy = excluded.removal_strategy,
        latest_validation_report = excluded.latest_validation_report,
        metadata = excluded.metadata, updated_at = excluded.updated_at
    `).run(
      input.id.trim(), input.kind, input.owner.trim(), input.version.trim(),
      input.status, input.risk_ceiling, input.input_schema_ref.trim(),
      input.output_schema_ref.trim(), JSON.stringify(allowed), JSON.stringify(forbidden),
      JSON.stringify(evidence), evalScore, evalThreshold,
      JSON.stringify(input.cost_model || {}), input.removal_strategy.trim(),
      input.latest_validation_report || null, JSON.stringify(input.metadata || {}),
      now, now
    );
    return this.getCapability(input.id.trim())!;
  }

  createCandidate(input: any): SwarmCapabilityRecord {
    return this.registerCapability({ ...input, status: 'candidate', eval_score: 0 });
  }

  promoteCapability(id: string, input: {
    eval_score?: number; eval_scorecard_ref?: string; evidence_refs?: string[];
    security_checker_ref?: string; human_approval_ref?: string; validation_report?: string;
  }): SwarmCapabilityRecord {
    const capability = this.getCapability(id);
    if (!capability) throw new Error('SWARM_CAPABILITY_NOT_FOUND');
    const evalScore = normalizedScore(input.eval_score ?? capability.eval_score);
    if (evalScore < capability.eval_threshold) {
      throw new Error(`CAPABILITY_BELOW_EVAL_THRESHOLD:${id}:score=${evalScore}:threshold=${capability.eval_threshold}`);
    }
    if (!input.evidence_refs || input.evidence_refs.length === 0) throw new Error('CAPABILITY_PROMOTION_EVIDENCE_REQUIRED');
    if (capability.risk_ceiling === 'high' || capability.risk_ceiling === 'critical') {
      if (!input.security_checker_ref?.trim()) throw new Error('CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED');
      if (!input.human_approval_ref?.trim()) throw new Error('CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
    }
    rejectSecretLike(input);
    const skillTrainingGate = this.skillTrainingGate.assertPass(capability);
    const now = new Date().toISOString();
    const metadata = {
      ...capability.metadata,
      promotion_evidence_refs: input.evidence_refs,
      promotion_eval_scorecard_ref: input.eval_scorecard_ref,
      promotion_security_checker_ref: input.security_checker_ref || null,
      promotion_human_approval_ref: input.human_approval_ref || null,
      promotion_skill_training_gate_ref: skillTrainingGate.evidenceRef,
      promoted_at: now,
    };
    this.db.prepare(`
      UPDATE swarm_capabilities
      SET status = 'validated', eval_score = ?, latest_validation_report = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(evalScore, input.validation_report || null, JSON.stringify(metadata), now, id);
    return this.getCapability(id)!;
  }

  listCapabilities(maxResults = 100): SwarmCapabilityRecord[] {
    const limit = Math.max(1, Math.min(maxResults, 500));
    return (this.db.prepare('SELECT * FROM swarm_capabilities ORDER BY updated_at DESC, id ASC LIMIT ?').all(limit) as any[])
      .map((row) => this.parseCapability(row));
  }

  getCapability(id: string): SwarmCapabilityRecord {
    const row = this.db.prepare('SELECT * FROM swarm_capabilities WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_CAPABILITY_NOT_FOUND');
    return this.parseCapability(row);
  }

  private parseCapability(row: any): SwarmCapabilityRecord {
    return {
      id: row.id, kind: row.kind, owner: row.owner, version: row.version,
      status: row.status, risk_ceiling: row.risk_ceiling,
      input_schema_ref: row.input_schema_ref, output_schema_ref: row.output_schema_ref,
      allowed_actions: JSON.parse(row.allowed_actions_json || '[]'),
      forbidden_actions: JSON.parse(row.forbidden_actions_json || '[]'),
      required_evidence: JSON.parse(row.required_evidence_json || '[]'),
      eval_score: row.eval_score, eval_threshold: row.eval_threshold,
      cost_model: JSON.parse(row.cost_model_json || '{}'),
      removal_strategy: row.removal_strategy,
      latest_validation_report: row.latest_validation_report,
      metadata: JSON.parse(row.metadata || '{}'),
      live_route_allowed: false, blocked_reasons: [],
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }
}
