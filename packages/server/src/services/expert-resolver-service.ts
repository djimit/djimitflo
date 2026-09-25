/**
 * ExpertResolverService — query-dependent, evidence-weighted expert selection (§12, §13, §14, §53).
 *
 * QUESTION → capability top-K (taxonomy ids, labels, aliases) → expert top-K (ACTIVE experts holding those
 * capabilities) → scored with visible, configurable weights → greedy diversity selection → WHY_SELECTED per expert.
 * No fame features exist in the model: no follower counts, no prestige, no seed-list ordering (I13).
 * The resolver abstains when no capability or no expert clears the floor instead of forcing a pick.
 */

import type { Database } from 'better-sqlite3';

export interface ResolverWeights {
  semantic_match: number;
  capability_match: number;
  evidence_quality: number;
  primary_evidence_strength: number;
  demonstrated_contribution: number;
  temporal_relevance: number;
  diversity_contribution: number;
  identity_uncertainty: number;
  evidence_conflict: number;
}
export const DEFAULT_RESOLVER_WEIGHTS: ResolverWeights = {
  semantic_match: 1.0, capability_match: 1.5, evidence_quality: 1.0, primary_evidence_strength: 0.8, demonstrated_contribution: 0.5,
  temporal_relevance: 0.4, diversity_contribution: 0.7, identity_uncertainty: 1.0, evidence_conflict: 1.0,
};

export interface ResolvedExpert {
  expert_id: string;
  canonical_name: string;
  lifecycle_state: string;
  score: number;
  components: Record<keyof ResolverWeights, number>;
  capabilities: Array<{ id: string; confidence: number }>;
  evidence: Array<{ id: string; kind: string; tier: number; title: string; url: string | null; source_family: string }>;
  why_selected: string;
}
export interface ResolveOptions {
  maxExperts?: number;
  /** Lifecycle states eligible for analysis; defaults to ACTIVE only. */
  states?: string[];
  /** Restrict to these capability ids (skips text matching). */
  capabilities?: string[];
  /** Only experts in this list are considered. */
  expertIds?: string[];
  /** Minimum evidence quality (0..1) an expert must reach. */
  minEvidenceQuality?: number;
  /** Ignore evidence retrieved after this instant (reproducible AS OF). */
  asOf?: string;
  /** Minimum total score to be selected; below it the resolver abstains. */
  minScore?: number;
}
export interface ResolveResult {
  question: string;
  capabilities: Array<{ id: string; score: number; matched: string[] }>;
  experts: ResolvedExpert[];
  weights: ResolverWeights;
  abstained: boolean;
  reason: string | null;
  considered: number;
}

const TIER_WEIGHT: Record<number, number> = { 1: 1, 2: 0.6, 3: 0.3, 4: 0 };
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'how', 'what', 'does', 'are', 'can', 'our', 'its', 'their', 'about', 'which', 'when', 'will', 'would', 'should', 'could', 'have', 'has', 'not', 'but', 'als', 'van', 'het', 'een', 'voor', 'met', 'dat', 'die', 'wat', 'hoe']);

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, ' ').split(/[\s-]+/).map((token) => token.replace(/_/g, ' ').trim()).filter((token) => token.length > 2 && !STOP.has(token));
}

export class ExpertResolverService {
  readonly weights: ResolverWeights;

  constructor(private readonly db: Database, weights: Partial<ResolverWeights> = {}) {
    this.weights = { ...DEFAULT_RESOLVER_WEIGHTS, ...weights };
  }

