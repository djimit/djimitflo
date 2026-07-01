import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { swarmEventBus } from './swarm-event-bus';
import { knowledgeBus } from './knowledge-bus';
import { SwarmStatusService, type WorkerPoolPlanInput, type WorkerPoolPlanResult } from './swarm-status-service';
import { SpecialistPanelService, type SpecialistProfile } from './specialist-panel-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

type CapabilityKind = 'skill' | 'specialist_agent' | 'runtime_adapter' | 'deterministic_harness' | 'memory_source' | 'dashboard_action' | 'openai_agents_sdk' | 'openai_skill' | 'openai_mcp_connector';
type CapabilityStatus = 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type ClaimType = 'observation' | 'hypothesis' | 'decision' | 'memory' | 'capability' | 'backlog' | 'policy';
type ClaimStatus = 'proposed' | 'supported' | 'contradicted' | 'resolved' | 'rejected' | 'promoted' | 'review_required';
type RunnerManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';

const CAPABILITY_KINDS: CapabilityKind[] = ['skill', 'specialist_agent', 'runtime_adapter', 'deterministic_harness', 'memory_source', 'dashboard_action', 'openai_agents_sdk', 'openai_skill', 'openai_mcp_connector'];
const CAPABILITY_STATUSES: CapabilityStatus[] = ['draft', 'candidate', 'validated', 'deprecated', 'disabled'];
const RISK_CLASSES: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const CLAIM_TYPES: ClaimType[] = ['observation', 'hypothesis', 'decision', 'memory', 'capability', 'backlog', 'policy'];
const RUNNER_ACTIONS: RunnerManifestAction[] = ['plan', 'start', 'skip', 'fail', 'stop', 'kill', 'complete'];

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

export interface CapacityPlanV2Result extends WorkerPoolPlanResult {
  queue_classes: Record<string, number>;
  fair_share_order: string[];
  audit_manifest_preview: Array<{
    decision_id: string;
    lease_id: string;
    action: 'start' | 'skip';
    policy_version: string;
    blocked_reasons: string[];
    queue_class: string;
  }>;
}

export interface RunnerManifestRecord {
  id: string;
  decision_id: string;
  lease_id: string | null;
  loop_run_id: string | null;
  action: RunnerManifestAction;
  policy_version: string;
  runtime_contract: Record<string, unknown>;
  capacity_snapshot: Record<string, unknown>;
  budget_snapshot: Record<string, unknown>;
  gate_refs: string[];
  blocked_reasons: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export class SwarmIntelligenceService {
  private panels: SpecialistPanelService;

  constructor(private db: Database) {
    this.panels = new SpecialistPanelService(db);
  }

  private swarmStatus(): SwarmStatusService {
    return new SwarmStatusService(this.db);
  }

  missionControl() {
    // G15.9: Avoid duplicate runtime status probes — cache the status snapshot
    const statusService = this.swarmStatus();
    const status = statusService.getStatus();
    const capabilities = this.listCapabilities(100);
    const claims = this.listClaims(100);
    // Pass the already-fetched status to avoid a duplicate probe inside planCapacityV2
    const capacity = this.planCapacityV2({}, statusService);
    const panels = this.panels.listPanels(25);
    const manifests = this.listRunnerManifests(25);

    return {
      execution_node: {
        cockpit: this.resolveNodeLabel('COCKPIT_LABEL', 'MacBook dashboard'),
        workers_run_on: this.resolveNodeLabel('WORKSTATION_LABEL', 'workstation'),
        active_execution_requires_runtime_evidence: true,
      },
      swarm_truth: {
        registry_agent_count: status.registry_agent_count,
        live_agent_count: status.live_agent_count,
        prepared_leases: status.fleet_pools.reduce((sum, pool) => sum + pool.prepared_leases, 0),
        running_leases: status.fleet_pools.reduce((sum, pool) => sum + pool.running_leases, 0),
        active_execution_count: status.active_execution_count,
        registry_is_not_execution: true,
      },
      capability_health: {
        total: capabilities.length,
        validated: capabilities.filter((capability) => capability.status === 'validated').length,
        routable: capabilities.filter((capability) => capability.live_route_allowed).length,
        blocked: capabilities.filter((capability) => capability.blocked_reasons.length > 0).length,
      },
      claim_health: {
        total: claims.length,
        proposed: claims.filter((claim) => claim.status === 'proposed').length,
        supported: claims.filter((claim) => claim.status === 'supported').length,
        contradicted: claims.filter((claim) => claim.status === 'contradicted').length,
        review_required: claims.filter((claim) => claim.status === 'review_required').length,
      },
      specialist_panels: {
        total: panels.length,
        consensus_ready: panels.filter((panel) => panel.status === 'consensus_ready').length,
        blocked_or_needs_evidence: panels.filter((panel) => ['blocked', 'needs_more_evidence'].includes(panel.consensus.decision)).length,
      },
      capacity,
      integration_spine: this.integrationSpineSummary(),
      production_pilot: this.productionPilotSummary(),
      latest_runner_manifests: manifests,
      next_safe_actions: this.nextSafeActions(capabilities, claims, capacity),
    };
  }

  registerCapability(input: {
    id?: string;
    kind?: CapabilityKind;
    owner?: string;
    version?: string;
    status?: CapabilityStatus;
    risk_ceiling?: RiskClass;
    input_schema_ref?: string;
    output_schema_ref?: string;
    allowed_actions?: string[];
    forbidden_actions?: string[];
    required_evidence?: string[];
    eval_score?: number;
    eval_threshold?: number;
    cost_model?: Record<string, unknown>;
    removal_strategy?: string;
    latest_validation_report?: string | null;
    metadata?: Record<string, unknown>;
  }): SwarmCapabilityRecord {
    if (!input.id?.trim()) throw new Error('SWARM_CAPABILITY_ID_REQUIRED');
    if (!input.kind || !CAPABILITY_KINDS.includes(input.kind)) throw new Error('SWARM_CAPABILITY_KIND_INVALID');
    if (!input.owner?.trim()) throw new Error('SWARM_CAPABILITY_OWNER_REQUIRED');
    if (!input.version?.trim()) throw new Error('SWARM_CAPABILITY_VERSION_REQUIRED');
    if (!input.status || !CAPABILITY_STATUSES.includes(input.status)) throw new Error('SWARM_CAPABILITY_STATUS_INVALID');
    if (!input.risk_ceiling || !RISK_CLASSES.includes(input.risk_ceiling)) throw new Error('SWARM_CAPABILITY_RISK_INVALID');
    const allowed = this.stringArray(input.allowed_actions);
    const forbidden = this.stringArray(input.forbidden_actions);
    const evidence = this.stringArray(input.required_evidence);
    if (!input.input_schema_ref?.trim()) throw new Error('SWARM_CAPABILITY_INPUT_SCHEMA_REQUIRED');
    if (!input.output_schema_ref?.trim()) throw new Error('SWARM_CAPABILITY_OUTPUT_SCHEMA_REQUIRED');
    if (!allowed.length) throw new Error('SWARM_CAPABILITY_ALLOWED_ACTIONS_REQUIRED');
    if (!forbidden.length) throw new Error('SWARM_CAPABILITY_FORBIDDEN_ACTIONS_REQUIRED');
    if (!evidence.length) throw new Error('SWARM_CAPABILITY_REQUIRED_EVIDENCE_REQUIRED');
    if (!input.removal_strategy?.trim()) throw new Error('SWARM_CAPABILITY_REMOVAL_STRATEGY_REQUIRED');
    this.rejectSecretLike(input);

    const evalScore = this.normalizedScore(input.eval_score ?? 0);
    const evalThreshold = this.normalizedScore(input.eval_threshold ?? 0.75);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
        eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        owner = excluded.owner,
        version = excluded.version,
        status = excluded.status,
        risk_ceiling = excluded.risk_ceiling,
        input_schema_ref = excluded.input_schema_ref,
        output_schema_ref = excluded.output_schema_ref,
        allowed_actions_json = excluded.allowed_actions_json,
        forbidden_actions_json = excluded.forbidden_actions_json,
        required_evidence_json = excluded.required_evidence_json,
        eval_score = excluded.eval_score,
        eval_threshold = excluded.eval_threshold,
        cost_model_json = excluded.cost_model_json,
        removal_strategy = excluded.removal_strategy,
        latest_validation_report = excluded.latest_validation_report,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      input.id.trim(),
      input.kind,
      input.owner.trim(),
      input.version.trim(),
      input.status,
      input.risk_ceiling,
      input.input_schema_ref.trim(),
      input.output_schema_ref.trim(),
      JSON.stringify(allowed),
      JSON.stringify(forbidden),
      JSON.stringify(evidence),
      evalScore,
      evalThreshold,
      JSON.stringify(input.cost_model || {}),
      input.removal_strategy.trim(),
      input.latest_validation_report || null,
      JSON.stringify(input.metadata || {}),
      now,
      now
    );
    return this.getCapability(input.id.trim());
  }

  // G15.2: Split candidate creation from validated promotion
  createCandidate(input: {
    id?: string;
    kind?: CapabilityKind;
    owner?: string;
    version?: string;
    risk_ceiling?: RiskClass;
    input_schema_ref?: string;
    output_schema_ref?: string;
    allowed_actions?: string[];
    forbidden_actions?: string[];
    required_evidence?: string[];
    eval_threshold?: number;
    removal_strategy?: string;
    metadata?: Record<string, unknown>;
  }): SwarmCapabilityRecord {
    return this.registerCapability({
      ...input,
      status: 'candidate',
      eval_score: 0,
    });
  }

