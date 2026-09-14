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
  /** Capability ids that did not exist on the expert before this run (§54: capability delta awaiting governance on ACTIVE experts). */
  capability_delta: string[];
  reason: string | null;
}

const AI_CATEGORIES = new Set(['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.CR', 'cs.CY', 'cs.MA', 'cs.HC', 'cs.RO', 'stat.ML', 'cs.SE', 'cs.IR', 'cs.GT']);
/** OpenAlex topic / subfield names that count as AI-adjacent for identity confidence. */
const AI_TOPIC = /artificial intelligence|machine learning|neural|deep learning|reinforcement learning|natural language|computer vision|language model|computer security|human-computer|robotics|information systems|software/i;
const isAiCategory = (category: string) => AI_CATEGORIES.has(category) || AI_TOPIC.test(category);
/** A paper counts as AI-related when any category code or topic label is AI-adjacent; non-AI papers under a matching name are namesake suspects (§12). */
export const isAiPaper = (paper: Pick<ArxivPaper, 'categories' | 'primary_category'>) => paper.categories.some(isAiCategory) || (paper.primary_category ? isAiCategory(paper.primary_category) : false);
/** arXiv categories that map directly onto a taxonomy capability. */
const CATEGORY_CAPABILITY: Record<string, string> = { 'cs.CR': 'ai_security', 'cs.CY': 'ai_governance', 'cs.MA': 'multi_agent_systems', 'cs.HC': 'human_ai_interaction' };