  /** Capability top-K from the taxonomy: id, label and alias tokens against the question. */
  matchCapabilities(question: string, limit = 5): Array<{ id: string; score: number; matched: string[] }> {
    const tokens = new Set(tokenize(question));
    const rows = this.db.prepare('SELECT id, label, aliases_json, parent_id FROM expert_capability_taxonomy').all() as Array<{ id: string; label: string; aliases_json: string; parent_id: string | null }>;
    const scored = rows.map((row) => {
      const phrases = [row.id.replace(/_/g, ' '), row.label, ...(JSON.parse(row.aliases_json) as string[])].map((phrase) => phrase.toLowerCase());
      const matched = new Set<string>();
      let score = 0;
      for (const phrase of phrases) {
        const normalizedQuestion = ` ${[...tokens].join(' ')} `;
        if (normalizedQuestion.includes(` ${phrase} `) || question.toLowerCase().includes(phrase)) { score += 1; matched.add(phrase); continue; }
        const parts = tokenize(phrase);
        const hits = parts.filter((part) => tokens.has(part));
        if (parts.length && hits.length === parts.length) { score += 0.8; hits.forEach((hit) => matched.add(hit)); }
        else if (hits.length) { score += (0.3 * hits.length) / parts.length; hits.forEach((hit) => matched.add(hit)); }
      }
      return { id: row.id, score, matched: [...matched] };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const max = top[0]?.score || 1;
    return top.map((item) => ({ ...item, score: Number((item.score / max).toFixed(3)) }));
  }

  resolve(question: string, options: ResolveOptions = {}): ResolveResult {
    const maxExperts = Math.max(1, Math.min(7, options.maxExperts ?? 5));
    const states = options.states?.length ? options.states : ['ACTIVE'];
    const capabilities = options.capabilities?.length
      ? options.capabilities.map((id) => ({ id, score: 1, matched: ['requested'] }))
      : this.matchCapabilities(question);
    if (!capabilities.length) return { question, capabilities: [], experts: [], weights: this.weights, abstained: true, reason: 'no_capability_match', considered: 0 };
    const capabilityScore = new Map(capabilities.map((item) => [item.id, item.score]));
    const questionTokens = new Set(tokenize(question));
    const asOf = options.asOf ?? new Date(Date.now() + 60_000).toISOString();

    const candidates = (this.db.prepare(`
      SELECT DISTINCT e.id, e.canonical_name, e.lifecycle_state, e.identity_confidence FROM expert_identities e
      JOIN expert_capabilities c ON c.expert_id = e.id AND c.status != 'revoked' AND NOT (e.lifecycle_state IN ('ACTIVE', 'APPROVED') AND c.status = 'inferred')
      WHERE e.lifecycle_state IN (SELECT value FROM json_each(?)) AND c.capability_id IN (SELECT value FROM json_each(?))
      ${options.expertIds?.length ? 'AND e.id IN (SELECT value FROM json_each(?))' : ''}
    `).all(JSON.stringify(states), JSON.stringify([...capabilityScore.keys()]), ...(options.expertIds?.length ? [JSON.stringify(options.expertIds)] : [])) as Array<{ id: string; canonical_name: string; lifecycle_state: string; identity_confidence: number }>);

    // An expert without qualifying evidence as of the query instant is not an expert for this query (I02, I10).
    const scored = candidates.map((candidate) => this.scoreExpert(candidate, capabilityScore, questionTokens, asOf))
      .filter((item) => item.evidence.length > 0 && item.components.evidence_quality >= (options.minEvidenceQuality ?? 0));
    const selected: ResolvedExpert[] = [];
    const remaining = [...scored];
    const floor = options.minScore ?? 0.5;
    while (selected.length < maxExperts && remaining.length) {
      // Diversity: penalise capability overlap with what is already selected, then take the best.
      for (const item of remaining) {
        const covered = new Set(selected.flatMap((chosen) => chosen.capabilities.map((capability) => capability.id)));
        const overlap = item.capabilities.filter((capability) => covered.has(capability.id)).length;
        item.components.diversity_contribution = item.capabilities.length ? 1 - overlap / item.capabilities.length : 0;
        item.score = this.total(item.components);
      }
      remaining.sort((a, b) => b.score - a.score);
      const best = remaining.shift()!;
      if (best.score < floor) break;
      best.why_selected = this.explain(best, capabilities);
      selected.push(best);
    }
    return {
      question, capabilities, experts: selected, weights: this.weights,
      abstained: selected.length === 0, reason: selected.length ? null : candidates.length ? 'no_expert_above_floor' : 'no_expert_for_capabilities',
      considered: candidates.length,
    };
  }

  private scoreExpert(candidate: { id: string; canonical_name: string; lifecycle_state: string; identity_confidence: number }, capabilityScore: Map<string, number>, questionTokens: Set<string>, asOf: string): ResolvedExpert {
    // §54: on a governed (APPROVED/ACTIVE) expert only checked/approved capabilities are recommended; a delta inferred after activation waits for review.
    const governed = candidate.lifecycle_state === 'ACTIVE' || candidate.lifecycle_state === 'APPROVED';
    const capabilities = (this.db.prepare(`SELECT capability_id AS id, confidence, evidence_refs_json FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked' ${governed ? "AND status != 'inferred'" : ''}`).all(candidate.id) as Array<{ id: string; confidence: number; evidence_refs_json: string }>);
    const evidence = (this.db.prepare("SELECT id, kind, tier, title, url, source_family, retrieved_at FROM expert_evidence WHERE expert_id = ? AND lifecycle = 'active' AND retrieved_at <= ? AND kind NOT IN ('signature', 'secondary', 'other')").all(candidate.id, asOf) as Array<{ id: string; kind: string; tier: number; title: string; url: string | null; source_family: string; retrieved_at: string }>);
    const taxonomy = new Map((this.db.prepare('SELECT id, label, aliases_json FROM expert_capability_taxonomy').all() as Array<{ id: string; label: string; aliases_json: string }>).map((row) => [row.id, `${row.label} ${(JSON.parse(row.aliases_json) as string[]).join(' ')}`]));

    const capabilityMatch = capabilities.reduce((sum, capability) => sum + (capabilityScore.get(capability.id) ?? 0) * capability.confidence, 0) / Math.max(1, capabilityScore.size);
    const semanticTokens = tokenize([...capabilities.map((capability) => taxonomy.get(capability.id) ?? ''), ...evidence.map((item) => item.title)].join(' '));
    const semanticMatch = questionTokens.size ? semanticTokens.filter((token) => questionTokens.has(token)).length / questionTokens.size : 0;
    const quality = evidence.length ? evidence.reduce((sum, item) => sum + (TIER_WEIGHT[item.tier] ?? 0), 0) / evidence.length : 0;
    const primary = evidence.filter((item) => item.tier === 1).length;
    const families = new Set(evidence.map((item) => item.source_family)).size; // duplicates of one origin never add up (I11)
    const newest = evidence.map((item) => Date.parse(item.retrieved_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const ageYears = newest ? Math.max(0, (Date.parse(asOf) - newest) / (365 * 24 * 3600_000)) : 10;
    const conflicts = (this.db.prepare(`SELECT COUNT(*) AS n FROM expert_claim_relations r JOIN expert_claims a ON a.id = r.from_claim_id JOIN expert_claims b ON b.id = r.to_claim_id
      WHERE r.relation = 'CONTRADICTS' AND r.resolved_at IS NULL AND (a.expert_id = ? OR b.expert_id = ?)`).get(candidate.id, candidate.id) as { n: number }).n;

    const components: ResolvedExpert['components'] = {
      semantic_match: Number(Math.min(1, semanticMatch).toFixed(3)),
      capability_match: Number(Math.min(1, capabilityMatch).toFixed(3)),
      evidence_quality: Number(quality.toFixed(3)),
      primary_evidence_strength: Number(Math.min(1, Math.log1p(primary) / Math.log1p(5)).toFixed(3)),
      demonstrated_contribution: Number(Math.min(1, Math.log1p(families) / Math.log1p(5)).toFixed(3)),
      temporal_relevance: Number(Math.max(0, 1 - ageYears / 5).toFixed(3)),
      diversity_contribution: 1,
      identity_uncertainty: Number((1 - candidate.identity_confidence).toFixed(3)),
      evidence_conflict: Number(Math.min(1, conflicts / 3).toFixed(3)),
    };
    return {
      expert_id: candidate.id, canonical_name: candidate.canonical_name, lifecycle_state: candidate.lifecycle_state,
      score: this.total(components), components,
      capabilities: capabilities.map((capability) => ({ id: capability.id, confidence: capability.confidence })),
      evidence: evidence.sort((a, b) => a.tier - b.tier).slice(0, 5).map(({ retrieved_at: _r, ...rest }) => rest),
      why_selected: '',
    };
  }

  private total(components: ResolvedExpert['components']): number {
    const w = this.weights;
    const value = components.semantic_match * w.semantic_match + components.capability_match * w.capability_match + components.evidence_quality * w.evidence_quality
      + components.primary_evidence_strength * w.primary_evidence_strength + components.demonstrated_contribution * w.demonstrated_contribution
      + components.temporal_relevance * w.temporal_relevance + components.diversity_contribution * w.diversity_contribution
      - components.identity_uncertainty * w.identity_uncertainty - components.evidence_conflict * w.evidence_conflict;
    return Number(value.toFixed(3));
  }

  private explain(expert: ResolvedExpert, capabilities: Array<{ id: string; score: number }>): string {
    const matched = expert.capabilities.filter((capability) => capabilities.some((item) => item.id === capability.id)).map((capability) => capability.id);
    const primary = expert.evidence.filter((item) => item.tier === 1).length;
    return `capabilities ${matched.join(', ') || 'none'} match the question (capability_match ${expert.components.capability_match}); ${primary} primary-source item(s) among ${expert.evidence.length} evidence items (evidence_quality ${expert.components.evidence_quality}); identity confidence ${(1 - expert.components.identity_uncertainty).toFixed(2)}; ${expert.components.evidence_conflict > 0 ? 'has unresolved contradictions; ' : ''}diversity ${expert.components.diversity_contribution}.`;
  }
}
