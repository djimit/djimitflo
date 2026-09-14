import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertEvidenceEnrichmentService, identityConfidence, normalizeName } from '../services/expert-evidence-enrichment-service';
import { abstractFromInvertedIndex, authorDisplayName, OpenAlexAdapter, parseOpenAlexWorks } from '../services/knowledge-adapters/openalex-adapter';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'openalex-leike.json'), 'utf8'));

describe('OpenAlex works adapter as Tier-1 evidence source (§10, I10)', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  it('maps a real works response onto the paper shape: names reordered, arXiv ids from DOIs, topics as categories, duplicates collapsed', () => {
    expect(authorDisplayName('Leike, Jan')).toBe('Jan Leike');
    expect(authorDisplayName('Plain Name')).toBe('Plain Name');
    expect(abstractFromInvertedIndex({ world: [1], Hello: [0] })).toBe('Hello world');
    const papers = parseOpenAlexWorks(fixture);
    expect(fixture.results).toHaveLength(3);
    expect(papers).toHaveLength(2); // the same title appears twice in OpenAlex (DOI + non-DOI record)
    expect(papers[1]).toMatchObject({ arxiv_id: '2601.04728', url: 'https://arxiv.org/abs/2601.04728', primary_category: 'Artificial Intelligence' });
    expect(papers[1].authors).toContain('Jan Leike');
    expect(papers[1].categories).toContain('Computer Science');
    expect(papers[1].summary.length).toBeGreaterThan(50);
    expect(normalizeName('Leike, Jan')).toBe('jan leike');
    expect(identityConfidence(papers, 'Jan Leike')).toMatchObject({ ai_share: 1 });
  });

  it('enriches through a fake fetch and stores arXiv-canonical evidence; HTTP failures surface as source errors', async () => {
    const registry = new FrontierExpertRegistryService(db);
    registry.seedTaxonomy();
    const expert = registry.discover({ canonicalName: 'Jan Leike', provenance: { source: 'test' }, actor: 'ingestion:test' });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify(fixture), { status: 200, headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
    const service = new ExpertEvidenceEnrichmentService(db, { registry, source: new OpenAlexAdapter(fetchImpl) });
    const result = await service.enrich(expert.id, { actor: 'ingestion:openalex' });
    expect(calls[0]).toContain('raw_author_name.search');
    expect(result).toMatchObject({ papers_found: 2, papers_matched: 2, ai_share: 1, evidence_added: 2, lifecycle_state: 'CAPABILITY_INFERRED' });
    expect(result.capabilities.map((capability) => capability.id)).toContain('ai_security'); // 'Universal Jailbreaks' in the title
    const evidence = db.prepare('SELECT source_ref, canonical_origin, source_family, tier FROM expert_evidence WHERE expert_id = ?').all(expert.id) as Array<{ source_ref: string; canonical_origin: string; source_family: string; tier: number }>;
    expect(evidence.sort((a, b) => a.source_ref.localeCompare(b.source_ref))).toEqual([
      { source_ref: 'arxiv:2601.04603', canonical_origin: 'https://arxiv.org/abs/2601.04603', source_family: 'arxiv.org', tier: 1 },
      { source_ref: 'arxiv:2601.04728', canonical_origin: 'https://arxiv.org/abs/2601.04728', source_family: 'arxiv.org', tier: 1 },
    ]);
    expect(JSON.parse(registry.get(expert.id)!.provenance_json).enrichment.source).toBe('openalex');
    const failing = new OpenAlexAdapter((async () => new Response('busy', { status: 429 })) as typeof fetch);
    await expect(failing.searchAuthorPapers('Anyone')).rejects.toThrow('OPENALEX_HTTP_429');
  });
});
