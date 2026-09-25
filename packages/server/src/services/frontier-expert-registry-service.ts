/**
 * FrontierExpertRegistryService — identities, evidence, capabilities, claims and the
 * governed lifecycle behind Frontier Expert Intelligence (.codex/frontier-expert-intelligence.md).
 *
 * Invariants enforced here (tested in frontier-expert-invariants.test.ts):
 *   I01 a signature alone never yields ACTIVE expertise   I02 no capability without evidence
 *   I03 ambiguous identities cannot advance                I06 checker and approver are different actors
 *   I07 attribution keeps provenance                       I08 unresolved critical contradictions block approval
 *   I12 every substantive change produces a version snapshot that stays queryable AS OF a time
 * Feature-flagged: DJIMITFLO_FRONTIER_EXPERTS_ENABLED (default off in production paths).
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { AuditEventType } from '@djimitflo/shared';
import { AuditService } from './audit-service';

export type ExpertLifecycleState =
  | 'DISCOVERED' | 'IDENTITY_RESOLVED' | 'EVIDENCE_COLLECTED' | 'CAPABILITY_INFERRED' | 'CHECKED' | 'APPROVED' | 'ACTIVE'
  | 'AMBIGUOUS' | 'INSUFFICIENT_EVIDENCE' | 'CONTRADICTED' | 'STALE' | 'REJECTED' | 'REVOKED';
export type EvidenceKind = 'paper' | 'institutional_page' | 'technical_report' | 'repository' | 'presentation' | 'profile' | 'scholarly_metadata' | 'secondary' | 'signature' | 'other';
/** E2: who or what carries the expertise. Only people come from signatures; papers and repositories come from evidence. */
export type ExpertKind = 'person' | 'paper' | 'repository';
export type ClaimRelation = 'SUPPORTS' | 'CONTRADICTS' | 'QUALIFIES' | 'ORTHOGONAL' | 'UNDETERMINED';

export const IDENTITY_CONFIDENCE_THRESHOLD = 0.8;
/** Evidence kinds that may support a capability. Signatures and secondary reporting never do (§8, §10). */
export const CAPABILITY_EVIDENCE_KINDS: EvidenceKind[] = ['paper', 'institutional_page', 'technical_report', 'repository', 'presentation', 'profile', 'scholarly_metadata'];
const TIER_BY_KIND: Record<EvidenceKind, 1 | 2 | 3 | 4> = {
  paper: 1, institutional_page: 1, technical_report: 1, repository: 1, presentation: 1, profile: 1,
  scholarly_metadata: 2, secondary: 3, signature: 4, other: 4,
};

