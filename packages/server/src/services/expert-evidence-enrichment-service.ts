/**
 * ExpertEvidenceEnrichmentService — turn a DISCOVERED name into evidence-backed, capability-inferred
 * expertise or fail closed (§10 §11 §28 §54, I01 I02 I03 I10).
 *
 * Source: arXiv author search (Tier 1 papers via the existing ArxivAdapter). Identity resolution is a
 * transparent heuristic: exact author-name match, share of AI-related categories, number of papers.
 * Below the threshold the identity becomes AMBIGUOUS and NO evidence is attached to the person.
 * Capabilities are derived only from matched papers (title, abstract, categories → taxonomy aliases)
 * and every capability carries the paper ids that justify it. Lifecycle never advances past
 * CAPABILITY_INFERRED here: CHECKED / APPROVED / ACTIVE stay with governance.
 */

import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService, IDENTITY_CONFIDENCE_THRESHOLD } from './frontier-expert-registry-service';
import { ArxivAdapter, type ArxivPaper } from './knowledge-adapters/arxiv-adapter';

export interface AuthorPaperSource { searchAuthorPapers(name: string, limit?: number): Promise<ArxivPaper[]> }
export interface EnrichmentResult {
  expert_id: string;
  canonical_name: string;
  papers_found: number;
  papers_matched: number;
  ai_share: number;
  identity_confidence: number;
  lifecycle_state: string;
  evidence_added: number;
  capabilities: Array<{ id: string; confidence: number; evidence: number }>;
  reason: string | null;
}

const AI_CATEGORIES = new Set(['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.CR', 'cs.CY', 'cs.MA', 'cs.HC', 'cs.RO', 'stat.ML', 'cs.SE', 'cs.IR', 'cs.GT']);
/** arXiv categories that map directly onto a taxonomy capability. */
const CATEGORY_CAPABILITY: Record<string, string> = { 'cs.CR': 'ai_security', 'cs.CY': 'ai_governance', 'cs.MA': 'multi_agent_systems', 'cs.HC': 'human_ai_interaction' };

export function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Transparent identity heuristic (§12, §28): exact name matches only; AI-category share drives confidence. */
export function identityConfidence(papers: ArxivPaper[], name: string): { matched: ArxivPaper[]; ai_share: number; confidence: number } {
  const target = normalizeName(name);
  const matched = papers.filter((paper) => paper.authors.some((author) => normalizeName(author) === target));
  if (!matched.length) return { matched, ai_share: 0, confidence: 0 };
  const ai = matched.filter((paper) => paper.categories.some((category) => AI_CATEGORIES.has(category)) || (paper.primary_category ? AI_CATEGORIES.has(paper.primary_category) : false)).length;
  const share = ai / matched.length;
  const confidence = Math.min(0.95, 0.55 + 0.35 * share + (matched.length >= 3 ? 0.05 : 0));
  return { matched, ai_share: Number(share.toFixed(2)), confidence: Number(confidence.toFixed(2)) };
}

export class ExpertEvidenceEnrichmentService {
  private readonly registry: FrontierExpertRegistryService;
  private readonly source: AuthorPaperSource;

  constructor(private readonly db: Database, deps: { registry?: FrontierExpertRegistryService; source?: AuthorPaperSource } = {}) {
    this.registry = deps.registry ?? new FrontierExpertRegistryService(db);
    this.source = deps.source ?? new ArxivAdapter();
  }

