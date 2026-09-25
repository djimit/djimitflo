import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService } from './frontier-expert-registry-service';
import { ExpertEvidenceEnrichmentService } from './expert-evidence-enrichment-service';
import type { ArxivPaper } from './knowledge-adapters/arxiv-adapter';

/**
 * E2 (Frontier Experts 2.0): expertise units beyond people. Prod 2026-09-25: 1 365 distinct arXiv papers were stored only
 * as evidence under persons, and 100 of their abstracts link 89 code repositories — none of it usable on its own.
 * This materialises each stored paper, and each repository a paper links, as its own expert identity (kind 'paper' /
 * 'repository') through the normal governed lifecycle:
 *   DISCOVERED → IDENTITY_RESOLVED (an arXiv id / repo path is unambiguous) → EVIDENCE_COLLECTED → CAPABILITY_INFERRED.
 * It never goes further: CHECKED/APPROVED/ACTIVE stay two different humans (I06), and the registry refuses automated
 * actors there anyway. No network: only evidence already stored. FRONTIER_EXPERT_SOURCE_UNITS_ENABLED=true (default off).
 */
export const sourceUnitsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FRONTIER_EXPERT_SOURCE_UNITS_ENABLED === 'true';

const ACTOR = 'ingestion:source-units';
const REPO = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;

interface StoredPaper { source_ref: string; title: string; url: string | null; metadata_json: string }

export class ExpertSourceUnitsService {
  private readonly registry: FrontierExpertRegistryService;
  private readonly enrichment: ExpertEvidenceEnrichmentService;
  constructor(private readonly db: Database) {
    this.registry = new FrontierExpertRegistryService(db);
    this.enrichment = new ExpertEvidenceEnrichmentService(db, { registry: this.registry });
  }

  /** Materialises up to `limit` new units; returns how many papers and repositories became units this call. */
  materialize(limit = 20): { papers: number; repositories: number } {
    const known = new Set((this.db.prepare("SELECT aliases_json FROM expert_identities WHERE kind IN ('paper', 'repository')").all() as Array<{ aliases_json: string }>)
      .flatMap((row) => JSON.parse(row.aliases_json) as string[]));
    const rows = this.db.prepare(`SELECT source_ref, title, url, metadata_json FROM expert_evidence
      WHERE kind = 'paper' AND lifecycle = 'active' GROUP BY source_ref ORDER BY MIN(created_at)`).all() as StoredPaper[];
    let papers = 0; let repositories = 0;
    for (const row of rows) {
      if (papers + repositories >= limit) break;
      const meta = JSON.parse(row.metadata_json || '{}') as { abstract?: string; categories?: string[]; primary_category?: string | null; published?: string | null; authors?: string[]; arxiv_id?: string };
      const paper: ArxivPaper = { arxiv_id: meta.arxiv_id ?? row.source_ref, url: row.url ?? '', title: row.title, summary: meta.abstract ?? '', authors: meta.authors ?? [], categories: meta.categories ?? [], primary_category: meta.primary_category ?? null, published: meta.published ?? null };
      const capabilities = this.enrichment.capabilitiesFor(paper);
      if (!known.has(row.source_ref) && capabilities.length) {
        this.unit('paper', row.title, row.source_ref, { kind: 'paper', title: row.title, url: row.url, sourceRef: row.source_ref, metadata: { ...meta, derived: 'stored-evidence' } }, capabilities, { authors: meta.authors ?? [] });
        known.add(row.source_ref); papers += 1;
      }
      for (const m of (meta.abstract ?? '').matchAll(REPO)) {
        const slug = `${m[1]}/${m[2].replace(/[.)]+$/, '').replace(/\.git$/, '')}`.toLowerCase();
        const ref = `github:${slug}`;
        if (known.has(ref) || !capabilities.length || papers + repositories >= limit) continue;
        this.unit('repository', slug, ref, { kind: 'repository', title: slug, url: `https://github.com/${slug}`, sourceRef: ref, metadata: { linked_from: row.source_ref, paper_title: row.title } }, capabilities, { linked_from: row.source_ref });
        known.add(ref); repositories += 1;
      }
    }
    return { papers, repositories };
  }

  private unit(kind: 'paper' | 'repository', name: string, ref: string, evidence: Parameters<FrontierExpertRegistryService['addEvidence']>[1], capabilities: string[], provenance: Record<string, unknown>): void {
    const expert = this.registry.discover({ canonicalName: name, aliases: [ref], kind, provenance: { source: 'stored-evidence', ref, ...provenance }, actor: ACTOR });
    // an arXiv id or a repository path identifies the unit exactly: no namesake problem as with people
    this.registry.resolveIdentity(expert.id, { confidence: 1, actor: ACTOR, reason: `${kind} identified by ${ref}` });
    const evidenceId = this.registry.addEvidence(expert.id, evidence);
    this.registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: ACTOR, reason: `${kind} evidence`, evidenceRefs: [evidenceId] });
    // one piece of evidence per unit: modest confidence; a repository inherits its paper's topics at lower confidence
    for (const capability of capabilities) this.registry.inferCapability(expert.id, { capability, confidence: kind === 'paper' ? 0.6 : 0.5, evidenceRefs: [evidenceId], derivedBy: `source-units:${kind}` });
    this.registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: ACTOR, reason: `${capabilities.length} capability(ies) from ${kind} evidence` });
  }
}