/** §7 initial taxonomy; extensible through the table. */
export const CAPABILITY_TAXONOMY: Array<{ id: string; label: string; aliases: string[]; parent?: string }> = [
  { id: 'frontier_model_engineering', label: 'Frontier model engineering', aliases: ['frontier models', 'large-scale training', 'pretraining'] },
  { id: 'scaling_laws', label: 'Scaling laws', aliases: ['scaling', 'compute-optimal training', 'neural scaling'] },
  { id: 'reinforcement_learning', label: 'Reinforcement learning', aliases: ['rl', 'policy optimization', 'policy optimisation', 'rlhf', 'reward hacking', 'sparse rewards'] },
  { id: 'agent_learning', label: 'Agent learning', aliases: ['agentic learning', 'learning agents', 'long-horizon agents', 'agents that learn'] },
  { id: 'post_training', label: 'Post-training', aliases: ['fine-tuning', 'instruction tuning', 'alignment training'] },
  { id: 'reasoning', label: 'Reasoning', aliases: ['chain of thought', 'test-time compute'] },
  { id: 'automated_ai_research', label: 'Automated AI research', aliases: ['ai for ai research', 'research automation', 'ai scientist', 'automated research', 'automated researchers', 'research agents', 'automating research', 'autonomous research', 'automated alignment research'] },
  { id: 'recursive_self_improvement', label: 'Recursive self-improvement', aliases: ['rsi', 'self-improving ai', 'self-improving', 'self-improvement', 'self-improve', 'recursive improvement', 'intelligence explosion', 'self-modifying'], parent: 'automated_ai_research' },
  { id: 'mechanistic_interpretability', label: 'Mechanistic interpretability', aliases: ['interpretability', 'circuits', 'features'] },
  { id: 'alignment', label: 'Alignment', aliases: ['ai alignment', 'value alignment'] },
  { id: 'scalable_oversight', label: 'Scalable oversight', aliases: ['debate', 'weak-to-strong', 'oversight'], parent: 'alignment' },
  { id: 'misalignment_detection', label: 'Misalignment detection', aliases: ['deception detection', 'sleeper agents', 'deceptive alignment'], parent: 'alignment' },
  { id: 'model_evaluations', label: 'Model evaluations', aliases: ['evals', 'benchmarks', 'capability evaluations'] },
  { id: 'safety_evaluations', label: 'Safety evaluations', aliases: ['dangerous capability evals', 'safety evals'], parent: 'model_evaluations' },
  { id: 'model_control', label: 'Model control', aliases: ['ai control', 'control protocols', 'control evaluations', 'trusted monitoring', 'untrusted monitoring', 'corrigibility', 'corrigible'] },
  { id: 'ai_security', label: 'AI security', aliases: ['ml security', 'adversarial robustness', 'model security', 'prompt injection', 'jailbreak', 'weight exfiltration', 'adaptive attackers', 'insider threat'] },
  { id: 'cyber_capabilities', label: 'Cyber capabilities', aliases: ['offensive cyber', 'cyber evals', 'cybersecurity', 'cyber security', 'capture the flag', 'vulnerability discovery', 'exploit', 'penetration testing', 'cyber offense'], parent: 'ai_security' },
  { id: 'model_resilience', label: 'Model resilience', aliases: ['robustness', 'jailbreak resistance'], parent: 'ai_security' },
  { id: 'frontier_risk', label: 'Frontier risk', aliases: ['catastrophic risk', 'frontier safety'] },
  { id: 'ai_governance', label: 'AI governance', aliases: ['governance', 'responsible scaling'] },
  { id: 'ai_policy', label: 'AI policy', aliases: ['public policy', 'regulation', 'legislation', 'policymakers'], parent: 'ai_governance' },
  { id: 'coordination_mechanisms', label: 'Coordination mechanisms', aliases: ['international coordination', 'compute governance', 'mechanism design', 'racing dynamics'], parent: 'ai_governance' },
  { id: 'human_ai_interaction', label: 'Human-AI interaction', aliases: ['hci', 'human-ai collaboration'] },
  { id: 'multi_agent_systems', label: 'Multi-agent systems', aliases: ['multi-agent', 'agent societies', 'autonomous agents', 'collusion', 'negotiation between agents'] },
  // E4 (2026-09-25): the engineering work Djimitflo itself does had no capability, so the resolver abstained on it.
  { id: 'ai_software_engineering', label: 'AI for software engineering', aliases: ['software engineering', 'large language models for code', 'llms for code', 'code llms'] },
  { id: 'code_generation', label: 'Code generation', aliases: ['program synthesis', 'code synthesis', 'code completion'], parent: 'ai_software_engineering' },
  { id: 'program_repair', label: 'Program repair', aliases: ['automated program repair', 'bug fixing', 'patch generation', 'fault localization', 'swe-bench'], parent: 'ai_software_engineering' },
  { id: 'software_testing', label: 'Software testing', aliases: ['test generation', 'unit test generation', 'mutation testing', 'flaky tests', 'fuzzing', 'regression testing'], parent: 'ai_software_engineering' },
  { id: 'coding_agents', label: 'Coding agents', aliases: ['software agents', 'swe-agent', 'agentic coding', 'code agents', 'repository-level'], parent: 'ai_software_engineering' },
];