export function normalizeName(name: string): string {
  const [last, first] = name.split(',');
  const ordered = first !== undefined ? `${first} ${last}` : name;
  return ordered.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Transparent identity heuristic (§12, §28): exact name matches only; AI-category share drives confidence. */
export function identityConfidence(papers: ArxivPaper[], name: string): { matched: ArxivPaper[]; ai_share: number; confidence: number } {
  const target = normalizeName(name);
  const matched = papers.filter((paper) => paper.authors.some((author) => normalizeName(author) === target));
  if (!matched.length) return { matched, ai_share: 0, confidence: 0 };
  const ai = matched.filter(isAiPaper).length;
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
    this.sourceName = (this.source as { name?: string }).name ?? 'injected';
  }
  private readonly sourceName: string;

  async enrich(expertId: string, input: { actor: string; maxPapers?: number }): Promise<EnrichmentResult> {
    const expert = this.registry.get(expertId);
    if (!expert) throw new Error('EXPERT_NOT_FOUND');
    const papers = await this.source.searchAuthorPapers(expert.canonical_name, input.maxPapers ?? 10);
    const identity = identityConfidence(papers, expert.canonical_name);
    // Record the attempt on the identity so bounded batches move on instead of retrying the same unmatched names forever (§33, §51).
    this.db.prepare("UPDATE expert_identities SET provenance_json = json_set(provenance_json, '$.enrichment', json(?)), updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify({ attempted_at: new Date().toISOString(), source: this.sourceName, papers_found: papers.length, papers_matched: identity.matched.length }), expertId);
    const base = { expert_id: expertId, canonical_name: expert.canonical_name, papers_found: papers.length, papers_matched: identity.matched.length, ai_share: identity.ai_share, identity_confidence: identity.confidence };

    if (!identity.matched.length) {
      // I10: absence of arXiv evidence is not evidence of absence; the identity simply stays DISCOVERED.
      return { ...base, lifecycle_state: expert.lifecycle_state, evidence_added: 0, capabilities: [], capability_delta: [], reason: 'no_author_match' };
    }
    if (expert.lifecycle_state === 'DISCOVERED' || expert.lifecycle_state === 'AMBIGUOUS') {
      const resolved = this.registry.resolveIdentity(expertId, { confidence: identity.confidence, actor: input.actor, reason: `arxiv author match: ${identity.matched.length} paper(s), AI share ${identity.ai_share}` });
      if (resolved.lifecycle_state === 'AMBIGUOUS') {
        // I03: fail closed, attach nothing to a person we cannot pin down.
        return { ...base, lifecycle_state: 'AMBIGUOUS', evidence_added: 0, capabilities: [], capability_delta: [], reason: 'identity_below_threshold' };
      }
    } else if (expert.identity_confidence < IDENTITY_CONFIDENCE_THRESHOLD) {
      return { ...base, lifecycle_state: expert.lifecycle_state, evidence_added: 0, capabilities: [], capability_delta: [], reason: 'identity_below_threshold' };
    }

    const before = (this.db.prepare("SELECT COUNT(*) AS n FROM expert_evidence WHERE expert_id = ? AND kind = 'paper'").get(expertId) as { n: number }).n;
    const knownCapabilities = new Set((this.db.prepare('SELECT capability_id FROM expert_capabilities WHERE expert_id = ?').all(expertId) as Array<{ capability_id: string }>).map((row) => row.capability_id));
    const evidenceByCapability = new Map<string, Set<string>>();
    // Only AI-related papers become evidence; a medical or physics paper under the same name is far more likely a namesake than a second field.
    for (const paper of identity.matched.filter(isAiPaper)) {
      const arxivShaped = /^\d{4}\.\d{4,5}(v\d+)?$/.test(paper.arxiv_id);
      const evidenceId = this.registry.addEvidence(expertId, {
        kind: 'paper', title: paper.title, url: paper.url, sourceRef: arxivShaped ? `arxiv:${paper.arxiv_id}` : paper.arxiv_id,
        canonicalOrigin: arxivShaped ? `https://arxiv.org/abs/${paper.arxiv_id.replace(/v\d+$/, '')}` : paper.url, retrievedAt: new Date().toISOString(),
        metadata: { abstract: paper.summary.slice(0, 2_000), categories: paper.categories, primary_category: paper.primary_category, published: paper.published, authors: paper.authors, arxiv_id: paper.arxiv_id },
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
    return { ...base, lifecycle_state: this.registry.get(expertId)!.lifecycle_state, evidence_added: after - before, capabilities, capability_delta: capabilities.map((capability) => capability.id).filter((id) => !knownCapabilities.has(id)), reason: capabilities.length ? null : 'no_capability_derived' };
  }

  /** Enrich a bounded batch of DISCOVERED experts never attempted (or attempted before `retryBefore`), oldest first (§51: bounded, incremental). */
  async enrichBatch(input: { actor: string; limit?: number; maxPapers?: number; retryBefore?: string }): Promise<EnrichmentResult[]> {
    const rows = this.db.prepare(`SELECT id FROM expert_identities WHERE lifecycle_state = 'DISCOVERED'
      AND (json_extract(provenance_json, '$.enrichment.attempted_at') IS NULL OR json_extract(provenance_json, '$.enrichment.attempted_at') < ?)
      ORDER BY created_at ASC LIMIT ?`).all(input.retryBefore ?? '', Math.max(1, Math.min(50, input.limit ?? 10))) as Array<{ id: string }>;
    const results: EnrichmentResult[] = [];
    for (const row of rows) {
      try { results.push(await this.enrich(row.id, input)); } catch (error) { results.push({ expert_id: row.id, canonical_name: '', papers_found: 0, papers_matched: 0, ai_share: 0, identity_confidence: 0, lifecycle_state: 'DISCOVERED', evidence_added: 0, capabilities: [], capability_delta: [], reason: error instanceof Error ? error.message : 'ENRICH_FAILED' }); }
    }
    return results;
  }

  /**
   * Re-derive capabilities from stored paper evidence without network (§54: taxonomy or rule changes). Non-AI papers are
   * challenged (namesake suspects) so they stop qualifying; inferred capabilities no longer supported are revoked, while
   * checked/approved ones are only reported (governance decides). Returns what changed per expert.
   */
  recompute(expertId: string, input: { actor: string }): { revoked: string[]; added: string[]; challenged_evidence: number; kept_governed_unsupported: string[] } {
    const rows = this.db.prepare("SELECT id, title, metadata_json, lifecycle FROM expert_evidence WHERE expert_id = ? AND kind = 'paper'").all(expertId) as Array<{ id: string; title: string; metadata_json: string; lifecycle: string }>;
    const papers = rows.map((row) => { const metadata = JSON.parse(row.metadata_json || '{}') as { abstract?: string; categories?: string[]; primary_category?: string | null; published?: string | null; arxiv_id?: string }; return { row, paper: { arxiv_id: metadata.arxiv_id ?? row.id, url: '', title: row.title, summary: metadata.abstract ?? '', authors: [], categories: metadata.categories ?? [], primary_category: metadata.primary_category ?? null, published: metadata.published ?? null } as ArxivPaper }; });
    let challenged = 0;
    for (const { row, paper } of papers) {
      if (row.lifecycle === 'active' && !isAiPaper(paper)) { this.registry.markEvidence(row.id, 'challenged', input.actor); challenged += 1; row.lifecycle = 'challenged'; }
    }
    const supported = new Map<string, Set<string>>();
    for (const { row, paper } of papers) {
      if (row.lifecycle !== 'active') continue;
      for (const capability of this.capabilitiesFor(paper)) { const set = supported.get(capability) ?? new Set<string>(); set.add(row.id); supported.set(capability, set); }
    }
    const existing = this.db.prepare("SELECT capability_id, status FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'").all(expertId) as Array<{ capability_id: string; status: string }>;
    const revoked: string[] = []; const keptGoverned: string[] = []; const added: string[] = [];
    for (const capability of existing) {
      if (supported.has(capability.capability_id)) continue;
      if (capability.status === 'inferred') { this.db.prepare("UPDATE expert_capabilities SET status = 'revoked', updated_at = datetime('now') WHERE expert_id = ? AND capability_id = ?").run(expertId, capability.capability_id); revoked.push(capability.capability_id); }
      else keptGoverned.push(capability.capability_id);
    }
    for (const [capability, refs] of supported) {
      if (!existing.some((item) => item.capability_id === capability)) added.push(capability);
      this.registry.inferCapability(expertId, { capability, confidence: Math.min(0.95, 0.5 + 0.15 * (refs.size - 1)), evidenceRefs: [...refs], derivedBy: 'recompute' });
    }
    // An inferred-only expert whose capabilities all fell away is no longer CAPABILITY_INFERRED (§54, I02).
    const current = this.registry.get(expertId)!;
    if (supported.size && current.lifecycle_state === 'EVIDENCE_COLLECTED') this.registry.transition(expertId, 'CAPABILITY_INFERRED', { actor: input.actor, reason: 'recompute: capabilities recovered from stored evidence' });
    if (!supported.size && !keptGoverned.length && current.lifecycle_state === 'CAPABILITY_INFERRED') this.registry.transition(expertId, 'INSUFFICIENT_EVIDENCE', { actor: input.actor, reason: 'recompute: no capability supported by active AI evidence' });
    return { revoked, added, challenged_evidence: challenged, kept_governed_unsupported: keptGoverned };
  }

  /** How many DISCOVERED identities still await a first enrichment attempt. */
  pending(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM expert_identities WHERE lifecycle_state = 'DISCOVERED' AND json_extract(provenance_json, '$.enrichment.attempted_at') IS NULL").get() as { n: number }).n;
  }

  /** Capability ids a paper supports: direct category mappings plus taxonomy aliases found in title/abstract. */
  capabilitiesFor(paper: ArxivPaper): string[] {
    const found = new Set<string>();
    for (const category of paper.categories) { const mapped = CATEGORY_CAPABILITY[category]; if (mapped) found.add(mapped); }
    const title = paper.title.toLowerCase();
    const text = `${title} ${paper.summary}`.toLowerCase();
    for (const row of this.db.prepare('SELECT id, label, aliases_json FROM expert_capability_taxonomy').all() as Array<{ id: string; label: string; aliases_json: string }>) {
      const phrases = [row.label.toLowerCase(), row.id.replace(/_/g, ' '), ...(JSON.parse(row.aliases_json) as string[]).map((alias) => alias.toLowerCase())].filter((phrase) => phrase.length > 3);
      // A single generic word ("reasoning", "alignment") only counts in the title; multi-word phrases may match the abstract too.
      const matches = (phrase: string) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`).test(/\s/.test(phrase) ? text : title);
      if (phrases.some(matches)) found.add(row.id);
    }
    return [...found];
  }
}
