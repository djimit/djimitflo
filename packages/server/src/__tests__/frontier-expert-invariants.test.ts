import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { CAPABILITY_TAXONOMY, FrontierExpertRegistryService, frontierExpertsEnabled } from '../services/frontier-expert-registry-service';

describe('frontier expert invariants (.codex/frontier-expert-intelligence.md §42)', () => {
  let db: Database.Database;
  let registry: FrontierExpertRegistryService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    registry = new FrontierExpertRegistryService(db);
  });

  afterEach(() => db.close());

  function discovered(name = 'Ada Example') {
    return registry.discover({ canonicalName: name, aliases: ['A. Example'], provenance: { source: 'pacingthefrontier.com', statement: 'signature', retrieved_at: '2026-09-13T00:00:00Z' }, actor: 'ingestion:pacing' });
  }

  it('is feature-flagged off by default and seeds the §7 taxonomy with aliases', () => {
    expect(frontierExpertsEnabled({})).toBe(false);
    expect(frontierExpertsEnabled({ DJIMITFLO_FRONTIER_EXPERTS_ENABLED: 'true' })).toBe(true);
    expect(registry.seedTaxonomy()).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_capability_taxonomy').get() as { n: number }).n).toBe(CAPABILITY_TAXONOMY.length);
    expect(registry.resolveCapability('RLHF')).toBe('reinforcement_learning');
    expect(registry.resolveCapability('Mechanistic interpretability')).toBe('mechanistic_interpretability');
    expect(registry.resolveCapability('astrology')).toBeNull();
    runMigrations(db);
    expect(registry.seedTaxonomy()).toBe(0);
  });

  it('I01/I02: a signature alone never carries a capability, and a capability needs existing active Tier-1/2 evidence', () => {
    const expert = discovered();
    registry.resolveIdentity(expert.id, { confidence: 0.95, actor: 'resolver' });
    const signature = registry.addEvidence(expert.id, { kind: 'signature', title: 'Pacing the Frontier statement', sourceRef: 'pacing:sig:1', url: 'https://www.pacingthefrontier.com/#ada' });
    expect(() => registry.inferCapability(expert.id, { capability: 'alignment', confidence: 0.9, evidenceRefs: [signature], derivedBy: 'ingestion' })).toThrow('EXPERT_CAPABILITY_EVIDENCE_INSUFFICIENT');
    expect(() => registry.inferCapability(expert.id, { capability: 'alignment', confidence: 0.9, evidenceRefs: [], derivedBy: 'ingestion' })).toThrow('EXPERT_CAPABILITY_EVIDENCE_REQUIRED');
    expect(() => registry.inferCapability(expert.id, { capability: 'alignment', confidence: 0.9, evidenceRefs: ['evidence:doesnotexist'], derivedBy: 'ingestion' })).toThrow('EXPERT_CAPABILITY_EVIDENCE_INSUFFICIENT');
    const secondary = registry.addEvidence(expert.id, { kind: 'secondary', title: 'News article', sourceRef: 'news:1', url: 'https://news.example.com/ada' });
    expect(() => registry.inferCapability(expert.id, { capability: 'alignment', confidence: 0.9, evidenceRefs: [secondary], derivedBy: 'ingestion' })).toThrow('EXPERT_CAPABILITY_EVIDENCE_INSUFFICIENT');
    // The lifecycle cannot advance to EVIDENCE_COLLECTED on a signature? It can (evidence exists) but never to CAPABILITY_INFERRED.
    registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: 'ingestion' });
    expect(() => registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: 'ingestion' })).toThrow('EXPERT_CAPABILITY_EVIDENCE_REQUIRED');
    // A paper does qualify, and the same URL re-ingested yields the same immutable evidence id.
    const paper = registry.addEvidence(expert.id, { kind: 'paper', title: 'Scalable oversight via debate', sourceRef: 'arxiv:2401.00001', url: 'https://arxiv.org/abs/2401.00001' });
    expect(registry.addEvidence(expert.id, { kind: 'paper', title: 'Scalable oversight via debate (v2)', sourceRef: 'arxiv:2401.00001', url: 'https://arxiv.org/abs/2401.00001' })).toBe(paper);
    expect(registry.inferCapability(expert.id, { capability: 'scalable oversight', confidence: 0.8, evidenceRefs: [paper], derivedBy: 'capability-deriver' })).toBe('scalable_oversight');
    expect(db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ?").get(expert.id)).toEqual({ n: 3 });
  });

  it('I03: an ambiguous identity fails closed and cannot advance', () => {
    const expert = discovered('J. Smith');
    const ambiguous = registry.resolveIdentity(expert.id, { confidence: 0.4, actor: 'resolver', reason: 'three candidates share the name' });
    expect(ambiguous.lifecycle_state).toBe('AMBIGUOUS');
    expect(() => registry.transition(expert.id, 'IDENTITY_RESOLVED', { actor: 'resolver' })).toThrow('EXPERT_IDENTITY_AMBIGUOUS');
    registry.resolveIdentity(expert.id, { confidence: 0.9, actor: 'resolver', evidenceRefs: [], reason: 'ORCID match' });
    expect(registry.get(expert.id)!.lifecycle_state).toBe('IDENTITY_RESOLVED');
  });

  it('I06/I07/I08/I12: governed path to ACTIVE with separate checker and approver, provenance, contradiction block and versions', () => {
    const expert = discovered('Grace Example');
    registry.resolveIdentity(expert.id, { confidence: 0.92, actor: 'resolver' });
    const paper = registry.addEvidence(expert.id, { kind: 'paper', title: 'Circuits in vision models', sourceRef: 'arxiv:2001.00001', url: 'https://arxiv.org/abs/2001.00001' });
    const page = registry.addEvidence(expert.id, { kind: 'institutional_page', title: 'Interpretability team page', sourceRef: 'lab:page', url: 'https://lab.example.org/research/interp' });
    registry.addAffiliation(expert.id, { organization: 'Example Lab', role: 'researcher', validFrom: '2020-01-01', validTo: '2023-06-30', sourceRef: 'lab:page', confidence: 0.9 });
    registry.addAffiliation(expert.id, { organization: 'Frontier Co', role: 'lead', validFrom: '2023-07-01', sourceRef: 'lab:page', confidence: 0.8 });
    registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: 'ingestion' });
    registry.inferCapability(expert.id, { capability: 'mechanistic_interpretability', confidence: 0.85, evidenceRefs: [paper, page], derivedBy: 'capability-deriver' });
    registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: 'ingestion' });

    // I08: an unresolved critical contradiction blocks approval.
    const a = registry.addClaim({ expertId: expert.id, subject: 'superposition', relation: 'explains', object: 'polysemantic neurons', evidenceRefs: [paper], confidence: 0.8, criticality: 'critical' });
    const b = registry.addClaim({ expertId: expert.id, subject: 'superposition', relation: 'explains', object: 'polysemantic neurons', polarity: 'denies', evidenceRefs: [page], confidence: 0.6, criticality: 'critical' });
    const relation = registry.relateClaims(a, b, 'CONTRADICTS', 'opposite polarity on the same proposition');
    registry.transition(expert.id, 'CHECKED', { actor: 'checker-agent', reason: 'evidence reviewed' });
    expect(() => registry.transition(expert.id, 'APPROVED', { actor: 'human-reviewer' })).toThrow('EXPERT_CRITICAL_CONTRADICTION_UNRESOLVED');
    registry.resolveContradiction(relation, 'human-reviewer', 'QUALIFIES');

    // I06: the checker cannot approve its own check; ingestion/system actors cannot approve at all.
    expect(() => registry.transition(expert.id, 'APPROVED', { actor: 'checker-agent' })).toThrow('EXPERT_APPROVER_MUST_DIFFER_FROM_CHECKER');
    expect(() => registry.transition(expert.id, 'APPROVED', { actor: 'ingestion:pacing' })).toThrow('EXPERT_GOVERNANCE_ACTOR_REQUIRED');
    registry.transition(expert.id, 'APPROVED', { actor: 'human-reviewer', reason: 'primary evidence confirmed' });
    const active = registry.transition(expert.id, 'ACTIVE', { actor: 'human-reviewer' });
    expect(active.lifecycle_state).toBe('ACTIVE');

    // I07: attribution keeps provenance down to the evidence rows.
    const provenance = registry.provenance(expert.id);
    expect(provenance).toEqual([expect.objectContaining({ capability_id: 'mechanistic_interpretability', status: 'approved' })]);
    expect(provenance[0].evidence.map((item) => item.kind).sort()).toEqual(['institutional_page', 'paper']);
    expect(provenance[0].evidence.every((item) => item.tier === 1)).toBe(true);

    // §29 temporal affiliations.
    expect(registry.affiliationsAsOf(expert.id, '2022-01-01').map((row) => row.organization)).toEqual(['Example Lab']);
    expect(registry.affiliationsAsOf(expert.id, '2024-01-01').map((row) => row.organization)).toEqual(['Frontier Co']);

    // I12: every substantive change produced a version; historical state is queryable and audited.
    const versions = registry.versions(expert.id);
    expect(versions.length).toBeGreaterThanOrEqual(8);
    expect(versions[0].change_summary).toBe('discovered');
    expect(registry.asOf(expert.id, '1999-01-01')).toBeNull();
    expect((registry.asOf(expert.id, new Date(Date.now() + 1000).toISOString()) as any).identity.lifecycle_state).toBe('ACTIVE');
    expect((db.prepare("SELECT COUNT(*) AS n FROM expert_lifecycle_events WHERE expert_id = ?").get(expert.id) as { n: number }).n).toBe(7);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE resource_id = ? AND action = 'frontier_expert_approved'").get(expert.id) as { n: number }).n).toBe(1);

    // §31: a retracted paper strips the capability's evidence and the expert becomes STALE, history intact.
    const impact = registry.markEvidence(paper, 'retracted', 'human-reviewer');
    expect(impact.affected_experts).toEqual([expert.id]);
    expect(registry.get(expert.id)!.lifecycle_state).toBe('ACTIVE'); // the institutional page still qualifies
    registry.markEvidence(page, 'superseded', 'human-reviewer');
    expect(registry.get(expert.id)!.lifecycle_state).toBe('STALE');
    expect(registry.versions(expert.id).length).toBeGreaterThan(versions.length);
  });

  it('rejects invalid transitions and self-promotion shortcuts', () => {
    const expert = discovered();
    expect(() => registry.transition(expert.id, 'ACTIVE', { actor: 'human-reviewer' })).toThrow('EXPERT_TRANSITION_INVALID:DISCOVERED->ACTIVE');
    expect(() => registry.transition(expert.id, 'APPROVED', { actor: 'human-reviewer' })).toThrow('EXPERT_TRANSITION_INVALID');
    registry.transition(expert.id, 'REJECTED', { actor: 'human-reviewer', reason: 'not a researcher' });
    expect(() => registry.transition(expert.id, 'IDENTITY_RESOLVED', { actor: 'resolver' })).toThrow('EXPERT_TRANSITION_INVALID:REJECTED->IDENTITY_RESOLVED');
  });
});