  async enrich(expertId: string, input: { actor: string; maxPapers?: number }): Promise<EnrichmentResult> {
    const expert = this.registry.get(expertId);
    if (!expert) throw new Error('EXPERT_NOT_FOUND');
    const papers = await this.source.searchAuthorPapers(expert.canonical_name, input.maxPapers ?? 10);
    const identity = identityConfidence(papers, expert.canonical_name);
    const base = { expert_id: expertId, canonical_name: expert.canonical_name, papers_found: papers.length, papers_matched: identity.matched.length, ai_share: identity.ai_share, identity_confidence: identity.confidence };

    if (!identity.matched.length) {
      // I10: absence of arXiv evidence is not evidence of absence; the identity simply stays DISCOVERED.
      return { ...base, lifecycle_state: expert.lifecycle_state, evidence_added: 0, capabilities: [], reason: 'no_author_match' };
    }
    if (expert.lifecycle_state === 'DISCOVERED' || expert.lifecycle_state === 'AMBIGUOUS') {
      const resolved = this.registry.resolveIdentity(expertId, { confidence: identity.confidence, actor: input.actor, reason: `arxiv author match: ${identity.matched.length} paper(s), AI share ${identity.ai_share}` });
      if (resolved.lifecycle_state === 'AMBIGUOUS') {
        // I03: fail closed, attach nothing to a person we cannot pin down.
        return { ...base, lifecycle_state: 'AMBIGUOUS', evidence_added: 0, capabilities: [], reason: 'identity_below_threshold' };
      }
    } else if (expert.identity_confidence < IDENTITY_CONFIDENCE_THRESHOLD) {
      return { ...base, lifecycle_state: expert.lifecycle_state, evidence_added: 0, capabilities: [], reason: 'identity_below_threshold' };
    }

    const before = (this.db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ? AND kind = 'paper'").get(expertId) as { n: number }).n;
    const evidenceByCapability = new Map<string, Set<string>>();
    for (const paper of identity.matched) {
      const evidenceId = this.registry.addEvidence(expertId, {
        kind: 'paper', title: paper.title, url: paper.url, sourceRef: `arxiv:${paper.arxiv_id}`, canonicalOrigin: `https://arxiv.org/abs/${paper.arxiv_id.replace(/v\d+$/, '')}`,
        sourceFamily: 'arxiv.org', retrievedAt: new Date().toISOString(),
        metadata: { abstract: paper.summary.slice(0, 2_000), categories: paper.categories, primary_category: paper.primary_category, published: paper.published, authors: paper.authors.slice(0, 20), arxiv_id: paper.arxiv_id },
      });
      for (const capability of this.capabilitiesFor(paper)) {
        const set = evidenceByCapability.get(capability) ?? new Set<string>();
        set.add(evidenceId);
        evidenceByCapability.set(capability, set);
      }
    }
    const after = (this.db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ? AND kind = 'paper'").get(expertId) as { n: number }).n;
    const current = this.registry.get(expertId)!;
    if (current.lifecycle_state === 'IDENTITY_RESOLVED' || current.lifecycle_state === 'INSUFFICIENT_EVIDENCE' || current.lifecycle_state === 'STALE') {
      this.registry.transition(expertId, 'EVIDENCE_COLLECTED', { actor: input.actor, reason: `${identity.matched.length} arXiv paper(s)` });
    }

    const capabilities: EnrichmentResult['capabilities'] = [];
    for (const [capability, refs] of evidenceByCapability) {
      const confidence = Math.min(0.95, 0.5 + 0.15 * (refs.size - 1));
      this.registry.inferCapability(expertId, { capability, confidence, evidenceRefs: [...refs], derivedBy: 'arxiv-enrichment' });
      capabilities.push({ id: capability, confidence: Number(confidence.toFixed(2)), evidence: refs.size });
    }
    if (capabilities.length && this.registry.get(expertId)!.lifecycle_state === 'EVIDENCE_COLLECTED') {
      this.registry.transition(expertId, 'CAPABILITY_INFERRED', { actor: input.actor, reason: capabilities.map((capability) => capability.id).join(', ') });
    }
    return { ...base, lifecycle_state: this.registry.get(expertId)!.lifecycle_state, evidence_added: after - before, capabilities, reason: capabilities.length ? null : 'no_capability_derived' };
  }

  /** Enrich a bounded batch of DISCOVERED experts, oldest first (§51: bounded, incremental). */
  async enrichBatch(input: { actor: string; limit?: number; maxPapers?: number }): Promise<EnrichmentResult[]> {
    const rows = this.db.prepare("SELECT id FROM expert_identities WHERE lifecycle_state = 'DISCOVERED' ORDER BY created_at ASC LIMIT ?").all(Math.max(1, Math.min(50, input.limit ?? 10))) as Array<{ id: string }>;
    const results: EnrichmentResult[] = [];
    for (const row of rows) {
      try { results.push(await this.enrich(row.id, input)); } catch (error) { results.push({ expert_id: row.id, canonical_name: '', papers_found: 0, papers_matched: 0, ai_share: 0, identity_confidence: 0, lifecycle_state: 'DISCOVERED', evidence_added: 0, capabilities: [], reason: error instanceof Error ? error.message : 'ENRICH_FAILED' }); }
    }
    return results;
  }

  /** Capability ids a paper supports: direct category mappings plus taxonomy aliases found in title/abstract. */
  capabilitiesFor(paper: ArxivPaper): string[] {
    const found = new Set<string>();
    for (const category of paper.categories) { const mapped = CATEGORY_CAPABILITY[category]; if (mapped) found.add(mapped); }
    const text = `${paper.title} ${paper.summary}`.toLowerCase();
    for (const row of this.db.prepare('SELECT id, label, aliases_json FROM expert_capability_taxonomy').all() as Array<{ id: string; label: string; aliases_json: string }>) {
      const phrases = [row.label.toLowerCase(), row.id.replace(/_/g, ' '), ...(JSON.parse(row.aliases_json) as string[]).map((alias) => alias.toLowerCase())].filter((phrase) => phrase.length > 3);
      if (phrases.some((phrase) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))) found.add(row.id);
    }
    return [...found];
  }
}