const TRANSITIONS: Record<ExpertLifecycleState, ExpertLifecycleState[]> = {
  DISCOVERED: ['IDENTITY_RESOLVED', 'AMBIGUOUS', 'REJECTED'],
  IDENTITY_RESOLVED: ['EVIDENCE_COLLECTED', 'INSUFFICIENT_EVIDENCE', 'AMBIGUOUS', 'REJECTED'],
  EVIDENCE_COLLECTED: ['CAPABILITY_INFERRED', 'INSUFFICIENT_EVIDENCE', 'REJECTED'],
  CAPABILITY_INFERRED: ['CHECKED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE', 'REJECTED'],
  CHECKED: ['APPROVED', 'CONTRADICTED', 'REJECTED', 'CAPABILITY_INFERRED'],
  APPROVED: ['ACTIVE', 'REVOKED', 'STALE'],
  ACTIVE: ['STALE', 'REVOKED', 'CONTRADICTED'],
  AMBIGUOUS: ['IDENTITY_RESOLVED', 'REJECTED'],
  INSUFFICIENT_EVIDENCE: ['EVIDENCE_COLLECTED', 'REJECTED'],
  CONTRADICTED: ['CAPABILITY_INFERRED', 'REVOKED', 'REJECTED'],
  STALE: ['EVIDENCE_COLLECTED', 'REVOKED'],
  REJECTED: [],
  REVOKED: [],
};

export interface ExpertIdentityRow {
  id: string; canonical_name: string; aliases_json: string; lifecycle_state: ExpertLifecycleState; identity_confidence: number; kind?: ExpertKind;
  provenance_json: string; version: number; created_at: string; updated_at: string;
}
export interface ExpertEvidenceInput {
  kind: EvidenceKind; title: string; url?: string | null; sourceRef: string; canonicalOrigin?: string; sourceFamily?: string;
  retrievedAt?: string; contentHash?: string | null; metadata?: Record<string, unknown>;
}

export function frontierExpertsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED || '').trim().toLowerCase() === 'true';
}

export class FrontierExpertRegistryService {
  private readonly audit: AuditService;

  constructor(private readonly db: Database, deps: { audit?: AuditService } = {}) {
    this.audit = deps.audit ?? new AuditService(db);
  }

  seedTaxonomy(): number {
    // Upsert so alias improvements reach existing databases (§54); ids are stable, so nothing referencing them breaks.
    const upsert = this.db.prepare(`INSERT INTO expert_capability_taxonomy (id, label, description, parent_id, aliases_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, parent_id = excluded.parent_id, aliases_json = excluded.aliases_json WHERE aliases_json != excluded.aliases_json OR label != excluded.label`);
    let changed = 0;
    for (const entry of CAPABILITY_TAXONOMY) changed += upsert.run(entry.id, entry.label, '', entry.parent ?? null, JSON.stringify(entry.aliases)).changes;
    return changed;
  }

  /** Resolve a capability id from an id, label or alias (case-insensitive). */
  resolveCapability(text: string): string | null {
    const needle = text.trim().toLowerCase();
    if (!needle) return null;
    const rows = this.db.prepare('SELECT id, label, aliases_json FROM expert_capability_taxonomy').all() as Array<{ id: string; label: string; aliases_json: string }>;
    for (const row of rows) {
      if (row.id === needle || row.label.toLowerCase() === needle) return row.id;
      if ((JSON.parse(row.aliases_json) as string[]).some((alias) => alias.toLowerCase() === needle)) return row.id;
    }
    return null;
  }

  discover(input: { canonicalName: string; aliases?: string[]; provenance: Record<string, unknown>; actor: string; kind?: ExpertKind }): ExpertIdentityRow {
    const id = `expert:${randomUUID()}`;
    this.db.prepare('INSERT INTO expert_identities (id, canonical_name, aliases_json, lifecycle_state, identity_confidence, provenance_json, version, kind) VALUES (?, ?, ?, ?, 0, ?, 1, ?)')
      .run(id, input.canonicalName.trim(), JSON.stringify(input.aliases ?? []), 'DISCOVERED', JSON.stringify(input.provenance), input.kind ?? 'person');
    this.event(id, null, 'DISCOVERED', input.actor, 'discovered', []);
    this.snapshot(id, 'discovered');
    return this.get(id)!;
  }

