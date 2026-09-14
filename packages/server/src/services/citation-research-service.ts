/**
 * CitationResearchService — source registry, citation links and contradiction checks.
 *
 * Source trust is only a domain/type heuristic. Registered URLs do not verify
 * claim content; claims stay unverified until a source-content verifier exists.
 *
 * Inspired by Hermes citation-gated research and Perplexity's
 * source-based answer generation.
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface Source {
  id: string;
  url: string;
  title: string;
  source_type: 'web' | 'document' | 'database' | 'api' | 'legal_database';
  trust_score: number; // 0-1
  last_verified: string | null;
  metadata: Record<string, unknown>;
}

interface Claim {
  id: string;
  text: string;
  confidence: number;
  source_ids: string[];
  verified: boolean;
  created_at: string;
}

interface Contradiction {
  id: string;
  claim_a_id: string;
  claim_b_id: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  detected_at: string;
}

interface ResearchReport {
  id: string;
  title: string;
  summary: string;
  claims: Claim[];
  sources: Source[];
  contradictions: Contradiction[];
  overall_confidence: number;
  generated_at: string;
}

export class CitationResearchService {
  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Register a research source with trust scoring.
   */
  registerSource(input: {
    url: string;
    title: string;
    source_type: Source['source_type'];
    metadata?: Record<string, unknown>;
  }): Source {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url.trim());
    } catch {
      throw new Error('RESEARCH_SOURCE_URL_INVALID');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error('RESEARCH_SOURCE_URL_INVALID');
    }
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) {
      throw new Error('RESEARCH_SOURCE_TITLE_INVALID');
    }
    if (!['web', 'document', 'database', 'api', 'legal_database'].includes(input.source_type)) {
      throw new Error('RESEARCH_SOURCE_TYPE_INVALID');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const source: Source = {
      id,
      url: parsedUrl.toString(),
      title: input.title.trim(),
      source_type: input.source_type,
      trust_score: this.estimateTrustScore(parsedUrl.hostname, input.source_type),
      last_verified: null,
      metadata: input.metadata || {},
    };

    this.db.prepare(`
      INSERT INTO research_sources (id, url, title, source_type, trust_score, last_verified, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(source.id, source.url, source.title, source.source_type, source.trust_score, source.last_verified, JSON.stringify(source.metadata), now);

    return source;
  }

  /**
   * Create a citation-linked claim.
   */
  createClaim(input: {
    text: string;
    source_ids: string[];
    confidence?: number;
  }): Claim {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10_000) {
      throw new Error('RESEARCH_CLAIM_TEXT_INVALID');
    }
    if (!Array.isArray(input.source_ids) || input.source_ids.length === 0 || input.source_ids.length > 50
      || input.source_ids.some((sourceId) => typeof sourceId !== 'string' || !sourceId.trim())) {
      throw new Error('RESEARCH_SOURCES_REQUIRED');
    }
    if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new Error('RESEARCH_CLAIM_CONFIDENCE_INVALID');
    }

    const sourceIds = [...new Set(input.source_ids)];
    const sourceRows = this.db.prepare(
      `SELECT id FROM research_sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`,
    ).all(...sourceIds) as Array<{ id: string }>;
    if (sourceRows.length !== sourceIds.length) throw new Error('RESEARCH_SOURCE_NOT_FOUND');

    const id = randomUUID();
    const now = new Date().toISOString();
    const claim: Claim = {
      id,
      text: input.text.trim(),
      confidence: input.confidence ?? 0,
      source_ids: sourceIds,
      // A registered URL and domain-level trust estimate do not prove claim support.
      verified: false,
      created_at: now,
    };

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO research_claims (id, text, confidence, source_ids_json, verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(claim.id, claim.text, claim.confidence, JSON.stringify(claim.source_ids), claim.verified ? 1 : 0, now);

      for (const sourceId of sourceIds) {
        this.db.prepare(`
          INSERT INTO research_citations (id, claim_id, source_id, excerpt, relevance_score, verified, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), claim.id, sourceId, '', 0, 0, now);
      }
    })();

    return claim;
  }

  /**
   * Detect contradictions between claims.
   */
  detectContradictions(): Contradiction[] {
    const claims = (this.db.prepare('SELECT * FROM research_claims').all() as any[]).map((row) => ({
      id: row.id,
      text: row.text,
      confidence: row.confidence,
      source_ids: JSON.parse(row.source_ids_json || '[]'),
    }));

    const contradictions: Contradiction[] = [];

    // Simple contradiction detection: claims with overlapping sources but opposing sentiment
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i];
        const b = claims[j];

        // Check if they share sources
        const sharedSources = a.source_ids.filter((s: string) => b.source_ids.includes(s));
        if (sharedSources.length === 0) continue;

        // Check for opposing keywords (broader pattern matching)
        const opposingPatterns = [
          [' is ', ' is not '],
          [' wel ', ' niet '],
          ['bevestigd', 'ontkend'],
          ['juist', 'onjuist'],
          ['correct', 'incorrect'],
          ['schuldig', 'onschuldig'],
          ['guilty', 'innocent'],
          ['ja', 'nee'],
          ['true', 'false'],
          ['waar', 'onwaar'],
        ];

        for (const [pos, neg] of opposingPatterns) {
          const aHasPos = a.text.toLowerCase().includes(pos);
          const aHasNeg = a.text.toLowerCase().includes(neg);
          const bHasPos = b.text.toLowerCase().includes(pos);
          const bHasNeg = b.text.toLowerCase().includes(neg);

          if ((aHasPos && bHasNeg) || (aHasNeg && bHasPos)) {
            const contradiction: Contradiction = {
              id: randomUUID(),
              claim_a_id: a.id,
              claim_b_id: b.id,
              severity: sharedSources.length > 1 ? 'high' : 'medium',
              description: `Contradiction detected: "${a.text.slice(0, 60)}..." vs "${b.text.slice(0, 60)}..."`,
              detected_at: new Date().toISOString(),
            };

            const existing = this.db.prepare(`
              SELECT id, claim_a_id, claim_b_id, severity, description, detected_at
              FROM research_contradictions
              WHERE (claim_a_id = ? AND claim_b_id = ?) OR (claim_a_id = ? AND claim_b_id = ?)
              LIMIT 1
            `).get(contradiction.claim_a_id, contradiction.claim_b_id, contradiction.claim_b_id, contradiction.claim_a_id) as any;
            if (existing) {
              contradictions.push({
                id: existing.id,
                claim_a_id: existing.claim_a_id,
                claim_b_id: existing.claim_b_id,
                severity: existing.severity,
                description: existing.description,
                detected_at: existing.detected_at,
              });
            } else {
              this.db.prepare(`
                INSERT INTO research_contradictions (id, claim_a_id, claim_b_id, severity, description, detected_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `).run(contradiction.id, contradiction.claim_a_id, contradiction.claim_b_id, contradiction.severity, contradiction.description, contradiction.detected_at);
              contradictions.push(contradiction);
            }
            break;
          }
        }
      }
    }

    return contradictions;
  }

  /**
   * Generate a research report with full audit trail.
   */
  generateReport(input: {
    title: string;
    claim_ids?: string[];
  }): ResearchReport {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) {
      throw new Error('RESEARCH_REPORT_TITLE_INVALID');
    }
    const id = randomUUID();
    const now = new Date().toISOString();

    // Get claims
    let claims: Claim[];
    if (input.claim_ids !== undefined) {
      if (!Array.isArray(input.claim_ids) || input.claim_ids.length === 0 || input.claim_ids.length > 100
        || input.claim_ids.some((claimId) => typeof claimId !== 'string' || !claimId.trim())) {
        throw new Error('RESEARCH_REPORT_CLAIM_IDS_INVALID');
      }
      const claimIds = [...new Set(input.claim_ids)];
      const placeholders = claimIds.map(() => '?').join(',');
      claims = (this.db.prepare(`SELECT * FROM research_claims WHERE id IN (${placeholders})`).all(...claimIds) as any[]).map(parseClaim);
      if (claims.length !== claimIds.length) throw new Error('RESEARCH_CLAIM_NOT_FOUND');
    } else {
      claims = (this.db.prepare('SELECT * FROM research_claims ORDER BY created_at DESC LIMIT 50').all() as any[]).map(parseClaim);
    }
    if (claims.length === 0) throw new Error('RESEARCH_CLAIMS_REQUIRED');

    // Only contradictions between claims included in this report are relevant.
    const reportClaimIds = new Set(claims.map((claim) => claim.id));
    const contradictions = this.detectContradictions().filter((contradiction) =>
      reportClaimIds.has(contradiction.claim_a_id) && reportClaimIds.has(contradiction.claim_b_id));
    if (contradictions.some((contradiction) => contradiction.severity === 'high')) {
      throw new Error('RESEARCH_REPORT_HIGH_SEVERITY_CONTRADICTION');
    }

    // Get sources referenced by claims
    const sourceIds = [...new Set(claims.flatMap((c) => c.source_ids))];
    const sources: Source[] = [];
    for (const sid of sourceIds) {
      const row = this.db.prepare('SELECT * FROM research_sources WHERE id = ?').get(sid) as any;
      if (row) sources.push(parseSource(row));
    }

    // Calculate overall confidence
    const verifiedClaims = claims.filter((claim) => claim.verified);
    const overallConfidence = verifiedClaims.length > 0
      ? verifiedClaims.reduce((sum, claim) => sum + claim.confidence, 0) / verifiedClaims.length
      : 0;

    const report: ResearchReport = {
      id,
      title: input.title,
      summary: `Research report with ${claims.length} claims from ${sources.length} sources; ${claims.length - verifiedClaims.length} unverified. ${contradictions.length} contradictions detected.`,
      claims,
      sources,
      contradictions,
      overall_confidence: overallConfidence,
      generated_at: now,
    };

    // Store report
    this.db.prepare(`
      INSERT INTO research_reports (id, title, summary, claims_json, sources_json, contradictions_json, overall_confidence, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(report.id, report.title, report.summary, JSON.stringify(report.claims), JSON.stringify(report.sources), JSON.stringify(report.contradictions), report.overall_confidence, now);

    return report;
  }

  /**
   * Get sources by minimum trust score.
   */
  getTrustedSources(minTrust = 0.7): Source[] {
    return (this.db.prepare('SELECT * FROM research_sources WHERE trust_score >= ? ORDER BY trust_score DESC').all(minTrust) as any[]).map(parseSource);
  }

  /**
   * Get research statistics.
   */
  getStats(): {
    totalSources: number;
    totalClaims: number;
    totalCitations: number;
    totalContradictions: number;
    avgTrustScore: number;
    totalReports: number;
  } {
    const sources = (this.db.prepare('SELECT COUNT(*) as c, AVG(trust_score) as avg FROM research_sources').get() as any) || { c: 0, avg: 0 };
    const claims = (this.db.prepare('SELECT COUNT(*) as c FROM research_claims').get() as any)?.c || 0;
    const citations = (this.db.prepare('SELECT COUNT(*) as c FROM research_citations').get() as any)?.c || 0;
    const contradictions = (this.db.prepare('SELECT COUNT(*) as c FROM research_contradictions').get() as any)?.c || 0;
    const reports = (this.db.prepare('SELECT COUNT(*) as c FROM research_reports').get() as any)?.c || 0;

    return {
      totalSources: sources.c,
      totalClaims: claims,
      totalCitations: citations,
      totalContradictions: contradictions,
      avgTrustScore: sources.avg || 0,
      totalReports: reports,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private estimateTrustScore(hostname: string, sourceType: Source['source_type']): number {
    // Base trust by source type
    const baseTrust: Record<string, number> = {
      legal_database: 0.95,
      database: 0.85,
      document: 0.75,
      api: 0.70,
      web: 0.50,
    };

    let score = baseTrust[sourceType] ?? 0.5;

    // Boost for known trusted domains
    const trustedDomains = ['overheid.nl', 'rechtspraak.nl', 'wetten.overheid.nl', 'eur-lex.europa.eu', 'gov.uk', 'europa.eu'];
    if (trustedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      score = Math.min(1, score + 0.2);
    }

    return score;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_sources (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'web',
        trust_score REAL NOT NULL DEFAULT 0.5,
        last_verified TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS research_claims (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS research_citations (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        excerpt TEXT NOT NULL DEFAULT '',
        relevance_score REAL NOT NULL DEFAULT 0.5,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (claim_id) REFERENCES research_claims(id) ON DELETE CASCADE,
        FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS research_contradictions (
        id TEXT PRIMARY KEY,
        claim_a_id TEXT NOT NULL,
        claim_b_id TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        description TEXT NOT NULL DEFAULT '',
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS research_reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        claims_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        contradictions_json TEXT NOT NULL DEFAULT '[]',
        overall_confidence REAL NOT NULL DEFAULT 0,
        generated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_research_claims_source_ids ON research_claims(source_ids_json);
      CREATE INDEX IF NOT EXISTS idx_research_citations_claim_id ON research_citations(claim_id);
      CREATE INDEX IF NOT EXISTS idx_research_citations_source_id ON research_citations(source_id);
      CREATE INDEX IF NOT EXISTS idx_research_contradictions_claim_a ON research_contradictions(claim_a_id);
    `);
  }
}

function parseClaim(row: any): Claim {
  return {
    id: row.id,
    text: row.text,
    confidence: row.confidence,
    source_ids: JSON.parse(row.source_ids_json || '[]'),
    verified: Boolean(row.verified),
    created_at: row.created_at,
  };
}

function parseSource(row: any): Source {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    source_type: row.source_type,
    trust_score: row.trust_score,
    last_verified: row.last_verified ?? null,
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}
