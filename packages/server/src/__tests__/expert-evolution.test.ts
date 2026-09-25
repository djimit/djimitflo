import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertResolverService } from '../services/expert-resolver-service';
import { ExpertEvidenceEnrichmentService } from '../services/expert-evidence-enrichment-service';
import type { ArxivPaper } from '../services/knowledge-adapters/arxiv-adapter';

const paper = (id: string, title: string, categories: string[], summary = ''): ArxivPaper => ({ arxiv_id: id, url: `http://arxiv.org/abs/${id}`, title, summary, authors: ['Jane Doe'], categories, primary_category: categories[0], published: '2026-01-01T00:00:00Z' });

describe('continuous evolution and deprecation (§54 §55 I12)', () => {
  let db: Database.Database;
  let registry: FrontierExpertRegistryService;
  let resolver: ExpertResolverService;
  let expertId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    registry = new FrontierExpertRegistryService(db);
    registry.seedTaxonomy();
    resolver = new ExpertResolverService(db);
    const expert = registry.discover({ canonicalName: 'Jane Doe', provenance: { source: 'test' }, actor: 'ingestion:test' });
    expertId = expert.id;
    const first = new ExpertEvidenceEnrichmentService(db, { registry, source: { async searchAuthorPapers() { return [paper('1', 'Scaling laws for neural language models', ['cs.LG'])]; } } });
    expect((await first.enrich(expertId, { actor: 'ingestion:arxiv' })).capability_delta).toEqual(['scaling_laws']);
    registry.transition(expertId, 'CHECKED', { actor: 'checker' });
    registry.transition(expertId, 'APPROVED', { actor: 'approver' });
    registry.transition(expertId, 'ACTIVE', { actor: 'approver' });
  });
  afterEach(() => db.close());

  it('a new source yields a capability delta that is versioned but not recommended until checked and approved by different actors', async () => {
    const versionsBefore = registry.versions(expertId).length;
    const evolved = new ExpertEvidenceEnrichmentService(db, { registry, source: { async searchAuthorPapers() { return [paper('1', 'Scaling laws for neural language models', ['cs.LG']), paper('2', 'Prompt injection defences for tool-using agents', ['cs.CR'], 'adaptive attackers')]; } } });
    const result = await evolved.enrich(expertId, { actor: 'ingestion:arxiv' });
    expect(result).toMatchObject({ lifecycle_state: 'ACTIVE', evidence_added: 1, capability_delta: ['ai_security'] });
    // Unchanged evidence keeps the approved status; the new capability is a governed delta.
    expect(db.prepare('SELECT capability_id, status FROM expert_capabilities WHERE expert_id = ? ORDER BY capability_id').all(expertId)).toEqual([{ capability_id: 'ai_security', status: 'inferred' }, { capability_id: 'scaling_laws', status: 'approved' }]);
    expect(registry.versions(expertId).length).toBeGreaterThan(versionsBefore);
    const question = 'Which prompt injection defences survive adaptive attackers?';
    expect(resolver.resolve(question).abstained).toBe(true); // inferred delta on an ACTIVE expert is not recommended yet
    expect(resolver.resolve('Explain scaling laws').experts[0].capabilities.map((capability) => capability.id)).toEqual(['scaling_laws']);

    expect(() => registry.reviewCapability(expertId, 'ai_security', 'approved', { actor: 'human-a' })).toThrow('EXPERT_CAPABILITY_TRANSITION_INVALID');
    expect(() => registry.reviewCapability(expertId, 'ai_security', 'checked', { actor: 'ingestion:arxiv' })).toThrow('EXPERT_GOVERNANCE_ACTOR_REQUIRED');
    registry.reviewCapability(expertId, 'ai_security', 'checked', { actor: 'human-a' });
    expect(() => registry.reviewCapability(expertId, 'ai_security', 'approved', { actor: 'human-a' })).toThrow('EXPERT_APPROVER_MUST_DIFFER_FROM_CHECKER');
    registry.reviewCapability(expertId, 'ai_security', 'approved', { actor: 'human-b' });
    expect(resolver.resolve(question).experts[0].expert_id).toBe(expertId);
    expect(registry.versions(expertId).map((version) => version.change_summary)).toContain('capability ai_security approved');
  });

  it('deprecation removes the expert from recommendation while evidence, claims and history stay queryable AS OF', async () => {
    const before = registry.versions(expertId).at(-1)!.created_at;
    await new Promise((resolve) => setTimeout(resolve, 5)); // version timestamps have millisecond resolution
    expect(resolver.resolve('Explain scaling laws').experts[0].expert_id).toBe(expertId);
    expect(() => registry.deprecate(expertId, { reason: 'stale', actor: 'system:cron' })).toThrow('EXPERT_GOVERNANCE_ACTOR_REQUIRED');
    const revoked = registry.deprecate(expertId, { reason: 'misattributed', actor: 'human-a', note: 'papers belong to a namesake' });
    expect(revoked.lifecycle_state).toBe('REVOKED');
    expect(resolver.resolve('Explain scaling laws').abstained).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ?').get(expertId) as { n: number }).n).toBe(1);
    expect(registry.asOf(expertId, before)).toMatchObject({ identity: { lifecycle_state: 'ACTIVE' } });
    expect((db.prepare("SELECT reason FROM expert_lifecycle_events WHERE expert_id = ? AND to_state = 'REVOKED'").get(expertId) as { reason: string }).reason).toBe('deprecated:misattributed papers belong to a namesake');
    // Pre-governance identities are rejected, not revoked; nothing is deleted either way.
    const fresh = registry.discover({ canonicalName: 'Only Signed', provenance: { source: 'pacingthefrontier' }, actor: 'ingestion:pacing' });
    expect(registry.deprecate(fresh.id, { reason: 'unsupported', actor: 'human-a' }).lifecycle_state).toBe('REJECTED');
  });
});