  promoteCapability(id: string, input: {
    eval_score?: number;
    eval_scorecard_ref?: string;
    evidence_refs?: string[];
    security_checker_ref?: string;
    human_approval_ref?: string;
    validation_report?: string;
  }): SwarmCapabilityRecord {
    const capability = this.getCapability(id);
    if (!capability) throw new Error('SWARM_CAPABILITY_NOT_FOUND');

    // Require eval score above threshold
    const evalScore = this.normalizedScore(input.eval_score ?? capability.eval_score);
    if (evalScore < capability.eval_threshold) {
      throw new Error(`CAPABILITY_BELOW_EVAL_THRESHOLD:${id}:score=${evalScore}:threshold=${capability.eval_threshold}`);
    }

    // Require evidence refs for promotion
    if (!input.evidence_refs || input.evidence_refs.length === 0) {
      throw new Error('CAPABILITY_PROMOTION_EVIDENCE_REQUIRED');
    }

    // High/critical risk requires security checker + human approval
    if (capability.risk_ceiling === 'high' || capability.risk_ceiling === 'critical') {
      if (!input.security_checker_ref?.trim()) {
        throw new Error('CAPABILITY_PROMOTION_SECURITY_CHECKER_REQUIRED');
      }
      if (!input.human_approval_ref?.trim()) {
        throw new Error('CAPABILITY_PROMOTION_HUMAN_APPROVAL_REQUIRED');
      }
    }

    this.rejectSecretLike(input);
    const now = new Date().toISOString();
    const metadata = {
      ...capability.metadata,
      promotion_evidence_refs: input.evidence_refs,
      promotion_eval_scorecard_ref: input.eval_scorecard_ref,
      promotion_security_checker_ref: input.security_checker_ref || null,
      promotion_human_approval_ref: input.human_approval_ref || null,
      promoted_at: now,
    };

    this.db.prepare(`
      UPDATE swarm_capabilities
      SET status = 'validated', eval_score = ?, latest_validation_report = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(evalScore, input.validation_report || null, JSON.stringify(metadata), now, id);

    return this.getCapability(id);
  }

  listCapabilities(limit = 100): SwarmCapabilityRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_capabilities ORDER BY updated_at DESC, id ASC LIMIT ?').all(this.limit(limit)) as any[])
      .map((row) => this.parseCapability(row));
  }

  getCapability(id: string): SwarmCapabilityRecord {
    const row = this.db.prepare('SELECT * FROM swarm_capabilities WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_CAPABILITY_NOT_FOUND');
    return this.parseCapability(row);
  }

  evaluateCapability(id: string): { capability: SwarmCapabilityRecord; scorecard: Record<string, unknown>; status: 'passed' | 'failed' } {
    const capability = this.getCapability(id);
    const checks = {
      has_allowed_actions: capability.allowed_actions.length > 0,
      has_forbidden_actions: capability.forbidden_actions.length > 0,
      has_required_evidence: capability.required_evidence.length > 0,
      has_removal_strategy: capability.removal_strategy.trim().length > 0,
      eval_score_meets_threshold: capability.eval_score >= capability.eval_threshold,
      live_route_allowed: capability.live_route_allowed,
    };
    const passedCount = Object.values(checks).filter(Boolean).length;
    const score = passedCount / Object.keys(checks).length;
    const now = new Date().toISOString();
    const metadata = { ...capability.metadata, latest_eval_scorecard: checks, latest_eval_score: score, evaluated_at: now };
    this.db.prepare('UPDATE swarm_capabilities SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), now, id);
    return {
      capability: this.getCapability(id),
      scorecard: { checks, score, external_writes: 0 },
      status: score >= 0.75 ? 'passed' : 'failed',
    };
  }

  // G1: Competence measurement — success_rate + cost distribution per capability, from the
  // worker_leases that exercised it (linked by capability_id). Persisted into the capability's
  // metadata.competence so the planner can assign specialists by competence (the market).
  measureCompetence(capabilityId: string): {
    n_runs: number; n_completed: number; success_rate: number;
    p50_cost: number; p95_cost: number; costs: number[];
  } {
    const rows = this.db.prepare('SELECT status, metadata FROM worker_leases WHERE capability_id = ?')
      .all(capabilityId) as Array<{ status: string; metadata: string }>;
    const costs: number[] = [];
    let n_completed = 0;
    for (const r of rows) {
      if (r.status === 'completed') {
        n_completed += 1;
        let m: Record<string, unknown> = {}; try { m = JSON.parse(r.metadata || '{}') as Record<string, unknown>; } catch { /* empty */ }
        const usage = m.runtime_usage as Record<string, unknown> | undefined;
        const total = Number(usage?.total_tokens) || 0;
        if (total > 0) costs.push(total);
      }
    }
    const n_runs = rows.length;
    const success_rate = n_runs > 0 ? n_completed / n_runs : 0;
    costs.sort((a, b) => a - b);
    const pct = (p: number): number => costs.length
      ? costs[Math.min(costs.length - 1, Math.floor(p * costs.length))]
      : 0;
    const competence = { n_runs, n_completed, success_rate, p50_cost: pct(0.5), p95_cost: pct(0.95), costs };
    const cap = this.getCapability(capabilityId);
    const now = new Date().toISOString();
    const metadata = { ...cap.metadata, competence, competence_measured_at: now };
    // G6.4: learned cost model — update cost_model_json with the observed cost distribution
    // so the planner can allocate budget by (competence, cost) — the economy.
    // G13: dollar-denominated cost model — compute dollar costs from token costs
    // using the runtime's price per million tokens (env-configurable).
    const dollarPrice = (runtime: string): number => {
      const prices: Record<string, number> = {
        codex: Number(process.env.CODEX_PRICE_PER_MTOK) || 2.0,
        opencode: Number(process.env.OPENCODE_PRICE_PER_MTOK) || 1.0,
        pi: 0, claude: Number(process.env.CLAUDE_PRICE_PER_MTOK) || 3.0,
        gemini: Number(process.env.GEMINI_PRICE_PER_MTOK) || 1.5, mock: 0, manual: 0, editor: 0,
      };
      return prices[runtime] ?? 0;
    };
    const learnedCostModel = {
      ...cap.cost_model,
      learned: true,
      p50_tokens: competence.p50_cost,
      p95_tokens: competence.p95_cost,
      // G13: dollar-denominated costs for the economy.
      p50_dollars: (competence.p50_cost / 1_000_000) * dollarPrice(String(cap.metadata?.runtime ?? 'codex')),
      p95_dollars: (competence.p95_cost / 1_000_000) * dollarPrice(String(cap.metadata?.runtime ?? 'codex')),
      n_runs: competence.n_runs,
      success_rate: competence.success_rate,
    };
    this.db.prepare('UPDATE swarm_capabilities SET metadata = ?, cost_model_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), JSON.stringify(learnedCostModel), now, capabilityId);
    // G1.5: auto-deprecation — a skill whose success_rate drops below 0.5 (with >=3 runs)
    // is auto-demoted to 'deprecated' (the removal_strategy fires). This prevents the
    // planner from assigning a failing skill at full trust.
    if (competence.n_runs >= 3 && competence.success_rate < 0.5 && cap.status === 'validated') {
      this.db.prepare('UPDATE swarm_capabilities SET status = ?, updated_at = ? WHERE id = ?')
        .run('deprecated', now, capabilityId);
      swarmEventBus.emit('capability_transition', {
        capability_id: capabilityId,
        old_status: 'validated',
        new_status: 'deprecated',
        reason: `success_rate ${competence.success_rate.toFixed(2)} < 0.5 after ${competence.n_runs} runs`,
      });
    }
    return competence;
  }

  /**
   * G28: Competence-per-runtime tracking — measure success_rate per (capability, runtime).
   * This lets selectRuntime pick the runtime that historically works best for this capability.
   * If codex fails 3x on TS but opencode succeeds, opencode gets the assignment.
   */
  measureCompetencePerRuntime(capabilityId: string): Record<string, {
    n_runs: number; n_completed: number; success_rate: number; p50_cost: number;
  }> {
    const rows = this.db.prepare(
      'SELECT runtime, status, metadata FROM worker_leases WHERE capability_id = ?'
    ).all(capabilityId) as Array<{ runtime: string; status: string; metadata: string }>;

    const byRuntime: Record<string, { n_runs: number; n_completed: number; success_rate: number; p50_cost: number; costs: number[] }> = {};
    for (const r of rows) {
      if (!byRuntime[r.runtime]) byRuntime[r.runtime] = { n_runs: 0, n_completed: 0, success_rate: 0, p50_cost: 0, costs: [] };
      byRuntime[r.runtime].n_runs += 1;
      if (r.status === 'completed') {
        byRuntime[r.runtime].n_completed += 1;
        try {
          const m = JSON.parse(r.metadata || '{}') as Record<string, unknown>;
          const usage = m.runtime_usage as Record<string, unknown> | undefined;
          const total = Number(usage?.total_tokens) || 0;
          if (total > 0) byRuntime[r.runtime].costs.push(total);
        } catch { /* empty */ }
      }
    }

    const result: Record<string, { n_runs: number; n_completed: number; success_rate: number; p50_cost: number }> = {};
    for (const [runtime, data] of Object.entries(byRuntime)) {
      data.success_rate = data.n_runs > 0 ? data.n_completed / data.n_runs : 0;
      data.costs.sort((a, b) => a - b);
      data.p50_cost = data.costs.length > 0 ? data.costs[Math.floor(data.costs.length * 0.5)] : 0;
      result[runtime] = {
        n_runs: data.n_runs,
        n_completed: data.n_completed,
        success_rate: data.success_rate,
        p50_cost: data.p50_cost,
      };
    }

    // G28: store per-runtime competence in cost_model_json
    try {
      const cap = this.getCapability(capabilityId);
      const costModel = { ...(cap.cost_model as Record<string, unknown>), runtime_competence: result };
      this.db.prepare('UPDATE swarm_capabilities SET cost_model_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(costModel), new Date().toISOString(), capabilityId);
    } catch { /* best-effort */ }

    return result;
  }

  // G1: Evidence-based auto-promotion — a candidate skill is promoted to validated only
  // after >=minSuccesses completed leases with evidence AND success_rate >= minSuccessRate
  // AND eval_score >= threshold. This is "skills promoted from evidence, not hand-authored."
  autoPromoteFromEvidence(capabilityId: string, opts: { minSuccesses?: number; minSuccessRate?: number } = {}): {
    promoted: boolean; capability?: SwarmCapabilityRecord;
    competence: { n_runs: number; n_completed: number; success_rate: number; p50_cost: number; p95_cost: number };
    reason: string;
  } {
    const minSuccesses = opts.minSuccesses ?? 3;
    const minSuccessRate = opts.minSuccessRate ?? 0.6;
    const cap = this.getCapability(capabilityId);
    const c = this.measureCompetence(capabilityId);
    const competence = { n_runs: c.n_runs, n_completed: c.n_completed, success_rate: c.success_rate, p50_cost: c.p50_cost, p95_cost: c.p95_cost };
    if (cap.status !== 'candidate') {
      return { promoted: false, competence, reason: `capability not candidate (status=${cap.status})` };
    }
    if (competence.n_completed < minSuccesses) {
      return { promoted: false, competence, reason: `insufficient validated successes: ${competence.n_completed} < ${minSuccesses}` };
    }
    if (competence.success_rate < minSuccessRate) {
      return { promoted: false, competence, reason: `success_rate ${competence.success_rate.toFixed(2)} < ${minSuccessRate}` };
    }
    const rows = this.db.prepare(
      "SELECT id, metadata FROM worker_leases WHERE capability_id = ? AND status = 'completed' ORDER BY updated_at DESC LIMIT ?"
    ).all(capabilityId, minSuccesses) as Array<{ id: string; metadata: string }>;
    const evidence_refs = rows.map((r) => {
      let m: Record<string, unknown> = {}; try { m = JSON.parse(r.metadata || '{}') as Record<string, unknown>; } catch { /* empty */ }
      return typeof m.stdout_path === 'string' ? `lease:${r.id}:${m.stdout_path}` : `lease:${r.id}`;
    });
    try {
      const capability = this.promoteCapability(capabilityId, {
        eval_score: Math.max(cap.eval_score, competence.success_rate),
        evidence_refs,
        validation_report: `auto-promoted from evidence: ${competence.n_completed}/${competence.n_runs} successes (rate ${competence.success_rate.toFixed(2)}), p50_cost=${competence.p50_cost}, p95_cost=${competence.p95_cost}`,
      });
      swarmEventBus.emit('capability_transition', {
        capability_id: capabilityId,
        old_status: 'candidate',
        new_status: 'validated',
        reason: 'auto-promoted from evidence',
      });
      return { promoted: true, capability, competence, reason: 'promoted from accumulated validated evidence' };
    } catch (error) {
      return { promoted: false, competence, reason: `promotion rejected: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * G12: Create a composed skill — a chain of atomic skills with inter-skill handoff.
   * A composed skill is stored in swarm_capabilities with composed: true + chain: SkillId[]
   * in the metadata. It starts as 'candidate' and is promoted (promoteComposedSkill) only
   * when all atomic skills are 'validated' AND the chain has >=N validated runs.
   */
  createComposedSkill(input: {
    id: string;
    name: string;
    chain: string[];
    owner?: string;
    version?: string;
    risk_ceiling?: 'low' | 'medium' | 'high' | 'critical';
    removal_strategy?: string;
  }): SwarmCapabilityRecord {
    if (!input.id?.trim()) throw new Error('SWARM_CAPABILITY_ID_REQUIRED');
    if (!input.chain || input.chain.length < 2) throw new Error('COMPOSED_SKILL_CHAIN_MIN_2');

    for (const skillId of input.chain) {
      const cap = this.getCapability(skillId);
      if (!cap) throw new Error(`SWARM_CAPABILITY_NOT_FOUND: ${skillId}`);
    }

    const now = new Date().toISOString();
    const metadata = {
      composed: true,
      chain: input.chain,
      name: input.name,
      composed_created_at: now,
    };

    this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
        eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
        metadata, created_at, updated_at
      ) VALUES (?, 'skill', ?, ?, 'candidate', ?, 'composed', 'composed',
        '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', 0, 0.5, '{}', ?, null, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      input.id.trim(),
      (input.owner || 'system').trim(),
      (input.version || '0.1.0').trim(),
      input.risk_ceiling || 'low',
      input.removal_strategy || 'demote_on_fail',
      JSON.stringify(metadata),
      now,
      now,
    );

    return this.getCapability(input.id.trim());
  }

  /**
   * G12: Promote a composed skill to 'validated' — only when all atomic skills in the
   * chain are 'validated' AND the chain has >=minChainRuns validated runs.
   */
  promoteComposedSkill(composedSkillId: string, opts: { minChainRuns?: number } = {}): {
    promoted: boolean;
    reason: string;
    allAtomicValidated: boolean;
    chainRuns: number;
  } {
    const minChainRuns = opts.minChainRuns ?? 3;
    const cap = this.getCapability(composedSkillId);
    const meta = cap.metadata as Record<string, unknown>;

    if (!meta.composed) {
      return { promoted: false, reason: 'not a composed skill', allAtomicValidated: false, chainRuns: 0 };
    }

    const chain = meta.chain as string[];
    if (!Array.isArray(chain)) {
      return { promoted: false, reason: 'no chain in metadata', allAtomicValidated: false, chainRuns: 0 };
    }

    const allAtomicValidated = chain.every((skillId) => {
      const atomic = this.getCapability(skillId);
      return atomic?.status === 'validated';
    });

    if (!allAtomicValidated) {
      return { promoted: false, reason: 'not all atomic skills are validated', allAtomicValidated: false, chainRuns: 0 };
    }

    const competence = this.measureCompetence(composedSkillId);
    if (competence.n_completed < minChainRuns) {
      return { promoted: false, reason: `insufficient chain runs: ${competence.n_completed} < ${minChainRuns}`, allAtomicValidated: true, chainRuns: competence.n_completed };
    }

    const now = new Date().toISOString();
    this.db.prepare('UPDATE swarm_capabilities SET status = ?, updated_at = ? WHERE id = ?')
      .run('validated', now, composedSkillId);

    return { promoted: true, reason: `composed skill promoted (${competence.n_completed} chain runs, all atomic validated)`, allAtomicValidated: true, chainRuns: competence.n_completed };
  }

  listSpecialistProfiles(): SpecialistProfile[] {
    return this.panels.getCatalog().map((profile) => ({
      ...profile,
      version: (profile as any).version || '1.0.0',
    } as SpecialistProfile));
  }

  createClaim(input: {
    claim?: string;
    claim_type?: ClaimType;
    subject_ref?: string;
    predicate?: string | null;
    object?: string | null;
    scope?: string | null;
    evidence_refs?: string[];
    confidence?: number;
    valid_until?: string | null;
    supports_ref?: string | null;
    contradicts_ref?: string | null;
    status?: ClaimStatus;
    verified_by_gate?: string | null;
    invalidated_by?: string | null;
    created_from?: string;
    metadata?: Record<string, unknown>;
  }): ClaimLedgerRecord {
    if (!input.claim?.trim()) throw new Error('SWARM_CLAIM_TEXT_REQUIRED');
    if (!input.claim_type || !CLAIM_TYPES.includes(input.claim_type)) throw new Error('SWARM_CLAIM_TYPE_INVALID');
    if (!input.subject_ref?.trim()) throw new Error('SWARM_CLAIM_SUBJECT_REQUIRED');
    if (!input.created_from?.trim()) throw new Error('SWARM_CLAIM_CREATED_FROM_REQUIRED');
    const validUntil = this.parseTimestamp(input.valid_until);
    if (input.valid_until && !validUntil) throw new Error('SWARM_CLAIM_VALID_UNTIL_INVALID');
    this.rejectSecretLike(input);

    const evidenceRefs = this.stringArray(input.evidence_refs);
    const confidence = this.normalizedScore(input.confidence ?? 0);
    const predicate = this.trimStringOrNull(input.predicate);
    const object = this.trimStringOrNull(input.object);
    const scope = this.trimStringOrNull(input.scope);
    const supportsRef = this.trimStringOrNull(input.supports_ref);
    const explicitContradictionRef = this.trimStringOrNull(input.contradicts_ref);
    if (supportsRef) {
      this.assertClaimRefExists(supportsRef);
    }
    if (explicitContradictionRef) {
      this.assertClaimRefExists(explicitContradictionRef);
    }

    let status = input.status || (evidenceRefs.length > 0 ? 'supported' : 'proposed');
    if (!evidenceRefs.length && ['supported', 'promoted'].includes(status)) {
      status = 'proposed';
    }
    if (input.claim_type === 'policy' && status === 'promoted') {
      status = 'review_required';
    }
    if (!this.contradictionRuleAllows(input.claim_type, status)) {
      status = status === 'supported' ? 'review_required' : status;
    }

    const contradiction = explicitContradictionRef
      ? this.getClaim(explicitContradictionRef)
      : this.findTypedContradiction({
      subjectRef: input.subject_ref.trim(),
      claim: input.claim.trim(),
      claimType: input.claim_type,
      predicate,
      object,
      scope,
      validUntil,
      supportsRef,
      explicitContradictionRef: null,
    });
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_claims (
        id, claim, claim_type, subject_ref, predicate, object, scope, valid_until,
        evidence_refs_json, confidence, status, supports_ref, contradicts_ref,
        verified_by_gate, invalidated_by, created_from, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.claim.trim(),
      input.claim_type,
      input.subject_ref.trim(),
      predicate,
      object,
      scope,
      validUntil,
      JSON.stringify(evidenceRefs),
      confidence,
      contradiction ? 'contradicted' : status,
      supportsRef,
      explicitContradictionRef,
      input.verified_by_gate || null,
      input.invalidated_by || contradiction?.id || null,
      input.created_from.trim(),
      JSON.stringify({
        ...(input.metadata || {}),
        contradictory_claim_id: contradiction?.id || null,
        explicit_contradiction: explicitContradictionRef || null,
      }),
      now,
      now
    );

    if (contradiction) {
      this.createEvidenceEdge(`claim:${id}`, `claim:${contradiction.id}`, 'contradicts', { subject_ref: input.subject_ref });
      // G15.4: Update the contradicted claim's status to 'contradicted'
      this.db.prepare('UPDATE swarm_claims SET status = ?, updated_at = ? WHERE id = ?')
        .run('contradicted', new Date().toISOString(), contradiction.id);
    }
    // G15: publish the claim to the knowledge bus so subscribers (other loop runs,
    // other capabilities) receive it in real-time. In-process first; the HTTP
    // transport scaffold (/api/knowledge/publish + /api/knowledge/subscribe) is
    // for future cross-fleet federation.
    try {
      const publishedClaim = this.getClaim(id);
      knowledgeBus.publish({
        claim_id: publishedClaim.id,
        capability_id: (publishedClaim.metadata as Record<string, unknown>)?.capability_id as string | null ?? null,
        predicate: publishedClaim.predicate || '',
        subject_ref: publishedClaim.subject_ref,
        confidence: publishedClaim.confidence,
        status: publishedClaim.status,
        trust: publishedClaim.confidence,
        provenance_run: (publishedClaim.metadata as Record<string, unknown>)?.provenance_run as string | null ?? null,
        evidence_refs: Array.isArray(publishedClaim.evidence_refs) ? publishedClaim.evidence_refs : [],
        created_from: (publishedClaim.metadata as Record<string, unknown>)?.created_from as string | null ?? null,
      });
    } catch { /* best-effort: never fail claim creation on bus publish */ }
    return this.getClaim(id);  }

  listClaims(limit = 100): ClaimLedgerRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_claims ORDER BY created_at DESC LIMIT ?').all(this.limit(limit)) as any[])
      .map((row) => this.parseClaim(row));
  }