  /** Bounded listing for operators and tools; filters by lifecycle state, capability id and a name fragment. */
  list(filter: { state?: string; capability?: string; name?: string; limit?: number } = {}): Array<ExpertIdentityRow & { capabilities: string[] }> {
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    const rows = this.db.prepare(`SELECT DISTINCT e.* FROM expert_identities e
      ${filter.capability ? "JOIN expert_capabilities c ON c.expert_id = e.id AND c.status != 'revoked' AND c.capability_id = @capability" : ''}
      WHERE (@state IS NULL OR e.lifecycle_state = @state) AND (@name IS NULL OR e.canonical_name LIKE @name)
      ORDER BY e.updated_at DESC LIMIT @limit`).all({ capability: filter.capability ?? null, state: filter.state ?? null, name: filter.name ? `%${filter.name}%` : null, limit }) as ExpertIdentityRow[];
    const capabilities = this.db.prepare("SELECT capability_id FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'");
    return rows.map((row) => ({ ...row, capabilities: (capabilities.all(row.id) as Array<{ capability_id: string }>).map((item) => item.capability_id) }));
  }

  get(id: string): ExpertIdentityRow | null {
    return (this.db.prepare('SELECT * FROM expert_identities WHERE id = ?').get(id) as ExpertIdentityRow | undefined) ?? null;
  }

  /** Identity resolution result. Below threshold the expert becomes AMBIGUOUS and fails closed (I03). */
  resolveIdentity(expertId: string, input: { confidence: number; actor: string; evidenceRefs?: string[]; reason?: string }): ExpertIdentityRow {
    const confidence = Math.max(0, Math.min(1, input.confidence));
    this.db.prepare('UPDATE expert_identities SET identity_confidence = ?, updated_at = datetime(\'now\') WHERE id = ?').run(confidence, expertId);
    return this.transition(expertId, confidence >= IDENTITY_CONFIDENCE_THRESHOLD ? 'IDENTITY_RESOLVED' : 'AMBIGUOUS', { actor: input.actor, reason: input.reason ?? `identity confidence ${confidence.toFixed(2)}`, evidenceRefs: input.evidenceRefs });
  }

