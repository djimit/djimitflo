import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CitationResearchService } from '../services/citation-research-service';

describe('CitationResearchService', () => {
  let db: Database.Database;
  let service: CitationResearchService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    service = new CitationResearchService(db);
  });

  it('registers a source with auto trust score', () => {
    const source = service.registerSource({
      url: 'https://wetten.overheid.nl/BWBR0012345',
      title: 'Wetboek van Strafrecht',
      source_type: 'legal_database',
    });
    expect(source.id).toBeDefined();
    expect(source.trust_score).toBeGreaterThan(0.9);
    expect(source.last_verified).toBeNull();
  });

  it('registers a web source with lower trust', () => {
    const source = service.registerSource({
      url: 'https://example.com/article',
      title: 'Random Blog Post',
      source_type: 'web',
    });
    expect(source.trust_score).toBeLessThan(0.7);
  });

  it('creates a citation-linked claim', () => {
    const source = service.registerSource({
      url: 'https://wetspraak.nl/ecli',
      title: 'ECLI:NL:RBAMS:2026:1234',
      source_type: 'legal_database',
    });

    const claim = service.createClaim({
      text: 'De rechter heeft geoordeeld dat...',
      source_ids: [source.id],
    });

    expect(claim.id).toBeDefined();
    expect(claim.verified).toBe(false);
    expect(claim.confidence).toBe(0);
    expect((db.prepare('SELECT verified, excerpt, relevance_score FROM research_citations').get() as any))
      .toMatchObject({ verified: 0, excerpt: '', relevance_score: 0 });
  });

  it('rejects a claim without source references', () => {
    expect(() => service.createClaim({ text: 'This is an unverified claim', source_ids: [] }))
      .toThrow('RESEARCH_SOURCES_REQUIRED');
  });

  it('does not persist a partial claim when any referenced source is missing', () => {
    const source = service.registerSource({ url: 'https://example.com', title: 'Fixture', source_type: 'document' });

    expect(() => service.createClaim({ text: 'A sourced claim', source_ids: [source.id, 'missing'] }))
      .toThrow('RESEARCH_SOURCE_NOT_FOUND');
    expect(service.getStats()).toMatchObject({ totalClaims: 0, totalCitations: 0 });
  });

  it('matches trusted hostnames rather than URL substrings', () => {
    for (const url of [
      'https://overheid.nl.attacker.test/source',
      'https://attacker.test/?redirect=overheid.nl',
    ]) {
      const source = service.registerSource({ url, title: 'Spoofed authority', source_type: 'web' });
      expect(source.trust_score).toBe(0.5);
    }
  });

  it('rejects unsafe source URLs and ignores caller-supplied trust values', () => {
    expect(() => service.registerSource({ url: 'javascript:alert(1)', title: 'Bad', source_type: 'web' }))
      .toThrow('RESEARCH_SOURCE_URL_INVALID');
    const source = service.registerSource({
      url: 'https://example.com', title: 'Untrusted', source_type: 'web', trust_score: 1,
    } as any);
    expect(source.trust_score).toBe(0.5);
  });

  it('detects contradictions between opposing claims', () => {
    const source = service.registerSource({
      url: 'https://example.com',
      title: 'Test Source',
      source_type: 'document',
    });

    service.createClaim({ text: 'Het is correct dat de verdachte aanwezig was', source_ids: [source.id] });
    service.createClaim({ text: 'Het is incorrect dat de verdachte aanwezig was', source_ids: [source.id] });

    const contradictions = service.detectContradictions();
    expect(contradictions.length).toBeGreaterThan(0);
  });

  it('generates a research report', () => {
    const source = service.registerSource({
      url: 'https://wetten.overheid.nl',
      title: 'Test',
      source_type: 'legal_database',
    });
    const claim = service.createClaim({
      text: 'Test claim with source',
      source_ids: [source.id],
    });

    const report = service.generateReport({
      title: 'Test Research Report',
      claim_ids: [claim.id],
    });

    expect(report.id).toBeDefined();
    expect(report.title).toBe('Test Research Report');
    expect(report.claims.length).toBe(1);
    expect(report.sources.length).toBe(1);
    expect(report.overall_confidence).toBe(0);
  });

  it('blocks reports with high-severity contradictions between included claims', () => {
    const first = service.registerSource({ url: 'https://wetten.overheid.nl/first', title: 'First', source_type: 'legal_database' });
    const second = service.registerSource({ url: 'https://rechtspraak.nl/second', title: 'Second', source_type: 'legal_database' });
    const positive = service.createClaim({ text: 'The rule is correct', source_ids: [first.id, second.id] });
    const negative = service.createClaim({ text: 'The rule is not correct', source_ids: [first.id, second.id] });

    expect(service.detectContradictions().some((item) => item.severity === 'high')).toBe(true);
    expect(() => service.generateReport({ title: 'Conflicted report', claim_ids: [positive.id, negative.id] }))
      .toThrow('RESEARCH_REPORT_HIGH_SEVERITY_CONTRADICTION');
    expect(service.getStats().totalReports).toBe(0);
  });

  it('rejects empty or partially missing report claim selections', () => {
    const source = service.registerSource({ url: 'https://example.com/rule', title: 'Fixture', source_type: 'document' });
    const claim = service.createClaim({ text: 'A claim', source_ids: [source.id] });

    expect(() => service.generateReport({ title: 'Empty', claim_ids: [] }))
      .toThrow('RESEARCH_REPORT_CLAIM_IDS_INVALID');
    expect(() => service.generateReport({ title: 'Missing', claim_ids: [claim.id, 'missing'] }))
      .toThrow('RESEARCH_CLAIM_NOT_FOUND');
    expect(service.getStats().totalReports).toBe(0);
  });

  it('gets trusted sources', () => {
    service.registerSource({
      url: 'https://wetten.overheid.nl',
      title: 'Trusted',
      source_type: 'legal_database',
    });
    service.registerSource({
      url: 'https://random-blog.com',
      title: 'Untrusted',
      source_type: 'web',
    });

    const trusted = service.getTrustedSources(0.8);
    expect(trusted.length).toBe(1);
    expect(trusted[0].title).toBe('Trusted');
  });

  it('provides stats', () => {
    service.registerSource({
      url: 'https://example.com',
      title: 'Test',
      source_type: 'document',
    });

    const stats = service.getStats();
    expect(stats.totalSources).toBe(1);
    expect(stats.avgTrustScore).toBeGreaterThan(0);
  });
});
