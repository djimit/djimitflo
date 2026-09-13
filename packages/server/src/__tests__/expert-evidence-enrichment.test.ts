import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertEvidenceEnrichmentService, identityConfidence, normalizeName } from '../services/expert-evidence-enrichment-service';
import { parseArxivPapers, type ArxivPaper } from '../services/knowledge-adapters/arxiv-adapter';

const paper = (id: string, title: string, authors: string[], categories: string[], summary = ''): ArxivPaper => ({
  arxiv_id: id, url: `http://arxiv.org/abs/${id}`, title, summary, authors, categories, primary_category: categories[0] ?? null, published: '2024-05-01T00:00:00Z',
});

describe('expert evidence enrichment (§10 §11 §28 I01 I02 I03 I10)', () => {
  let db: Database.Database;
  let registry: FrontierExpertRegistryService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    registry = new FrontierExpertRegistryService(db);
    registry.seedTaxonomy();
  });

  afterEach(() => db.close());

  function discovered(name: string) {
    return registry.discover({ canonicalName: name, provenance: { source: 'pacingthefrontier', seed_title: 'Researcher, Lab' }, actor: 'ingestion:pacing' });
  }

  it('parses the arXiv Atom author view and normalises names', () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Scaling laws for
      neural language models</title><summary>We study empirical scaling laws.</summary><author><name>Jane Doe</name></author><author><name>Jos&#233; Pérez</name></author><category term="cs.LG"/><category term="stat.ML"/><arxiv:primary_category term="cs.LG"/><published>2024-01-02T00:00:00Z</published></entry><entry><id>x</id><title></title></entry></feed>`;
    const papers = parseArxivPapers(xml);
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ arxiv_id: '2401.00001v2', title: 'Scaling laws for neural language models', authors: ['Jane Doe', 'José Pérez'], categories: ['cs.LG', 'stat.ML'], primary_category: 'cs.LG' });
    expect(normalizeName('  José  PÉREZ ')).toBe('jose perez');
  });

  it('resolves an exact-name AI author, attaches Tier-1 papers and infers capabilities with evidence refs', async () => {
    const expert = discovered('Jane Doe');
    const source = { async searchAuthorPapers() { return [
      paper('2401.00001', 'Scaling laws for neural language models', ['Jane Doe', 'A. Other'], ['cs.LG'], 'Compute-optimal training across scales.'),
      paper('2402.00002', 'Debate as scalable oversight', ['Jane Doe'], ['cs.AI'], 'We study alignment via debate.'),
      paper('2403.00003', 'Interpretability circuits in transformers', ['Jane Doe'], ['cs.LG'], 'Mechanistic interpretability of attention heads.'),
    ]; } };
    const enrichment = new ExpertEvidenceEnrichmentService(db, { registry, source });
    const result = await enrichment.enrich(expert.id, { actor: 'ingestion:arxiv' });
    expect(result).toMatchObject({ papers_found: 3, papers_matched: 3, ai_share: 1, identity_confidence: 0.95, lifecycle_state: 'CAPABILITY_INFERRED', evidence_added: 3, reason: null });
    expect(result.capabilities.map((capability) => capability.id).sort()).toEqual(['alignment', 'mechanistic_interpretability', 'scalable_oversight', 'scaling_laws']);
    const provenance = registry.provenance(expert.id);
    expect(provenance.every((capability) => capability.evidence.length > 0 && capability.evidence.every((item) => item.kind === 'paper' && item.tier === 1))).toBe(true);
    expect(provenance.find((capability) => capability.capability_id === 'scaling_laws')!.evidence.map((item) => item.title)).toEqual(['Scaling laws for neural language models']);
    // Idempotent: a second run adds no evidence and keeps the state; governance states are untouched.
    const again = await enrichment.enrich(expert.id, { actor: 'ingestion:arxiv' });
    expect(again.evidence_added).toBe(0);
    expect(registry.get(expert.id)!.lifecycle_state).toBe('CAPABILITY_INFERRED');
    expect(() => registry.transition(expert.id, 'ACTIVE', { actor: 'ingestion:arxiv' })).toThrow('EXPERT_TRANSITION_INVALID');
  });

  it('fails closed on ambiguous names and attaches nothing (I03), and leaves unmatched names DISCOVERED (I10)', async () => {
    const smith = discovered('J. Smith');
    const mixed = { async searchAuthorPapers() { return [
      paper('1', 'Quantum chromodynamics on the lattice', ['J. Smith'], ['hep-lat']),
      paper('2', 'Soil moisture retrieval', ['J. Smith'], ['physics.geo-ph']),
      paper('3', 'Reinforcement learning for robots', ['J. Smith'], ['cs.RO']),
    ]; } };
    const ambiguous = await new ExpertEvidenceEnrichmentService(db, { registry, source: mixed }).enrich(smith.id, { actor: 'ingestion:arxiv' });
    expect(ambiguous).toMatchObject({ papers_matched: 3, lifecycle_state: 'AMBIGUOUS', evidence_added: 0, reason: 'identity_below_threshold' });
    expect(ambiguous.identity_confidence).toBeLessThan(0.8);
    expect((db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ?").get(smith.id) as { n: number }).n).toBe(0);

    const ghost = discovered('Nobody Published');
    const none = await new ExpertEvidenceEnrichmentService(db, { registry, source: { async searchAuthorPapers() { return [paper('9', 'Unrelated', ['Someone Else'], ['cs.LG'])]; } } }).enrich(ghost.id, { actor: 'ingestion:arxiv' });
    expect(none).toMatchObject({ papers_found: 1, papers_matched: 0, lifecycle_state: 'DISCOVERED', reason: 'no_author_match' });
    expect(identityConfidence([], 'x').confidence).toBe(0);
  });

  it('enriches a bounded batch of discovered experts oldest-first', async () => {
    for (const name of ['A One', 'B Two', 'C Three']) discovered(name);
    const source = { async searchAuthorPapers(name: string) { return name === 'C Three' ? [] : [paper(`p-${name}`, 'AI security evaluations of frontier models', [name], ['cs.CR', 'cs.AI'], 'red teaming')]; } };
    const results = await new ExpertEvidenceEnrichmentService(db, { registry, source }).enrichBatch({ actor: 'ingestion:arxiv', limit: 2 });
    expect(results.map((result) => [result.canonical_name, result.lifecycle_state])).toEqual([['A One', 'CAPABILITY_INFERRED'], ['B Two', 'CAPABILITY_INFERRED']]);
    // The next batch moves on to the untried identity; an unmatched one is marked attempted and not retried until retryBefore says so.
    const service = new ExpertEvidenceEnrichmentService(db, { registry, source });
    expect(service.pending()).toBe(1);
    expect((await service.enrichBatch({ actor: 'ingestion:arxiv', limit: 2 })).map((result) => [result.canonical_name, result.reason])).toEqual([['C Three', 'no_author_match']]);
    expect(service.pending()).toBe(0);
    expect(await service.enrichBatch({ actor: 'ingestion:arxiv', limit: 2 })).toEqual([]);
    expect((await service.enrichBatch({ actor: 'ingestion:arxiv', limit: 2, retryBefore: '2999-01-01' })).map((result) => result.canonical_name)).toEqual(['C Three']);
    // cs.CR maps to ai_security; "frontier models" is a frontier_model_engineering alias. "evaluations" alone is not an evals alias (no false positive).
    expect(results[0].capabilities.map((capability) => capability.id).sort()).toEqual(['ai_security', 'frontier_model_engineering']);
  });
});
