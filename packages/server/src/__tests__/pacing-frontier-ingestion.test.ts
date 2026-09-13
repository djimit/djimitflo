import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { PacingFrontierIngestionService, parsePacingFrontier, splitTitle } from '../services/pacing-frontier-ingestion-service';

/** Mirrors the real page: signatories and quotes live in a React flight payload as an escaped JS string. */
function page(signatories: Array<[string, string, string | null]>, quotes: Array<[string, string, string, string]> = []): string {
  const payload = JSON.stringify({
    signatories: signatories.map(([name, title, quoteId]) => ({ name, title, quoteId: quoteId ?? '$undefined' })),
    quotes: quotes.map(([id, name, title, quote]) => ({ id, name, title, quote })),
    signatoryCount: 1386,
  });
  const escaped = payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `<html><body><p class="text-[16px] font-medium">${signatories[0][0]}</p><script>self.__next_f.push([1,"0:${escaped}"])</script></body></html>`;
}

describe('Pacing the Frontier ingestion (§8 §33 I01)', () => {
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

  it('parses signatories, quotes and the count out of the flight payload', () => {
    const html = page([
      ['John Schulman', 'Chief Scientist, Thinking Machines', 'john-schulman'],
      ['Jan Leike', 'Anthropic', null],
      ['Shengjia Zhao', 'Chief Scientist, Meta AI', null],
      ['Shengjia Zhao', 'Chief Scientist, Meta AI', null], // duplicate row on the page
      ['Ana O\'Neil', 'Research Lead, Example & Co', null],
    ], [['0b2c1c2e-1111-4222-8333-444455556666', 'John Schulman', 'Chief Scientist, Thinking Machines', 'We should pace the frontier.\nSecond line.']]);
    const parsed = parsePacingFrontier(html);
    expect(parsed.signatory_count).toBe(1386);
    expect(parsed.signatories).toHaveLength(4);
    expect(parsed.signatories[0]).toEqual({ name: 'John Schulman', title: 'Chief Scientist, Thinking Machines', quote_id: 'john-schulman' });
    expect(parsed.signatories[1]).toEqual({ name: 'Jan Leike', title: 'Anthropic', quote_id: null });
    expect(parsed.signatories[3]).toEqual({ name: 'Ana O\'Neil', title: 'Research Lead, Example & Co', quote_id: null });
    expect(parsed.quotes).toEqual([{ id: '0b2c1c2e-1111-4222-8333-444455556666', name: 'John Schulman', title: 'Chief Scientist, Thinking Machines', quote: 'We should pace the frontier.\nSecond line.' }]);
    expect(splitTitle('Co-Founder and Chief Science Officer, Anthropic')).toEqual({ role: 'Co-Founder and Chief Science Officer', organization: 'Anthropic' });
    expect(splitTitle('Anthropic')).toEqual({ role: null, organization: 'Anthropic' });
    expect(() => parsePacingFrontier('<html>no payload</html>')).not.toThrow();
  });

  it('ingests idempotently as DISCOVERED identities with signature evidence that can never carry a capability', async () => {
    const html = page([['John Schulman', 'Chief Scientist, Thinking Machines', null], ['Jan Leike', 'Anthropic', null], ['Anonymous', 'Anthropic', null], ['Anonymous', 'Google', null]]);
    const ingestion = new PacingFrontierIngestionService(db, { registry, fetchImpl: (async () => { throw new Error('network must not be used when html is supplied'); }) as unknown as typeof fetch });
    const first = await ingestion.ingest({ actor: 'ingestion:pacing', html });
    expect(first).toMatchObject({ fetched: false, parsed: 4, discovered_new: 2, already_known: 0, evidence_added: 2, affiliations_added: 2, anonymous_skipped: 2 });
    const second = await ingestion.ingest({ actor: 'ingestion:pacing', html });
    expect(second).toMatchObject({ parsed: 4, discovered_new: 0, already_known: 2, affiliations_added: 0, anonymous_skipped: 2 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM expert_identities WHERE lower(canonical_name) = 'anonymous'").get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_identities').get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE kind = 'signature'").get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_source_snapshots').get() as { n: number }).n).toBe(2);

    const schulman = db.prepare("SELECT * FROM expert_identities WHERE canonical_name = 'John Schulman'").get() as any;
    expect(schulman.lifecycle_state).toBe('DISCOVERED');
    expect(JSON.parse(schulman.provenance_json)).toMatchObject({ source: 'pacingthefrontier', seed_title: 'Chief Scientist, Thinking Machines' });
    expect(registry.affiliationsAsOf(schulman.id, new Date().toISOString())).toEqual([expect.objectContaining({ organization: 'Thinking Machines', role: 'Chief Scientist' })]);
    // I01: a signature is tier-4 evidence and cannot support a capability or advance past discovery.
    const signature = db.prepare('SELECT id, tier FROM expert_evidence WHERE expert_id = ?').get(schulman.id) as { id: string; tier: number };
    expect(signature.tier).toBe(4);
    expect(() => registry.inferCapability(schulman.id, { capability: 'reinforcement_learning', confidence: 0.9, evidenceRefs: [signature.id], derivedBy: 'test' })).toThrow('EXPERT_CAPABILITY_EVIDENCE_INSUFFICIENT');
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_capabilities').get() as { n: number }).n).toBe(0);
    // Data minimisation: only name, self-stated title and comment are stored.
    expect(Object.keys(JSON.parse((db.prepare('SELECT metadata_json FROM expert_evidence WHERE id = ?').get(signature.id) as any).metadata_json)).sort()).toEqual(['public_comment', 'quote_id', 'self_stated_title', 'snapshot_id', 'statement']);
  });

  it('rate-limits live fetches to one per hour and fails loudly on an empty page', async () => {
    let fetches = 0;
    const html = page([['Jan Leike', 'Anthropic', null]]);
    const ingestion = new PacingFrontierIngestionService(db, { registry, fetchImpl: (async () => { fetches += 1; return new Response(html, { status: 200 }); }) as unknown as typeof fetch });
    expect((await ingestion.ingest({ actor: 'ingestion:pacing' })).fetched).toBe(true);
    expect((await ingestion.ingest({ actor: 'ingestion:pacing' })).skipped_reason).toBe('rate_limited');
    expect(fetches).toBe(1);
    await expect(ingestion.ingest({ actor: 'ingestion:pacing', html: '<html>nothing</html>' })).rejects.toThrow('PACING_PARSE_EMPTY');
  });
});
