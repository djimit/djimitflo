import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SwarmStatusService, type WorkerPoolPlanInput, type WorkerPoolPlanResult } from './swarm-status-service';
import { SpecialistPanelService, type SpecialistProfile } from './specialist-panel-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

type CapabilityKind = 'skill' | 'specialist_agent' | 'runtime_adapter' | 'deterministic_harness' | 'memory_source' | 'dashboard_action';
type CapabilityStatus = 'draft' | 'candidate' | 'validated' | 'deprecated' | 'disabled';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';
type ClaimType = 'observation' | 'hypothesis' | 'decision' | 'memory' | 'capability' | 'backlog' | 'policy';
type ClaimStatus = 'proposed' | 'supported' | 'contradicted' | 'resolved' | 'rejected' | 'promoted' | 'review_required';
type RunnerManifestAction = 'plan' | 'start' | 'skip' | 'fail' | 'stop' | 'kill' | 'complete';

const CAPABILITY_KINDS: CapabilityKind[] = ['skill', 'specialist_agent', 'runtime_adapter', 'deterministic_harness', 'memory_source', 'dashboard_action'];
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
    const status = this.swarmStatus().getStatus();
    const capabilities = this.listCapabilities(100);
    const claims = this.listClaims(100);
    const capacity = this.planCapacityV2({});
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
    }
    return this.getClaim(id);
  }

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

  planCapacityV2(input: WorkerPoolPlanInput = {}): CapacityPlanV2Result {
    const plan = this.swarmStatus().planWorkerPool(input);
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

  private capabilityBlockedReasons(capability: Omit<SwarmCapabilityRecord, 'live_route_allowed' | 'blocked_reasons'>): string[] {
    const blocked: string[] = [];
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
}
