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
    expect(claim.verified).toBe(true);
    expect(claim.confidence).toBeGreaterThan(0);
  });

  it('creates unverified claim without sources', () => {
    const claim = service.createClaim({
      text: 'This is an unverified claim',
      source_ids: [],
    });
    expect(claim.verified).toBe(false);
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
    expect(report.overall_confidence).toBeGreaterThan(0);
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