  /** Immutable evidence; deterministic id so re-ingestion never duplicates. Returns the id either way. */
  addEvidence(expertId: string | null, input: ExpertEvidenceInput): string {
    const canonicalOrigin = (input.canonicalOrigin ?? input.url ?? input.sourceRef).trim();
    const id = `evidence:${createHash('sha256').update(`${expertId ?? ''}|${input.kind}|${canonicalOrigin}`).digest('hex').slice(0, 32)}`;
    const family = input.sourceFamily ?? this.familyOf(canonicalOrigin);
    this.db.prepare(`INSERT OR IGNORE INTO expert_evidence (id, expert_id, kind, tier, title, url, source_ref, source_family, canonical_origin, retrieved_at, content_hash, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, expertId, input.kind, TIER_BY_KIND[input.kind], input.title.slice(0, 500), input.url ?? null, input.sourceRef, family, canonicalOrigin, input.retrievedAt ?? new Date().toISOString(), input.contentHash ?? null, JSON.stringify(input.metadata ?? {}));
    return id;
  }

  addAffiliation(expertId: string, input: { organization: string; role?: string; validFrom?: string; validTo?: string; sourceRef: string; confidence?: number }): string {
    const id = `affiliation:${randomUUID()}`;
    this.db.prepare('INSERT INTO expert_affiliations (id, expert_id, organization, role, valid_from, valid_to, source_ref, retrieved_at, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, expertId, input.organization, input.role ?? null, input.validFrom ?? null, input.validTo ?? null, input.sourceRef, new Date().toISOString(), input.confidence ?? 0.5);
    this.snapshot(expertId, `affiliation ${input.organization}`);
    return id;
  }

  affiliationsAsOf(expertId: string, at: string): Array<{ organization: string; role: string | null; valid_from: string | null; valid_to: string | null; source_ref: string }> {
    return this.db.prepare(`SELECT organization, role, valid_from, valid_to, source_ref FROM expert_affiliations
      WHERE expert_id = ? AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?) ORDER BY valid_from`).all(expertId, at, at) as any;
  }

  /**
   * Evidence-derived capability (I02). Every ref must exist, belong to this expert, be active and be
   * of a kind that can carry expertise: a Pacing signature or secondary reporting never qualifies (I01).
   */
  inferCapability(expertId: string, input: { capability: string; confidence: number; evidenceRefs: string[]; derivedBy: string }): string {
    const capabilityId = this.resolveCapability(input.capability);
    if (!capabilityId) throw new Error('EXPERT_CAPABILITY_UNKNOWN');
    const refs = [...new Set(input.evidenceRefs.map((ref) => ref.trim()).filter(Boolean))];
    if (!refs.length) throw new Error('EXPERT_CAPABILITY_EVIDENCE_REQUIRED');
    const qualifying = this.qualifyingEvidence(expertId, refs);
    if (qualifying.length !== refs.length) throw new Error('EXPERT_CAPABILITY_EVIDENCE_INSUFFICIENT');
    const id = `capability:${randomUUID()}`;
    this.db.prepare(`INSERT INTO expert_capabilities (id, expert_id, capability_id, confidence, evidence_refs_json, derived_by, status) VALUES (?, ?, ?, ?, ?, ?, 'inferred')
      ON CONFLICT(expert_id, capability_id) DO UPDATE SET confidence = excluded.confidence, evidence_refs_json = excluded.evidence_refs_json, derived_by = excluded.derived_by,
        -- §54: unchanged evidence keeps the governed status; a changed evidence set is a delta that must be re-checked.
        status = CASE WHEN expert_capabilities.evidence_refs_json = excluded.evidence_refs_json AND expert_capabilities.status != 'revoked' THEN expert_capabilities.status ELSE 'inferred' END,
        updated_at = datetime('now')`)
      .run(id, expertId, capabilityId, Math.max(0, Math.min(1, input.confidence)), JSON.stringify(refs), input.derivedBy);
    this.snapshot(expertId, `capability ${capabilityId}`);
    return capabilityId;
  }

  addClaim(input: { expertId?: string | null; subject: string; relation: string; object: string; conditions?: string; scope?: string; polarity?: 'asserts' | 'denies' | 'qualifies'; temporalScope?: string; evidenceRefs: string[]; confidence: number; criticality?: 'normal' | 'critical' }): string {
    const refs = [...new Set(input.evidenceRefs.filter(Boolean))];
    if (!refs.length) throw new Error('EXPERT_CLAIM_EVIDENCE_REQUIRED');
    const known = this.db.prepare(`SELECT COUNT(*) AS n FROM expert_evidence WHERE id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(refs)) as { n: number };
    if (known.n !== refs.length) throw new Error('EXPERT_CLAIM_EVIDENCE_UNKNOWN');
    const families = this.db.prepare(`SELECT COUNT(DISTINCT source_family) AS n FROM expert_evidence WHERE id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(refs)) as { n: number };
    const id = `claim:${randomUUID()}`;
    this.db.prepare(`INSERT INTO expert_claims (id, expert_id, subject, relation, object, conditions, scope, polarity, temporal_scope, evidence_refs_json, confidence, source_independence, criticality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.expertId ?? null, input.subject, input.relation, input.object, input.conditions ?? '', input.scope ?? '', input.polarity ?? 'asserts', input.temporalScope ?? null, JSON.stringify(refs), Math.max(0, Math.min(1, input.confidence)), families.n, input.criticality ?? 'normal');
    return id;
  }

  relateClaims(fromClaimId: string, toClaimId: string, relation: ClaimRelation, rationale = ''): string {
    const id = `claim-relation:${randomUUID()}`;
    this.db.prepare('INSERT INTO expert_claim_relations (id, from_claim_id, to_claim_id, relation, rationale) VALUES (?, ?, ?, ?, ?)').run(id, fromClaimId, toClaimId, relation, rationale);
    if (relation === 'CONTRADICTS') {
      this.db.prepare("UPDATE expert_claims SET support_status = 'contradicted' WHERE id IN (?, ?)").run(fromClaimId, toClaimId);
    }
    return id;
  }

  resolveContradiction(relationId: string, actor: string, outcome: 'QUALIFIES' | 'ORTHOGONAL' | 'SUPPORTS'): void {
    this.db.prepare("UPDATE expert_claim_relations SET relation = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ?").run(outcome, actor, relationId);
  }