  getClaim(id: string): ClaimLedgerRecord {
    const row = this.db.prepare('SELECT * FROM swarm_claims WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_CLAIM_NOT_FOUND');
    return this.parseClaim(row);
  }

  createEvidenceEdge(fromRef: string, toRef: string, relation: string, metadata: Record<string, unknown> = {}) {
    if (!fromRef.trim() || !toRef.trim() || !relation.trim()) throw new Error('SWARM_EVIDENCE_EDGE_INVALID');
    this.rejectSecretLike(fromRef, toRef, relation, metadata);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO swarm_evidence_edges (id, from_ref, to_ref, relation, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, fromRef.trim(), toRef.trim(), relation.trim(), JSON.stringify(metadata), new Date().toISOString());
    return { id, from_ref: fromRef.trim(), to_ref: toRef.trim(), relation: relation.trim(), metadata };
  }

  // G15.5: Lineage resolver — forward and reverse graph traversal
  lineageForward(ref: string, maxDepth = 10): { ref: string; edges: Array<{ to: string; relation: string; depth: number }> } {
    const visited = new Set<string>([ref]);
    const edges: Array<{ to: string; relation: string; depth: number }> = [];
    const queue: Array<{ ref: string; depth: number }> = [{ ref, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;
      const rows = this.db.prepare('SELECT to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ?').all(item.ref) as any[];
      for (const row of rows) {
        if (visited.has(row.to_ref)) continue;
        visited.add(row.to_ref);
        edges.push({ to: row.to_ref, relation: row.relation, depth: item.depth + 1 });
        queue.push({ ref: row.to_ref, depth: item.depth + 1 });
      }
    }
    return { ref, edges };
  }

  lineageReverse(ref: string, maxDepth = 10): { ref: string; edges: Array<{ from: string; relation: string; depth: number }> } {
    const visited = new Set<string>([ref]);
    const edges: Array<{ from: string; relation: string; depth: number }> = [];
    const queue: Array<{ ref: string; depth: number }> = [{ ref, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;
      const rows = this.db.prepare('SELECT from_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?').all(item.ref) as any[];
      for (const row of rows) {
        if (visited.has(row.from_ref)) continue;
        visited.add(row.from_ref);
        edges.push({ from: row.from_ref, relation: row.relation, depth: item.depth + 1 });
        queue.push({ ref: row.from_ref, depth: item.depth + 1 });
      }
    }
    return { ref, edges };
  }

  evidenceGraphSummary(ref: string): { ref: string; forward_count: number; reverse_count: number; forward: Array<{ to: string; relation: string }>; reverse: Array<{ from: string; relation: string }> } {
    const fwd = this.db.prepare('SELECT to_ref, relation FROM swarm_evidence_edges WHERE from_ref = ?').all(ref) as any[];
    const rev = this.db.prepare('SELECT from_ref, relation FROM swarm_evidence_edges WHERE to_ref = ?').all(ref) as any[];
    return {
      ref,
      forward_count: fwd.length,
      reverse_count: rev.length,
      forward: fwd.map((r) => ({ to: r.to_ref, relation: r.relation })),
      reverse: rev.map((r) => ({ from: r.from_ref, relation: r.relation })),
    };
  }

  // G15.5: Permission-scoped graph traversal — cannot expose records outside caller scope
  lineageForwardScoped(ref: string, permittedRefs: Set<string>, maxDepth = 10): { ref: string; edges: Array<{ to: string; relation: string; depth: number }> } {
    const full = this.lineageForward(ref, maxDepth);
    return {
      ref,
      edges: full.edges.filter((e) => permittedRefs.has(e.to) || permittedRefs.has('*')),
    };
  }

  lineageReverseScoped(ref: string, permittedRefs: Set<string>, maxDepth = 10): { ref: string; edges: Array<{ from: string; relation: string; depth: number }> } {
    const full = this.lineageReverse(ref, maxDepth);
    return {
      ref,
      edges: full.edges.filter((e) => permittedRefs.has(e.from) || permittedRefs.has('*')),
    };
  }

  // G15.7: Process-aware stop/kill adapter info
  getProcessAdapterInfo(runtime: string): { runtime: string; supports_stop: boolean; supports_kill: boolean; stop_signal: string; kill_signal: string } {
    const adapters: Record<string, { supports_stop: boolean; supports_kill: boolean; stop_signal: string; kill_signal: string }> = {
      codex: { supports_stop: true, supports_kill: true, stop_signal: 'SIGTERM', kill_signal: 'SIGKILL' },
      opencode: { supports_stop: true, supports_kill: true, stop_signal: 'SIGTERM', kill_signal: 'SIGKILL' },
      claude: { supports_stop: true, supports_kill: true, stop_signal: 'SIGTERM', kill_signal: 'SIGKILL' },
      gemini: { supports_stop: true, supports_kill: true, stop_signal: 'SIGTERM', kill_signal: 'SIGKILL' },
      pi: { supports_stop: true, supports_kill: true, stop_signal: 'SIGTERM', kill_signal: 'SIGKILL' },
      mock: { supports_stop: false, supports_kill: false, stop_signal: 'N/A', kill_signal: 'N/A' },
      manual: { supports_stop: false, supports_kill: false, stop_signal: 'N/A', kill_signal: 'N/A' },
    };
    return { runtime, ...adapters[runtime] || { supports_stop: false, supports_kill: false, stop_signal: 'N/A', kill_signal: 'N/A' } };
  }

  // G15.4: Require evidence refs to resolve before claim can become supported
  resolveEvidenceRefs(refs: string[]): { all_resolved: boolean; unresolved: string[] } {
    const unresolved: string[] = [];
    for (const ref of refs) {
      const [kind, id] = ref.split(':');
      if (!kind || !id) { unresolved.push(ref); continue; }
      let exists = false;
      try {
        switch (kind) {
          case 'claim': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_claims WHERE id = ?').get(id)); break;
          case 'capability': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_capabilities WHERE id = ?').get(id)); break;
          case 'manifest': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_runner_manifests WHERE id = ?').get(id)); break;
          case 'memory': exists = Boolean(this.db.prepare('SELECT 1 FROM memory_candidates WHERE id = ?').get(id)); break;
          case 'panel': exists = Boolean(this.db.prepare('SELECT 1 FROM specialist_panels WHERE id = ?').get(id)); break;
          case 'goal': exists = Boolean(this.db.prepare('SELECT 1 FROM goals WHERE id = ?').get(id)); break;
          case 'loop': exists = Boolean(this.db.prepare('SELECT 1 FROM loop_runs WHERE id = ?').get(id)); break;
          case 'lease': exists = Boolean(this.db.prepare('SELECT 1 FROM worker_leases WHERE id = ?').get(id)); break;
          case 'mission': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_missions WHERE id = ?').get(id)); break;
          case 'task': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_tasks WHERE id = ?').get(id)); break;
          default: exists = true;
        }
      } catch { exists = false; }
      if (!exists) unresolved.push(ref);
    }
    return { all_resolved: unresolved.length === 0, unresolved };
  }

  // G15.4: Specialist-review-to-claim extraction — leaves unsupported claims as proposed
  extractClaimsFromPanel(panelId: string): { extracted: number; claims: Array<{ id: string; claim: string; status: string }> } {
    const panel = this.panels.getPanel(panelId);
    const extracted: Array<{ id: string; claim: string; status: string }> = [];
    for (const review of panel.reviews || []) {
      const evidenceRefs = (review as any).evidence_refs || [];
      const status = evidenceRefs.length > 0 ? 'supported' : 'proposed';
      try {
        const claim = this.createClaim({
          claim: `${review.specialist_title}: ${review.findings || 'No findings'}`,
          claim_type: 'observation',
          subject_ref: `panel:${panelId}`,
          confidence: review.confidence || 0.5,
          status: status as any,
          evidence_refs: evidenceRefs,
          created_from: 'specialist_review_extraction',
        });
        extracted.push({ id: claim.id, claim: claim.claim, status: claim.status });
      } catch {
        // Skip if secret-like or invalid
      }
    }
    return { extracted: extracted.length, claims: extracted };
  }

  // G15.4: Retention/deletion metadata for evidence and memory candidates
  setRetentionMetadata(ref: string, retention: { ttl_days?: number; delete_after?: string; sensitivity?: string }): void {
    const [kind, id] = ref.split(':');
    if (!kind || !id) return;
    const metadata = { retention_ttl_days: retention.ttl_days, retention_delete_after: retention.delete_after, sensitivity: retention.sensitivity || 'normal', retention_set_at: new Date().toISOString() };
    try {
      if (kind === 'memory') {
        const row = this.db.prepare('SELECT metadata FROM memory_candidates WHERE id = ?').get(id) as any;
        const existing = row ? JSON.parse(row.metadata || '{}') : {};
        this.db.prepare('UPDATE memory_candidates SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...existing, ...metadata }), id);
      } else if (kind === 'claim') {
        const row = this.db.prepare('SELECT metadata FROM swarm_claims WHERE id = ?').get(id) as any;
        const existing = row ? JSON.parse(row.metadata || '{}') : {};
        this.db.prepare('UPDATE swarm_claims SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...existing, ...metadata }), id);
      }
    } catch {
      // Best effort — table might not exist or row might not be found
    }
  }

  // G15.8: Hypothesis workbench
  createHypothesis(input: {
    question: string;
    evidence_plan?: string[];
    falsification_signal?: string;
    stop_condition?: string;
    owner_capability_id?: string | null;
    panel_id?: string | null;
    metadata?: Record<string, unknown>;
  }): { id: string; question: string; projection_state: string } {
    if (!input.question?.trim()) throw new Error('SWARM_HYPOTHESIS_QUESTION_REQUIRED');
    this.rejectSecretLike(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_hypotheses (id, question, evidence_plan_json, falsification_signal, stop_condition, owner_capability_id, panel_id, projection_state, evidence_refs_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', '[]', ?, ?, ?)
    `).run(
      id,
      input.question.trim(),
      JSON.stringify(input.evidence_plan || []),
      input.falsification_signal || null,
      input.stop_condition || 'evidence_threshold_met',
      input.owner_capability_id || null,
      input.panel_id || null,
      JSON.stringify(input.metadata || {}),
      now, now,
    );
    return { id, question: input.question.trim(), projection_state: 'draft' };
  }

  getHypothesis(id: string): any {
    const row = this.db.prepare('SELECT * FROM swarm_hypotheses WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_HYPOTHESIS_NOT_FOUND');
    return row;
  }

  listHypotheses(limit = 100): any[] {
    return this.db.prepare('SELECT * FROM swarm_hypotheses ORDER BY created_at DESC LIMIT ?').all(this.limit(limit));
  }

  transitionHypothesis(id: string, toState: string, evidence?: string[]): any {
    const validStates = ['draft', 'testing', 'supported', 'falsified', 'projected', 'cancelled'];
    if (!validStates.includes(toState)) throw new Error('SWARM_HYPOTHESIS_STATE_INVALID');
    const now = new Date().toISOString();
    this.db.prepare('UPDATE swarm_hypotheses SET projection_state = ?, evidence_refs_json = ?, updated_at = ? WHERE id = ?')
      .run(toState, JSON.stringify(evidence || []), now, id);
    return this.getHypothesis(id);
  }

  // G15.7: Runtime concurrency slots per adapter and risk class
  private concurrencySlots: Map<string, { max: number; active: number }> = new Map();

  setConcurrencySlot(adapter: string, riskClass: string, maxConcurrent: number): void {
    const key = `${adapter}:${riskClass}`;
    this.concurrencySlots.set(key, { max: maxConcurrent, active: this.concurrencySlots.get(key)?.active || 0 });
  }

  checkConcurrencySlot(adapter: string, riskClass: string): { available: boolean; active: number; max: number } {
    const key = `${adapter}:${riskClass}`;
    const slot = this.concurrencySlots.get(key);
    if (!slot) return { available: true, active: 0, max: Infinity };
    return { available: slot.active < slot.max, active: slot.active, max: slot.max };
  }

  acquireConcurrencySlot(adapter: string, riskClass: string): boolean {
    const key = `${adapter}:${riskClass}`;
    const slot = this.concurrencySlots.get(key);
    if (!slot) return true;
    if (slot.active >= slot.max) return false;
    slot.active++;
    return true;
  }

  releaseConcurrencySlot(adapter: string, riskClass: string): void {
    const key = `${adapter}:${riskClass}`;
    const slot = this.concurrencySlots.get(key);
    if (slot && slot.active > 0) slot.active--;
  }

  // G15.8: Specialist profile version persistence
  getSpecialistProfileVersion(specialistId: string): string {
    const profiles = this.panels.getCatalog();
    const profile = profiles.find((p) => p.id === specialistId);
    return (profile as any)?.version || '1.0.0';
  }

  planCapacityV2(input: WorkerPoolPlanInput = {}, existingStatusService?: SwarmStatusService): CapacityPlanV2Result {
    const statusService = existingStatusService || this.swarmStatus();
    const plan = statusService.planWorkerPool(input);
    const queueClasses: Record<string, number> = {};
    for (const decision of plan.decisions) {
      const queueClass = this.queueClassFor(decision.role, decision.risk_class, decision.blocked_reasons);
      queueClasses[queueClass] = (queueClasses[queueClass] || 0) + 1;
    }
    const fairShareOrder = Object.entries(queueClasses)
      .sort(([left], [right]) => this.queueWeight(right) - this.queueWeight(left))
      .map(([queueClass]) => queueClass);
    return {
      ...plan,
      queue_classes: queueClasses,
      fair_share_order: fairShareOrder,
      audit_manifest_preview: plan.decisions.map((decision) => ({
        decision_id: `preview:${decision.lease_id}`,
        lease_id: decision.lease_id,
        action: decision.eligible ? 'start' : 'skip',
        policy_version: 'swarm-intelligence-v1',
        blocked_reasons: decision.blocked_reasons,
        queue_class: this.queueClassFor(decision.role, decision.risk_class, decision.blocked_reasons),
      })),
    };
  }

  createRunnerManifest(input: {
    decision_id?: string;
    lease_id?: string | null;
    loop_run_id?: string | null;
    action?: RunnerManifestAction;
    policy_version?: string;
    runtime_contract?: Record<string, unknown>;
    capacity_snapshot?: Record<string, unknown>;
    budget_snapshot?: Record<string, unknown>;
    gate_refs?: string[];
    blocked_reasons?: string[];
    metadata?: Record<string, unknown>;
  }): RunnerManifestRecord {
    if (!input.decision_id?.trim()) throw new Error('SWARM_RUNNER_DECISION_ID_REQUIRED');
    if (!input.action || !RUNNER_ACTIONS.includes(input.action)) throw new Error('SWARM_RUNNER_ACTION_INVALID');
    if (!input.policy_version?.trim()) throw new Error('SWARM_RUNNER_POLICY_VERSION_REQUIRED');
    this.rejectSecretLike(input);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO swarm_runner_manifests (
        id, decision_id, lease_id, loop_run_id, action, policy_version,
        runtime_contract_json, capacity_snapshot_json, budget_snapshot_json,
        gate_refs_json, blocked_reasons_json, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.decision_id.trim(),
      input.lease_id || null,
      input.loop_run_id || null,
      input.action,
      input.policy_version.trim(),
      JSON.stringify(input.runtime_contract || {}),
      JSON.stringify(input.capacity_snapshot || {}),
      JSON.stringify(input.budget_snapshot || {}),
      JSON.stringify(this.stringArray(input.gate_refs)),
      JSON.stringify(this.stringArray(input.blocked_reasons)),
      JSON.stringify(input.metadata || {}),
      new Date().toISOString()
    );
    return this.parseRunnerManifest(this.db.prepare('SELECT * FROM swarm_runner_manifests WHERE id = ?').get(id));
  }

  listRunnerManifests(limit = 50): RunnerManifestRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_runner_manifests ORDER BY created_at DESC LIMIT ?').all(this.limit(limit)) as any[])
      .map((row) => this.parseRunnerManifest(row));
  }

  evaluateGovernance(input: {
    risk_class?: RiskClass;
    mutating?: boolean;
    maker_pass?: boolean;
    checker_pass?: boolean;
    security_checker_pass?: boolean;
    quorum_count?: number;
    quorum_required?: number;
    runtime_warnings?: string[];
    human_approval_ref?: string | null;
    ready_for_human_merge?: boolean;
  }) {
    const riskClass = input.risk_class || 'low';
    if (!RISK_CLASSES.includes(riskClass)) throw new Error('SWARM_GOVERNANCE_RISK_INVALID');
    const blocked: string[] = [];
    const warnings = this.stringArray(input.runtime_warnings);
    const quorumRequired = Math.max(0, Number(input.quorum_required || (['high', 'critical'].includes(riskClass) ? 2 : 0)));
    const quorumCount = Math.max(0, Number(input.quorum_count || 0));

    if (!input.maker_pass) blocked.push('maker_required');
    if (!input.checker_pass) blocked.push('checker_required');
    if (['high', 'critical'].includes(riskClass) && !input.security_checker_pass) blocked.push('security_checker_required');
    if (quorumCount < quorumRequired) blocked.push('evaluator_quorum_missing');
    if (['high', 'critical'].includes(riskClass) && warnings.some((warning) => /(trust|contract|auth|secret|token|permission)/i.test(warning))) {
      blocked.push('runtime_warning_gate_failed');
    }
    if (input.mutating && input.ready_for_human_merge && !input.human_approval_ref) {
      blocked.push('human_approval_required_for_completion');
    }

    return {
      status: blocked.length > 0 ? 'blocked' : 'eligible',
      blocked_reasons: [...new Set(blocked)],
      gates: {
        maker: input.maker_pass ? 'pass' : 'fail',
        checker: input.checker_pass ? 'pass' : 'fail',
        security_checker: ['high', 'critical'].includes(riskClass) ? (input.security_checker_pass ? 'pass' : 'fail') : 'skipped',
        evaluator_quorum: quorumCount >= quorumRequired ? 'pass' : 'fail',
        runtime_warning_gate: blocked.includes('runtime_warning_gate_failed') ? 'fail' : warnings.length ? 'advisory' : 'pass',
        human_completion_gate: input.mutating && input.ready_for_human_merge ? (input.human_approval_ref ? 'pass' : 'fail') : 'skipped',
      },
      completion_state: input.ready_for_human_merge && input.mutating && !input.human_approval_ref
        ? 'ready_for_human_merge'
        : blocked.length > 0 ? 'blocked' : 'completed_eligible',
    };
  }

  okfDriftReport(okfBase = KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true })) {
    const base = this.resolveOkfBase(String(okfBase));
    const skillsDir = path.join(base, 'skills');
    const files = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir).filter((file) => file.endsWith('.md')).sort()
      : [];
    const capabilities = this.listCapabilities(500).filter((capability) => capability.kind === 'skill');
    const capabilityPaths = new Set(capabilities.map((capability) => String(capability.metadata.okf_path || capability.id)));
    const missingRegistry = files
      .map((file) => file.replace(/\.md$/, ''))
      .filter((slug) => !capabilityPaths.has(slug) && !capabilityPaths.has(`skills/${slug}`));
    const staleTrust = capabilities.filter((capability) => capability.status === 'validated' && !capability.live_route_allowed);
    return {
      okf_base: okfBase,
      canonical_okf_base: KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }),
      canonical_path_mismatch: path.resolve(String(okfBase)) !== path.resolve(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true })),
      skills_dir: skillsDir,
      skill_file_count: files.length,
      registered_skill_capability_count: capabilities.length,
      missing_registry_entries: missingRegistry,
      stale_trust_levels: staleTrust.map((capability) => ({
        id: capability.id,
        status: capability.status,
        eval_score: capability.eval_score,
        eval_threshold: capability.eval_threshold,
        blocked_reasons: capability.blocked_reasons,
      })),
      rebuild_default: 'dry_run',
      projection_status: 'unknown',
      reproducible_from: ['OKF files', 'DB swarm_capabilities'],
    };
  }

  private resolveOkfBase(candidate: string): string {
    const explicit = this.trimStringOrNull(candidate);
    const configured = this.trimStringOrNull(process.env.OKF_ROOTS)
      ? process.env.OKF_ROOTS!.split(',').map((value) => value.trim()).filter(Boolean)
      : [];
    const configuredBase = this.trimStringOrNull(process.env.OKF_BASE) ? [path.resolve(process.env.OKF_BASE as string)] : [];
    const workspaceRoots = [
      path.resolve(process.cwd(), 'knowledge'),
      path.resolve(__dirname, '..', '..', '..'),
    ];

    const allowedRoots = (configuredBase.length > 0 ? configuredBase
      : [...configured.map((root) => path.resolve(root)), ...workspaceRoots])
      .map((root) => path.resolve(root));
    const normalizedCandidate = path.resolve(explicit || process.cwd());

    const isAllowed = allowedRoots.some((root) => this.isPathInsideOrEqual(normalizedCandidate, path.resolve(root)));
    if (!isAllowed) {
      throw new Error('SWARM_OKF_BASE_FORBIDDEN');
    }

    return normalizedCandidate;
  }

  private isPathInsideOrEqual(candidate: string, root: string): boolean {
    const normalizedCandidate = `${candidate}`.endsWith(path.sep) ? `${candidate}` : `${candidate}${path.sep}`;
    const normalizedRoot = `${path.resolve(root)}${path.sep}`;
    return normalizedCandidate.startsWith(normalizedRoot);
  }

  private resolveNodeLabel(environment: string, fallback: string): string {
    return this.trimStringOrNull(process.env[environment]) || fallback;
  }

  private nextSafeActions(capabilities: SwarmCapabilityRecord[], claims: ClaimLedgerRecord[], capacity: CapacityPlanV2Result): string[] {
    const actions: string[] = [];
    if (capabilities.some((capability) => capability.status === 'draft' || capability.status === 'candidate')) {
      actions.push('Run capability evals before live routing.');
    }
    if (claims.some((claim) => claim.status === 'contradicted' || claim.status === 'review_required')) {
      actions.push('Resolve claim ledger contradictions or review-required claims.');
    }
    if (capacity.eligible_count > 0) {
      actions.push('Run worker-pool start-next only after reviewing plan and policy gates.');
    } else {
      actions.push('Prepare or unblock leases before runner drain.');
    }
    return actions;
  }

  private integrationSpineSummary() {
    const rows = this.db.prepare(`
      SELECT * FROM work_items
      WHERE metadata LIKE '%"integration"%'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 25
    `).all() as any[];
    const chains = rows
      .map((row) => this.integrationChainForWorkItem(row))
      .filter((chain) => chain !== null)
      .slice(0, 5);
    return {
      latest: chains[0] || null,
      chains,
      next_safe_action: chains[0]?.next_safe_action || 'Import integration event',
    };
  }

  private productionPilotSummary() {
    const rows = this.db.prepare(`
      SELECT * FROM work_items
      WHERE metadata LIKE '%"production_pilot"%'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 25
    `).all() as any[];
    const runs = rows
      .map((row) => this.integrationChainForWorkItem(row))
      .filter((chain) => chain !== null)
      .slice(0, 10);
    const completed = runs.filter((run) => Boolean(run.eval_run));
    const checkerRejected = runs.filter((run) => run.leases.some((lease: any) => lease.role === 'checker' && lease.status === 'failed')).length;
    const interventionCount = runs.reduce((sum, run) => sum + Number((run as any).manual_interventions || 0), 0);
    const durations = runs
      .map((run) => {
        const started = Date.parse(String((run as any).created_at || ''));
        const completedAt = Date.parse(String((run as any).completed_at || ''));
        return Number.isFinite(started) && Number.isFinite(completedAt) ? completedAt - started : null;
      })
      .filter((duration): duration is number => typeof duration === 'number' && duration >= 0);
    return {
      latest: runs[0] || null,
      runs,
      metrics: {
        total_runs: runs.length,
        completed_runs: completed.length,
        success_rate: runs.length ? Number((completed.length / runs.length).toFixed(4)) : 0,
        checker_rejection_rate: runs.length ? Number((checkerRejected / runs.length).toFixed(4)) : 0,
        reflection_candidates: runs.filter((run) => Boolean(run.reflection_candidate)).length,
        memory_candidates: runs.filter((run) => Boolean(run.memory_candidate)).length,
        manual_intervention_count: interventionCount,
        avg_time_to_closure_ms: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : null,
      },
      next_safe_action: runs[0]?.next_safe_action || 'Run production pilot from a low-risk integration item',
    };
  }

  private integrationChainForWorkItem(row: any) {
    const metadata = this.jsonObject(row.metadata);
    const integration = this.jsonObject(metadata.integration);
    if (!integration) return null;
    const goalId = row.parent_goal_id || null;
    const loopRunId = this.trimStringOrNull(metadata.loop_run_id);
    const loop = loopRunId
      ? this.db.prepare('SELECT id, status, metadata, completed_at FROM loop_runs WHERE id = ?').get(loopRunId) as any | undefined
      : null;
    const leases = loopRunId
      ? (this.db.prepare('SELECT id, role, runtime, status, metadata FROM worker_leases WHERE loop_run_id = ? ORDER BY created_at ASC').all(loopRunId) as any[])
          .map((lease) => ({
            id: lease.id,
            role: lease.role,
            runtime: lease.runtime,
            effective_runtime: this.trimStringOrNull(this.jsonObject(lease.metadata).runtime_adapter)
              || this.trimStringOrNull(this.jsonObject(lease.metadata).effective_runtime)
              || lease.runtime,
            status: lease.status,
          }))
      : [];
    const evalRun = loopRunId
      ? this.db.prepare("SELECT id, status, score FROM agent_eval_runs WHERE target_type = 'loop' AND target_ref = ? ORDER BY created_at DESC LIMIT 1").get(loopRunId) as any | undefined
      : null;
    const reflection = loopRunId
      ? this.db.prepare("SELECT id, status FROM reflection_candidates WHERE source_type = 'loop' AND source_ref = ? ORDER BY created_at DESC LIMIT 1").get(loopRunId) as any | undefined
      : null;
    const memory = loopRunId
      ? this.db.prepare('SELECT id, status, promotion_status FROM memory_candidates WHERE source_ref = ? ORDER BY created_at DESC LIMIT 1').get(`loop:${loopRunId}`) as any | undefined
      : null;
    const maker = leases.find((lease) => lease.role === 'maker');
    const checker = leases.find((lease) => lease.role === 'checker');
    return {
      source: row.source,
      source_ref: row.source_ref,
      work_item: {
        id: row.id,
        title: row.title,
        status: row.status,
        risk_class: row.risk_class,
        recommended_loop: row.recommended_loop,
        assigned_runtime: row.assigned_runtime,
        metadata,
      },
      goal_id: goalId,
      loop: loop ? { id: loop.id, status: loop.status } : null,
      leases,
      eval_run: evalRun ? { id: evalRun.id, status: evalRun.status, score: Number(evalRun.score || 0) } : null,
      reflection_candidate: reflection ? { id: reflection.id, status: reflection.status } : null,
      memory_candidate: memory ? { id: memory.id, status: memory.status, promotion_status: memory.promotion_status } : null,
      requested_runtime: this.trimStringOrNull(integration.requested_runtime),
      manual_interventions: Number(integration.manual_interventions || 0),
      created_at: row.created_at,
      completed_at: loop?.completed_at || null,
      next_safe_action: this.integrationNextAction(row.status, loop?.status || null, maker?.status || null, checker?.status || null, Boolean(evalRun)),
    };
  }

  private integrationNextAction(
    workItemStatus: string,
    loopStatus: string | null,
    makerStatus: string | null,
    checkerStatus: string | null,
    hasEval: boolean
  ): string {
    if (workItemStatus === 'triaged') return 'Plan and prepare selected work item';
    if (workItemStatus === 'planned') return 'Prepare maker and checker leases';
    if (makerStatus === 'prepared') return 'Run worker-pool scheduler';
    if (makerStatus === 'completed' && checkerStatus === 'prepared') return 'Run checker through worker pool';
    if (checkerStatus === 'completed' && !hasEval) return 'Close loop learning';
    if (hasEval) return 'Review reflection and memory candidates';
    if (loopStatus === 'blocked' || workItemStatus === 'blocked') return 'Inspect blocked reasons';
    return 'Import integration event';
  }

  private jsonObject(value: unknown): Record<string, unknown> {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private parseCapability(row: any): SwarmCapabilityRecord {
    const capability = {
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
      eval_score: Number(row.eval_score || 0),
      eval_threshold: Number(row.eval_threshold || 0.75),
      cost_model: JSON.parse(row.cost_model_json || '{}'),
      removal_strategy: row.removal_strategy,
      latest_validation_report: row.latest_validation_report || null,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as Omit<SwarmCapabilityRecord, 'live_route_allowed' | 'blocked_reasons'>;
    const blockedReasons = this.capabilityBlockedReasons(capability);
    return {
      ...capability,
      live_route_allowed: blockedReasons.length === 0,
      blocked_reasons: blockedReasons,
    };
  }

  // G16.4: OpenAI capability descriptors — privileged candidates until reviewed
  private isOpenAIDescriptor(kind: CapabilityKind): boolean {
    return kind === 'openai_agents_sdk' || kind === 'openai_skill' || kind === 'openai_mcp_connector';
  }

  private capabilityBlockedReasons(capability: Omit<SwarmCapabilityRecord, 'live_route_allowed' | 'blocked_reasons'>): string[] {
    const blocked: string[] = [];
    // G16.4: OpenAI descriptors cannot route local workers without validated adapter proof
    if (this.isOpenAIDescriptor(capability.kind)) blocked.push('OPENAI_DESCRIPTOR_REQUIRES_ADAPTER_PROOF');
    if (capability.status !== 'validated') blocked.push(`status_${capability.status}_is_advisory_only`);
    if (capability.eval_score < capability.eval_threshold) blocked.push('eval_score_below_threshold');
    if (!capability.allowed_actions.length) blocked.push('allowed_actions_missing');
    if (!capability.forbidden_actions.length) blocked.push('forbidden_actions_missing');
    if (!capability.required_evidence.length) blocked.push('required_evidence_missing');
    if (!capability.removal_strategy?.trim()) blocked.push('removal_strategy_missing');
    return blocked;
  }

  private parseClaim(row: any): ClaimLedgerRecord {
    return {
      id: row.id,
      claim: row.claim,
      predicate: row.predicate || null,
      object: row.object || null,
      scope: row.scope || null,
      claim_type: row.claim_type,
      subject_ref: row.subject_ref,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      confidence: Number(row.confidence || 0),
      valid_until: row.valid_until || null,
      status: row.status,
      verified_by_gate: row.verified_by_gate || null,
      invalidated_by: row.invalidated_by || null,
      supports_ref: row.supports_ref || null,
      contradicts_ref: row.contradicts_ref || null,
      created_from: row.created_from,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseRunnerManifest(row: any): RunnerManifestRecord {
    return {
      id: row.id,
      decision_id: row.decision_id,
      lease_id: row.lease_id || null,
      loop_run_id: row.loop_run_id || null,
      action: row.action,
      policy_version: row.policy_version,
      runtime_contract: JSON.parse(row.runtime_contract_json || '{}'),
      capacity_snapshot: JSON.parse(row.capacity_snapshot_json || '{}'),
      budget_snapshot: JSON.parse(row.budget_snapshot_json || '{}'),
      gate_refs: JSON.parse(row.gate_refs_json || '[]'),
      blocked_reasons: JSON.parse(row.blocked_reasons_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
    };
  }

  private findTypedContradiction(input: {
    subjectRef: string;
    claim: string;
    claimType: ClaimType;
    predicate: string | null;
    object: string | null;
    scope: string | null;
    validUntil: string | null;
    supportsRef: string | null;
    explicitContradictionRef: string | null;
  }): ClaimLedgerRecord | null {
    const candidates = (this.db.prepare(`
      SELECT * FROM swarm_claims
      WHERE subject_ref = ? AND status IN ('supported', 'promoted')
        AND (valid_until IS NULL OR datetime(valid_until) >= datetime('now'))
      ORDER BY created_at DESC
    `).all(input.subjectRef) as any[]).map((row) => this.parseClaim(row));

    const contradiction = candidates.find((candidate) => {
      if (candidate.id === input.explicitContradictionRef) {
        return false;
      }
      if (input.scope && candidate.scope && input.scope !== candidate.scope) {
        return false;
      }
      return this.claimsAreContradictory({
        left: {
          claim: input.claim,
          predicate: input.predicate,
          object: input.object,
        },
        right: {
          claim: candidate.claim,
          predicate: candidate.predicate,
          object: candidate.object,
        },
      });
    });

    return contradiction || null;
  }

  private claimsAreContradictory(input: {
    left: { claim: string; predicate: string | null; object: string | null };
    right: { claim: string; predicate: string | null; object: string | null };
  }): boolean {
    const leftPredicate = this.normalizeClaimNullable(input.left.predicate);
    const rightPredicate = this.normalizeClaimNullable(input.right.predicate);
    if (leftPredicate || rightPredicate) {
      if (!leftPredicate || !rightPredicate) {
        return false;
      }
      if (leftPredicate !== rightPredicate) {
        return false;
      }
    }

    const leftObject = this.normalizeClaimNullable(input.left.object);
    const rightObject = this.normalizeClaimNullable(input.right.object);
    if (leftObject || rightObject) {
      if (!leftObject || !rightObject) {
        return false;
      }
      if (!this.areOppositeClaims(leftObject, rightObject)) {
        return false;
      }
      return true;
    }

    return this.areOppositeClaims(input.left.claim, input.right.claim);
  }

  private normalizeClaimNullable(value: string | null): string {
    if (value === null) {
      return '';
    }
    return this.normalizeClaim(value);
  }

  private areOppositeClaims(left: string, right: string): boolean {
    const leftParsed = this.parseNegatedClaim(left);
    const rightParsed = this.parseNegatedClaim(right);
    return leftParsed.base === rightParsed.base && leftParsed.negated !== rightParsed.negated;
  }

  private parseNegatedClaim(value: string): { base: string; negated: boolean } {
    const normalized = this.normalizeClaim(value);
    let negated = false;
    let base = normalized;

    const negationMap: Array<[RegExp, RegExp, string]> = [
      [/^not\s+/i, /\bnot\s+/g, ''],
      [/^no\s+/i, /\bno\s+/g, ''],
      [/\bis\s+not\s+/i, /\bis\s+not\s+/ig, 'is '],
      [/\bare\s+not\s+/i, /\bare\s+not\s+/ig, 'are '],
      [/\bwas\s+not\s+/i, /\bwas\s+not\s+/ig, 'was '],
      [/\bwere\s+not\s+/i, /\bwere\s+not\s+/ig, 'were '],
      [/\bdo\s+not\s+/i, /\bdo\s+not\s+/ig, 'do '],
      [/\bdoes\s+not\s+/i, /\bdoes\s+not\s+/ig, 'does '],
      [/\bdid\s+not\s+/i, /\bdid\s+not\s+/ig, 'did '],
      [/\bcannot\s+/i, /\bcannot\s+/ig, 'can '],
      [/\bcan't\s+/i, /\bcan't\s+/ig, 'can '],
      [/\bmust\s+not\s+/i, /\bmust\s+not\s+/ig, 'must '],
      [/\bshould\s+not\s+/i, /\bshould\s+not\s+/ig, 'should '],
      [/\bwould\s+not\s+/i, /\bwould\s+not\s+/ig, 'would '],
      [/\bcould\s+not\s+/i, /\bcould\s+not\s+/ig, 'could '],
      [/\bmay\s+not\s+/i, /\bmay\s+not\s+/ig, 'may '],
      [/\bmight\s+not\s+/i, /\bmight\s+not\s+/ig, 'might '],
      [/\bnot\b/i, /\bnot\b/g, ''],
      [/\bn['’]t\b/i, /\bn['’]t\b/g, ''],
    ];

    for (const [detectPattern, replacePattern, replacement] of negationMap) {
      if (detectPattern.test(base)) {
        negated = true;
        base = base.replace(replacePattern, replacement);
      }
    }

    base = base.replace(/\s+/g, ' ').trim();
    return { base, negated };
  }

  private contradictionRuleAllows(claimType: ClaimType, status: ClaimStatus): boolean {
    if (claimType === 'hypothesis' && status === 'supported') {
      return false;
    }
    return true;
  }

  private assertClaimRefExists(ref: string | null): void {
    if (!ref) {
      return;
    }
    const row = this.db.prepare('SELECT id FROM swarm_claims WHERE id = ?').get(ref);
    if (!row) {
      throw new Error('SWARM_CLAIM_REF_NOT_FOUND');
    }
  }

  private trimStringOrNull(value: unknown): string | null {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private parseTimestamp(value?: string | null): string | null {
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }

  private normalizeClaim(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private queueClassFor(role: string, riskClass: string, blockedReasons: string[]): string {
    if (blockedReasons.some((reason) => reason.includes('security') || reason.includes('high_risk'))) return 'security_review';
    if (role === 'checker' || role === 'security_checker') return 'review_gate';
    if (['high', 'critical'].includes(riskClass)) return 'policy_review';
    return 'small_code_fix';
  }

  private queueWeight(queueClass: string): number {
    const weights: Record<string, number> = {
      security_review: 100,
      policy_review: 90,
      review_gate: 80,
      small_code_fix: 50,
      research: 40,
      memory_synthesis: 30,
    };
    return weights[queueClass] || 10;
  }

  private normalizedScore(value: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(number, 1));
  }

  private stringArray(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return input.map((item) => String(item).trim()).filter(Boolean);
  }

  private limit(value: number): number {
    return Math.max(1, Math.min(Number(value || 100), 500));
  }

  private rejectSecretLike(...values: unknown[]): void {
    const text = JSON.stringify(values);
    if (/(api[_-]?key\s*[:=]|secret\s*[:=]|private[_-]?key|bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{12,})/i.test(text)) {
      throw new Error('SWARM_INTELLIGENCE_SECRET_DETECTED');
    }
  }

  // ── G14.1: Swarm Intelligence Kernel — mission/task/decision state machine ──

  private static readonly MISSION_TRANSITIONS: Record<string, string[]> = {
    observed: ['hypothesized', 'rejected'],
    hypothesized: ['planned', 'rejected', 'escalated'],
    planned: ['queued', 'rejected', 'escalated'],
    queued: ['prepared', 'blocked', 'escalated'],
    prepared: ['running', 'blocked', 'escalated'],
    running: ['checking', 'blocked', 'escalated'],
    checking: ['ready_for_human_merge', 'blocked', 'rejected', 'escalated'],
    ready_for_human_merge: ['completed', 'rejected', 'escalated'],
    completed: [],
    blocked: ['queued', 'rejected', 'escalated'],
    rejected: [],
    escalated: ['planned', 'rejected'],
  };

  private validateTransition(from: string, to: string): void {
    const allowed = SwarmIntelligenceService.MISSION_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new Error(`SWARM_INVALID_TRANSITION:${from}:${to}`);
    }
  }

  createMission(input: {
    goal_id?: string | null;
    title: string;
    description?: string;
    risk_class?: RiskClass;
    panel_id?: string | null;
    evidence_refs?: string[];
    metadata?: Record<string, unknown>;
  }): MissionRecord {
    if (!input.title?.trim()) throw new Error('SWARM_MISSION_TITLE_REQUIRED');
    const riskClass: RiskClass = input.risk_class || 'medium';
    if (!RISK_CLASSES.includes(riskClass)) throw new Error('SWARM_MISSION_RISK_INVALID');
    this.rejectSecretLike(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_missions (id, goal_id, title, description, risk_class, status, panel_id, evidence_refs_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.goal_id || null,
      input.title.trim(),
      (input.description || '').trim(),
      riskClass,
      input.panel_id || null,
      JSON.stringify(this.stringArray(input.evidence_refs)),
      JSON.stringify(input.metadata || {}),
      now, now,
    );
    return this.getMission(id);
  }

  getMission(id: string): MissionRecord {
    const row = this.db.prepare('SELECT * FROM swarm_missions WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_MISSION_NOT_FOUND');
    return this.parseMission(row as any);
  }

  listMissions(limit = 100): MissionRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_missions ORDER BY created_at DESC LIMIT ?')
      .all(this.limit(limit)) as any[])
      .map((row) => this.parseMission(row));
  }

  transitionMission(id: string, toStatus: MissionStatus, decisionInput?: {
    reason?: string;
    actor?: string;
    evidence_refs?: string[];
    gate_refs?: string[];
    blocked_reasons?: string[];
  }): MissionRecord {
    const mission = this.getMission(id);
    if (mission.status === toStatus) return mission;
    this.validateTransition(mission.status, toStatus);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE swarm_missions SET status = ?, updated_at = ? WHERE id = ?')
      .run(toStatus, now, id);
    this.recordDecision({
      mission_id: id,
      task_id: null,
      decision_type: 'state_transition',
      decision: `${mission.status}->${toStatus}`,
      reason: decisionInput?.reason || '',
      actor: decisionInput?.actor || 'system',
      evidence_refs: decisionInput?.evidence_refs,
      gate_refs: decisionInput?.gate_refs,
      blocked_reasons: decisionInput?.blocked_reasons,
    });
    return this.getMission(id);
  }

  createTask(input: {
    mission_id: string;
    title: string;
    description?: string;
    capability_id?: string | null;
    evidence_refs?: string[];
    metadata?: Record<string, unknown>;
  }): TaskRecord {
    if (!input.mission_id?.trim()) throw new Error('SWARM_TASK_MISSION_REQUIRED');
    if (!input.title?.trim()) throw new Error('SWARM_TASK_TITLE_REQUIRED');
    this.rejectSecretLike(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_tasks (id, mission_id, title, description, status, assigned_lease_id, capability_id, evidence_refs_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'observed', NULL, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.mission_id.trim(),
      input.title.trim(),
      (input.description || '').trim(),
      input.capability_id || null,
      JSON.stringify(this.stringArray(input.evidence_refs)),
      JSON.stringify(input.metadata || {}),
      now, now,
    );
    return this.getTask(id);
  }

  getTask(id: string): TaskRecord {
    const row = this.db.prepare('SELECT * FROM swarm_tasks WHERE id = ?').get(id);
    if (!row) throw new Error('SWARM_TASK_NOT_FOUND');
    return this.parseTask(row as any);
  }

  listTasks(missionId: string): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM swarm_tasks WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as any[])
      .map((row) => this.parseTask(row));
  }

  transitionTask(id: string, toStatus: MissionStatus, decisionInput?: {
    reason?: string;
    actor?: string;
    evidence_refs?: string[];
    gate_refs?: string[];
    blocked_reasons?: string[];
  }): TaskRecord {
    const task = this.getTask(id);
    if (task.status === toStatus) return task;
    this.validateTransition(task.status, toStatus);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE swarm_tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(toStatus, now, id);
    this.recordDecision({
      mission_id: task.mission_id,
      task_id: id,
      decision_type: 'state_transition',
      decision: `${task.status}->${toStatus}`,
      reason: decisionInput?.reason || '',
      actor: decisionInput?.actor || 'system',
      evidence_refs: decisionInput?.evidence_refs,
      gate_refs: decisionInput?.gate_refs,
      blocked_reasons: decisionInput?.blocked_reasons,
    });
    return this.getTask(id);
  }

  recordDecision(input: {
    mission_id?: string | null;
    task_id?: string | null;
    decision_type: DecisionType;
    decision: string;
    reason?: string;
    actor?: string;
    evidence_refs?: string[];
    gate_refs?: string[];
    blocked_reasons?: string[];
    metadata?: Record<string, unknown>;
  }): DecisionRecord {
    const validTypes: DecisionType[] = ['state_transition', 'route', 'gate', 'quorum', 'split', 'kill', 'escalate', 'review'];
    if (!input.decision_type || !validTypes.includes(input.decision_type)) throw new Error('SWARM_DECISION_TYPE_INVALID');
    if (!input.decision?.trim()) throw new Error('SWARM_DECISION_REQUIRED');
    this.rejectSecretLike(input);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO swarm_decisions (id, mission_id, task_id, decision_type, decision, reason, actor, evidence_refs_json, gate_refs_json, blocked_reasons_json, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.mission_id || null,
      input.task_id || null,
      input.decision_type,
      input.decision.trim(),
      (input.reason || '').trim(),
      (input.actor || 'system').trim(),
      JSON.stringify(this.stringArray(input.evidence_refs)),
      JSON.stringify(this.stringArray(input.gate_refs)),
      JSON.stringify(this.stringArray(input.blocked_reasons)),
      JSON.stringify(input.metadata || {}),
      new Date().toISOString(),
    );
    return this.parseDecision(this.db.prepare('SELECT * FROM swarm_decisions WHERE id = ?').get(id) as any);
  }

  listDecisions(missionId?: string, limit = 100): DecisionRecord[] {
    const sql = missionId
      ? 'SELECT * FROM swarm_decisions WHERE mission_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM swarm_decisions ORDER BY created_at DESC LIMIT ?';
    const args = missionId ? [missionId, this.limit(limit)] : [this.limit(limit)];
    return (this.db.prepare(sql).all(...args) as any[]).map((row) => this.parseDecision(row));
  }

  // ── G14.8: Circuit breaker ──

  private circuitBreakerState: Map<string, { failures: number; tripped: boolean; lastFailureAt: string | null }> = new Map();
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

  checkCircuitBreaker(scope: string): { tripped: boolean; failures: number; reason: string | null } {
    const state = this.circuitBreakerState.get(scope);
    if (!state) return { tripped: false, failures: 0, reason: null };
    if (state.tripped) {
      const cooldownElapsed = state.lastFailureAt
        ? Date.now() - new Date(state.lastFailureAt).getTime() > SwarmIntelligenceService.CIRCUIT_BREAKER_COOLDOWN_MS
        : false;
      if (cooldownElapsed) {
        this.circuitBreakerState.set(scope, { failures: 0, tripped: false, lastFailureAt: null });
        return { tripped: false, failures: 0, reason: null };
      }
      return { tripped: true, failures: state.failures, reason: `circuit_breaker_tripped:${scope}:${state.failures}_failures` };
    }
    return { tripped: false, failures: state.failures, reason: null };
  }

  recordCircuitBreakerFailure(scope: string): { tripped: boolean; failures: number } {
    const state = this.circuitBreakerState.get(scope) || { failures: 0, tripped: false, lastFailureAt: null };
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    if (state.failures >= SwarmIntelligenceService.CIRCUIT_BREAKER_THRESHOLD) {
      state.tripped = true;
    }
    this.circuitBreakerState.set(scope, state);
    return { tripped: state.tripped, failures: state.failures };
  }

  resetCircuitBreaker(scope: string): void {
    this.circuitBreakerState.delete(scope);
  }

  // ── Parsers ──

  private parseMission(row: any): MissionRecord {
    return {
      id: row.id,
      goal_id: row.goal_id || null,
      title: row.title,
      description: row.description || '',
      risk_class: row.risk_class as RiskClass,
      status: row.status as MissionStatus,
      panel_id: row.panel_id || null,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseTask(row: any): TaskRecord {
    return {
      id: row.id,
      mission_id: row.mission_id,
      title: row.title,
      description: row.description || '',
      status: row.status as MissionStatus,
      assigned_lease_id: row.assigned_lease_id || null,
      capability_id: row.capability_id || null,
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseDecision(row: any): DecisionRecord {
    return {
      id: row.id,
      mission_id: row.mission_id || null,
      task_id: row.task_id || null,
      decision_type: row.decision_type as DecisionType,
      decision: row.decision,
      reason: row.reason || '',
      actor: row.actor || 'system',
      evidence_refs: JSON.parse(row.evidence_refs_json || '[]'),
      gate_refs: JSON.parse(row.gate_refs_json || '[]'),
      blocked_reasons: JSON.parse(row.blocked_reasons_json || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
    };
  }
}

// ── G14.1 Types ──

export type MissionStatus = 'observed' | 'hypothesized' | 'planned' | 'queued' | 'prepared' | 'running' | 'checking' | 'ready_for_human_merge' | 'completed' | 'blocked' | 'rejected' | 'escalated';
export type DecisionType = 'state_transition' | 'route' | 'gate' | 'quorum' | 'split' | 'kill' | 'escalate' | 'review';

export interface MissionRecord {
  id: string;
  goal_id: string | null;
  title: string;
  description: string;
  risk_class: RiskClass;
  status: MissionStatus;
  panel_id: string | null;
  evidence_refs: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TaskRecord {
  id: string;
  mission_id: string;
  title: string;
  description: string;
  status: MissionStatus;
  assigned_lease_id: string | null;
  capability_id: string | null;
  evidence_refs: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DecisionRecord {
  id: string;
  mission_id: string | null;
  task_id: string | null;
  decision_type: DecisionType;
  decision: string;
  reason: string;
  actor: string;
  evidence_refs: string[];
  gate_refs: string[];
  blocked_reasons: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}