  hasUnresolvedCriticalContradiction(expertId: string): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM expert_claim_relations r
      JOIN expert_claims a ON a.id = r.from_claim_id JOIN expert_claims b ON b.id = r.to_claim_id
      WHERE r.relation = 'CONTRADICTS' AND r.resolved_at IS NULL AND (a.expert_id = ? OR b.expert_id = ?) AND (a.criticality = 'critical' OR b.criticality = 'critical')`).get(expertId, expertId) as { n: number };
    return row.n > 0;
  }

  /** Auditable lifecycle transition with the governance guards. Never called by ingestion for APPROVED/ACTIVE. */
  transition(expertId: string, to: ExpertLifecycleState, input: { actor: string; reason?: string; evidenceRefs?: string[] }): ExpertIdentityRow {
    const expert = this.get(expertId);
    if (!expert) throw new Error('EXPERT_NOT_FOUND');
    const from = expert.lifecycle_state;
    if (!TRANSITIONS[from].includes(to)) throw new Error(`EXPERT_TRANSITION_INVALID:${from}->${to}`);
    if ((to === 'IDENTITY_RESOLVED' || to === 'EVIDENCE_COLLECTED') && expert.identity_confidence < IDENTITY_CONFIDENCE_THRESHOLD) throw new Error('EXPERT_IDENTITY_AMBIGUOUS');
    if (to === 'EVIDENCE_COLLECTED' && !this.db.prepare("SELECT 1 FROM expert_evidence WHERE expert_id = ? AND lifecycle = 'active' LIMIT 1").get(expertId)) throw new Error('EXPERT_EVIDENCE_REQUIRED');
    if (to === 'CAPABILITY_INFERRED' || to === 'CHECKED' || to === 'APPROVED' || to === 'ACTIVE') {
      if (!this.hasQualifiedCapability(expertId)) throw new Error('EXPERT_CAPABILITY_EVIDENCE_REQUIRED');
    }
    if (to === 'APPROVED' || to === 'ACTIVE') {
      if (this.hasUnresolvedCriticalContradiction(expertId)) throw new Error('EXPERT_CRITICAL_CONTRADICTION_UNRESOLVED');
      const checker = this.lastActor(expertId, 'CHECKED');
      if (to === 'APPROVED' && (!checker || checker === input.actor)) throw new Error('EXPERT_APPROVER_MUST_DIFFER_FROM_CHECKER');
      if (/^(system|ingestion|swarm|autopilot)/i.test(input.actor)) throw new Error('EXPERT_GOVERNANCE_ACTOR_REQUIRED');
    }
    if (to === 'CHECKED') this.db.prepare("UPDATE expert_capabilities SET status = 'checked', updated_at = datetime('now') WHERE expert_id = ? AND status = 'inferred'").run(expertId);
    if (to === 'APPROVED') this.db.prepare("UPDATE expert_capabilities SET status = 'approved', updated_at = datetime('now') WHERE expert_id = ? AND status = 'checked'").run(expertId);
    if (to === 'REVOKED') this.db.prepare("UPDATE expert_capabilities SET status = 'revoked', updated_at = datetime('now') WHERE expert_id = ?").run(expertId);
    this.db.prepare("UPDATE expert_identities SET lifecycle_state = ?, updated_at = datetime('now') WHERE id = ?").run(to, expertId);
    this.event(expertId, from, to, input.actor, input.reason ?? '', input.evidenceRefs ?? []);
    this.snapshot(expertId, `${from} -> ${to}`);
    this.audit.record({
      event_type: to === 'APPROVED' || to === 'ACTIVE' ? AuditEventType.APPROVAL_GRANTED : to === 'REJECTED' || to === 'REVOKED' ? AuditEventType.APPROVAL_DENIED : AuditEventType.CONFIG_CHANGED,
      action: `frontier_expert_${to.toLowerCase()}`, resource_type: 'expert', resource_id: expertId, user_id: input.actor,
      metadata: { from, to, reason: input.reason ?? '', evidence_refs: input.evidenceRefs ?? [] },
    } as any);
    return this.get(expertId)!;
  }

  /** Version snapshot valid AS OF a moment (I12, §29, §30). */
  asOf(expertId: string, at: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT snapshot_json FROM expert_versions WHERE expert_id = ? AND created_at <= ? ORDER BY version DESC LIMIT 1').get(expertId, at) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) : null;
  }

  versions(expertId: string): Array<{ version: number; change_summary: string; created_at: string }> {
    return this.db.prepare('SELECT version, change_summary, created_at FROM expert_versions WHERE expert_id = ? ORDER BY version').all(expertId) as any;
  }

  /** Full evidence lineage for an expert: every capability with the evidence rows behind it (I07). */
  provenance(expertId: string): Array<{ capability_id: string; status: string; confidence: number; evidence: Array<{ id: string; kind: string; tier: number; title: string; url: string | null; source_family: string }> }> {
    const capabilities = this.db.prepare('SELECT capability_id, status, confidence, evidence_refs_json FROM expert_capabilities WHERE expert_id = ?').all(expertId) as Array<{ capability_id: string; status: string; confidence: number; evidence_refs_json: string }>;
    return capabilities.map((capability) => ({
      capability_id: capability.capability_id, status: capability.status, confidence: capability.confidence,
      evidence: this.db.prepare(`SELECT id, kind, tier, title, url, source_family FROM expert_evidence WHERE id IN (SELECT value FROM json_each(?))`).all(capability.evidence_refs_json) as any,
    }));
  }

  markEvidence(evidenceId: string, lifecycle: 'superseded' | 'retracted' | 'challenged', actor: string): { affected_experts: string[] } {
    this.db.prepare('UPDATE expert_evidence SET lifecycle = ? WHERE id = ?').run(lifecycle, evidenceId);
    const affected = (this.db.prepare(`SELECT DISTINCT expert_id FROM expert_capabilities WHERE EXISTS (SELECT 1 FROM json_each(evidence_refs_json) WHERE value = ?)`).all(evidenceId) as Array<{ expert_id: string }>).map((row) => row.expert_id);
    for (const expertId of affected) {
      // Retracted evidence can no longer carry a capability; an ACTIVE/APPROVED expert becomes STALE for re-check.
      if (!this.hasQualifiedCapability(expertId)) {
        const state = this.get(expertId)!.lifecycle_state;
        if (state === 'ACTIVE' || state === 'APPROVED') this.transition(expertId, 'STALE', { actor, reason: `evidence ${evidenceId} ${lifecycle}` });
      }
    }
    return { affected_experts: affected };
  }

  private qualifyingEvidence(expertId: string, refs: string[]): string[] {
    return (this.db.prepare(`SELECT id FROM expert_evidence WHERE expert_id = ? AND lifecycle = 'active' AND kind IN (${CAPABILITY_EVIDENCE_KINDS.map(() => '?').join(', ')}) AND id IN (SELECT value FROM json_each(?))`)
      .all(expertId, ...CAPABILITY_EVIDENCE_KINDS, JSON.stringify(refs)) as Array<{ id: string }>).map((row) => row.id);
  }

  private hasQualifiedCapability(expertId: string): boolean {
    const capabilities = this.db.prepare("SELECT evidence_refs_json FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'").all(expertId) as Array<{ evidence_refs_json: string }>;
    return capabilities.some((capability) => this.qualifyingEvidence(expertId, JSON.parse(capability.evidence_refs_json)).length > 0);
  }

  /**
   * Governed activation of a capability delta on an already ACTIVE/APPROVED expert (§54): a capability inferred
   * after activation stays 'inferred' (not recommended) until a checker marks it checked and a different
   * governance actor approves it. Revoking a single capability keeps the expert and its evidence history.
   */
  reviewCapability(expertId: string, capability: string, decision: 'checked' | 'approved' | 'revoked', input: { actor: string; reason?: string }): { capability_id: string; status: string } {
    const capabilityId = this.resolveCapability(capability);
    if (!capabilityId) throw new Error('EXPERT_CAPABILITY_UNKNOWN');
    const row = this.db.prepare('SELECT status FROM expert_capabilities WHERE expert_id = ? AND capability_id = ?').get(expertId, capabilityId) as { status: string } | undefined;
    if (!row) throw new Error('EXPERT_CAPABILITY_NOT_FOUND');
    if (/^(system|ingestion|swarm|autopilot)/i.test(input.actor)) throw new Error('EXPERT_GOVERNANCE_ACTOR_REQUIRED');
    const marker = (state: string) => `CAPABILITY_${state.toUpperCase()}:${capabilityId}`;
    if (decision === 'checked' && row.status !== 'inferred') throw new Error(`EXPERT_CAPABILITY_TRANSITION_INVALID:${row.status}->checked`);
    if (decision === 'approved') {
      if (row.status !== 'checked') throw new Error(`EXPERT_CAPABILITY_TRANSITION_INVALID:${row.status}->approved`);
      const checker = this.lastActor(expertId, marker('checked') as ExpertLifecycleState);
      if (!checker || checker === input.actor) throw new Error('EXPERT_APPROVER_MUST_DIFFER_FROM_CHECKER');
    }
    this.db.prepare("UPDATE expert_capabilities SET status = ?, updated_at = datetime('now') WHERE expert_id = ? AND capability_id = ?").run(decision, expertId, capabilityId);
    const expert = this.get(expertId)!;
    this.event(expertId, expert.lifecycle_state, marker(decision) as ExpertLifecycleState, input.actor, input.reason ?? '', []);
    this.snapshot(expertId, `capability ${capabilityId} ${decision}`);
    return { capability_id: capabilityId, status: decision };
  }

  /**
   * Controlled deactivation (§55): the expert leaves recommendation (REVOKED from governed states, REJECTED
   * before governance) with a typed reason; evidence, claims, events and versions stay queryable AS OF.
   */
  deprecate(expertId: string, input: { reason: 'stale' | 'unsupported' | 'superseded' | 'misattributed'; actor: string; note?: string }): ExpertIdentityRow {
    const expert = this.get(expertId);
    if (!expert) throw new Error('EXPERT_NOT_FOUND');
    if (/^(system|ingestion|swarm|autopilot)/i.test(input.actor)) throw new Error('EXPERT_GOVERNANCE_ACTOR_REQUIRED');
    const to: ExpertLifecycleState = TRANSITIONS[expert.lifecycle_state].includes('REVOKED') ? 'REVOKED' : 'REJECTED';
    return this.transition(expertId, to, { actor: input.actor, reason: `deprecated:${input.reason}${input.note ? ` ${input.note}` : ''}` });
  }

  private lastActor(expertId: string, state: ExpertLifecycleState): string | null {
    const row = this.db.prepare('SELECT actor FROM expert_lifecycle_events WHERE expert_id = ? AND to_state = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(expertId, state) as { actor: string } | undefined;
    return row?.actor ?? null;
  }

  private event(expertId: string, from: ExpertLifecycleState | null, to: ExpertLifecycleState, actor: string, reason: string, evidenceRefs: string[]): void {
    this.db.prepare('INSERT INTO expert_lifecycle_events (id, expert_id, from_state, to_state, actor, reason, evidence_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`lifecycle:${randomUUID()}`, expertId, from, to, actor, reason, JSON.stringify(evidenceRefs));
  }

  private snapshot(expertId: string, changeSummary: string): void {
    const expert = this.get(expertId);
    if (!expert) return;
    const version = (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM expert_versions WHERE expert_id = ?').get(expertId) as { v: number }).v + 1;
    const snapshot = {
      identity: { canonical_name: expert.canonical_name, aliases: JSON.parse(expert.aliases_json), lifecycle_state: expert.lifecycle_state, identity_confidence: expert.identity_confidence },
      affiliations: this.db.prepare('SELECT organization, role, valid_from, valid_to, source_ref FROM expert_affiliations WHERE expert_id = ?').all(expertId),
      capabilities: this.db.prepare('SELECT capability_id, confidence, status, evidence_refs_json FROM expert_capabilities WHERE expert_id = ?').all(expertId),
      evidence: this.db.prepare('SELECT id, kind, tier, lifecycle FROM expert_evidence WHERE expert_id = ?').all(expertId),
    };
    // ISO timestamps so AS OF comparisons work lexically against client-supplied instants.
    this.db.prepare('INSERT INTO expert_versions (id, expert_id, version, snapshot_json, change_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`version:${randomUUID()}`, expertId, version, JSON.stringify(snapshot), changeSummary, new Date().toISOString());
    this.db.prepare('UPDATE expert_identities SET version = ? WHERE id = ?').run(version, expertId);
  }

  private familyOf(origin: string): string {
    try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return origin.split(':')[0] || 'unknown'; }
  }
}
