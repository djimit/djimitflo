import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';
import type { Database } from 'better-sqlite3';
import type { MemoryStore } from './memory-candidate-service';
import { ContextSanitizer } from './context-sanitizer';
import { ExperienceRetrievalService } from './experience-retrieval-service';
import { checkCollection, memoryEmbedModel, SWARM_MEMORY_COLLECTION } from './memory-embedding-contract';

// Resolved per call; unset = that context source is off (M2d: never a workstation default).
const qdrantUrl = (): string => process.env.QDRANT_URL || '';
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const OKF_COLLECTION = 'djimit_okf';
const qdrantApiKey = process.env.QDRANT_API_KEY ?? '';
// Qdrant enforces auth (QDRANT__SERVICE__API_KEY). Without the key, both retrieval
// paths 401 and injectContext silently returns empty. Send the key when configured.
// Bounded fetch: never let a slow/unreachable RAG source (djimitkb-mcp/ollama/qdrant) hang the
// knowledge-injection path and deadlock the proof/bridge tests. Fail fast (<=5s) + skip.
// STATE-03: the deadline covers the body, not just the headers — a source that flushes headers and
// then stalls the body is aborted too. The abort in `finally` cancels any unread body on every path.
// Timeout / malformed JSON throw; every caller catches and skips that source.
const fetchJsonWithTimeout = async <T>(url: string, init: RequestInit, ms: number): Promise<{ ok: boolean; status: number; json?: T }> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, json: (await res.json()) as T };
  } finally {
    clearTimeout(t);
    ctrl.abort();
  }
};

const qdrantHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(qdrantApiKey ? { 'api-key': qdrantApiKey } : {}),
  ...extra,
});
const MAX_CONTEXT_TOKENS = 1500;
const MIN_SCORE = 0.5;
const djimitkbMcpUrl = (): string => process.env.DJIMITKB_MCP_URL || '';

export interface ContextResult {
  source: 'qdrant_swarm' | 'okf_search' | 'okf_related' | 'djimitkb_search' | 'experience_retrieval';
  concept_id?: string;
  title?: string;
  type?: string;
  score?: number;
  excerpt: string;
  trust_level?: string;
  // G2: provenance — the run + evidence that produced this memory (for trust-gated handoff).
  provenance_run?: string;
  evidence_refs?: string[];
  trust_score?: number;
  // G8: cognitive store — enables typed retrieval filtering.
  store?: MemoryStore;
}

/**
 * Ranking used for injected context: trust tier first, then score. UX-24 finding: the score is compared raw across sources
 * (Qdrant cosine, OKF/KB search scores, experience retrieval), whose scales differ, and the trust tier outranks relevance
 * entirely. RETRIEVAL_NORMALISE_SCORES=true (default off) min-max normalises the score within each source before the
 * within-tier comparison; off keeps today's order exactly. The tier-first rule is unchanged either way.
 */
export function rankContextResults(results: ContextResult[], env: NodeJS.ProcessEnv = process.env): ContextResult[] {
  const trustOrder: Record<string, number> = { approved: 0, validated: 1, agent_generated: 2 };
  const tier = (r: ContextResult) => trustOrder[r.trust_level || 'agent_generated'] ?? 3;
  let score = (r: ContextResult) => r.score || 0;
  if (env.RETRIEVAL_NORMALISE_SCORES === 'true') {
    const range = new Map<string, [number, number]>();
    for (const r of results) { const [lo, hi] = range.get(r.source) ?? [Infinity, -Infinity]; range.set(r.source, [Math.min(lo, r.score || 0), Math.max(hi, r.score || 0)]); }
    score = (r) => { const [lo, hi] = range.get(r.source)!; return hi > lo ? ((r.score || 0) - lo) / (hi - lo) : 1; };
  }
  return results.sort((a, b) => (tier(a) !== tier(b) ? tier(a) - tier(b) : score(b) - score(a)));
}

export interface ContextSnapshot {
  text: string;
  sha256: string;
  sources: string[];
  advisory: true;
  independently_reviewed: false;
  /** Sources skipped because they are incompatible/unreachable — distinct from "no matching memory" (CODE-002). */
  unavailable?: Array<{ source: ContextResult['source']; reason: string }>;
}

export class ContextInjectionService {
  private sanitizer = new ContextSanitizer();
  private experienceRetrieval: ExperienceRetrievalService | null = null;
  constructor(private db?: Database, private fetchTimeoutMs = 5_000) {
    if (db) this.experienceRetrieval = new ExperienceRetrievalService(db);
  }

  async injectContext(taskDescription: string, useSwarmContext: boolean = true, storeFilter?: MemoryStore): Promise<string> {
    return (await this.injectContextSnapshot(taskDescription, useSwarmContext, storeFilter)).text;
  }

  /**
   * Produce the exact context that will be persisted into executor input.
   * The hash is server-owned provenance; retrieved episodes remain advisory and
   * must not be presented as independently reviewed or causal evidence.
   */
  async injectContextSnapshot(taskDescription: string, useSwarmContext: boolean = true, storeFilter?: MemoryStore): Promise<ContextSnapshot> {
    if (!useSwarmContext) return { text: '', sha256: createHash('sha256').update('').digest('hex'), sources: [], advisory: true, independently_reviewed: false };

    const { results, unavailable } = await this.collect(taskDescription, storeFilter);
    const ranked = this.rankByTrust(results);
    const truncated = this.truncateToTokenBudget(ranked, MAX_CONTEXT_TOKENS);

    const unavailableField = unavailable.length > 0 ? { unavailable } : {};
    if (truncated.length === 0) return { text: '', sha256: createHash('sha256').update('').digest('hex'), sources: [], advisory: true, independently_reviewed: false, ...unavailableField };

    const lines = ['## Context (Swarm + Knowledge)', ''];
    for (const r of truncated) {
      const src = r.source === 'qdrant_swarm' ? 'memory' : r.source === 'okf_search' ? 'knowledge' : r.source === 'djimitkb_search' ? 'djimitkb' : 'related';
      const trust = r.trust_score !== undefined
        ? ` [trust:${r.trust_score.toFixed(2)}]`
        : (r.trust_level ? ` [${r.trust_level}]` : '');
      lines.push(`### ${r.title || r.concept_id || src}${trust}`);
      lines.push(r.excerpt.slice(0, 300));
      // G2: provenance line — the receiver sees which run + evidence produced this memory
      // (enables trust-gated handoff; a checker can reject low-trust/unprovenanced memory).
      if (r.provenance_run || (r.evidence_refs && r.evidence_refs.length > 0)) {
        lines.push(`_provenance: run=${r.provenance_run || '?'} · evidence=${(r.evidence_refs || []).length}ref(s)_`);
      }
      lines.push('');
    }

    const result = lines.join('\n');
    // G25: sanitize retrieved context before injection (prompt injection defense).
    const sanitized = this.sanitizer.sanitize(result);
    const text = sanitized.sanitized;
    return {
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
      sources: [...new Set(truncated.map((result) => result.source))],
      advisory: true,
      independently_reviewed: false,
      ...unavailableField,
    };
  }

  /**
   * The merged, unranked candidate list from every source (raw scores, trust tiers), exactly what injectContextSnapshot ranks.
   * E1 (docs/research/eco/E1-RRF_PROTOCOL.md) snapshots it for blind query-level labelling; no ranking or prod read changes.
   */
  async collectCandidates(taskDescription: string, storeFilter?: MemoryStore): Promise<ContextResult[]> {
    return (await this.collect(taskDescription, storeFilter)).results;
  }

  private async collect(taskDescription: string, storeFilter?: MemoryStore): Promise<{ results: ContextResult[]; unavailable: NonNullable<ContextSnapshot['unavailable']> }> {
    const results: ContextResult[] = [];
    const unavailable: NonNullable<ContextSnapshot['unavailable']> = [];

    const searches: Promise<unknown>[] = [
      this.searchQdrantSwarm(taskDescription, storeFilter).then((r) => {
        results.push(...r.results);
        if (r.unavailable) unavailable.push({ source: 'qdrant_swarm', reason: r.unavailable });
      }),
      this.searchOkfMcp(taskDescription).then((r) => results.push(...r)),
      this.searchDjimitKB(taskDescription).then((r) => results.push(...r)),
    ];
    if (this.experienceRetrieval) {
      searches.push(this.experienceRetrieval.retrieveRelevantRuns(taskDescription, 5).then((expResults) => {
        if (expResults.length > 0) {
          results.push({
            source: 'experience_retrieval',
            excerpt: this.experienceRetrieval!.formatExperienceContext(expResults),
            score: expResults[0].similarity,
            store: 'episodic',
          });
        }
      }));
    }

    await Promise.allSettled(searches);
    return { results, unavailable };
  }

  /**
   * CODE-002: query with the same embedding contract the swarm-memory writers use, verify the
   * collection's dimension first, and only match points written with that model. An incompatible
   * collection is reported as unavailable, never queried with a foreign vector space.
   */
  private async searchQdrantSwarm(query: string, storeFilter?: MemoryStore): Promise<{ results: ContextResult[]; unavailable?: string }> {
    if (!qdrantUrl()) return { results: [], unavailable: 'QDRANT_URL unset' };
    try {
      const model = memoryEmbedModel();
      const embedRes = await fetchJsonWithTimeout<{ embedding?: number[] }>(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: query }),
      }, this.fetchTimeoutMs);
      if (!embedRes.ok) return { results: [], unavailable: `embedding ${model} failed: ${embedRes.status}` };
      const vector = embedRes.json?.embedding;
      if (!vector?.length) return { results: [], unavailable: `embedding ${model} returned no vector` };

      const state = await checkCollection(qdrantUrl(), SWARM_MEMORY_COLLECTION, qdrantHeaders(), vector.length, model);
      if (state.status === 'missing') return { results: [], unavailable: `${SWARM_MEMORY_COLLECTION} collection missing` };
      if (state.status === 'unavailable') return { results: [], unavailable: state.reason };

      const must: unknown[] = [{ key: 'embedding_model', match: { value: model } }];
      if (storeFilter) must.push({ key: 'store', match: { value: storeFilter } });
      const searchRes = await fetchJsonWithTimeout<{ result: any[] }>(`${qdrantUrl()}/collections/${SWARM_MEMORY_COLLECTION}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders(),
        body: JSON.stringify({ vector, limit: 3, with_payload: true, score_threshold: MIN_SCORE, filter: { must } }),
      }, this.fetchTimeoutMs);
      if (!searchRes.ok) return { results: [], unavailable: `search ${searchRes.status}` };
      const hits = searchRes.json?.result || [];

      return { results: hits.map((h: any) => {
        // G2.3: trust decay — unvalidated/old memory loses trust on a 30-day half-life.
        const baseTrust = h.payload?.trust_level === 'validated' ? 1.0 : 0.5;
        const ts = h.payload?.timestamp ? new Date(h.payload.timestamp).getTime() : Date.now();
        const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
        let trust_score = baseTrust * Math.pow(0.5, ageDays / 30);
        // G2.4: contradiction — if the claim ledger has a contradicts_ref for this memory,
        // demote trust (the memory is contradicted by a later claim with evidence).
        if (this.db && h.payload?.task_id) {
          const contradicted = this.db.prepare('SELECT 1 FROM swarm_claims WHERE contradicts_ref = ? LIMIT 1').get(h.payload.task_id);
          if (contradicted) trust_score *= 0.3;
        }
        return {
          source: 'qdrant_swarm' as const,
          concept_id: h.payload?.task_id,
          title: h.payload?.content_excerpt?.slice(0, 80) || 'Task memory',
          type: h.payload?.agent_type,
          score: h.score,
          excerpt: h.payload?.content_excerpt || '',
          trust_level: h.payload?.trust_level,
          provenance_run: h.payload?.provenance_run,
          evidence_refs: Array.isArray(h.payload?.evidence_refs) ? h.payload.evidence_refs : [],
          trust_score,
          store: h.payload?.store as MemoryStore | undefined,
        };
      }) };
    } catch (e) {
      return { results: [], unavailable: e instanceof Error ? e.message : String(e) };
    }
  }

  private async searchOkfMcp(query: string): Promise<ContextResult[]> {
    const results: ContextResult[] = [];
    if (!qdrantUrl()) return results;

    try {
      const embedRes = await fetchJsonWithTimeout<{ embedding: number[] }>(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: query }),
      }, this.fetchTimeoutMs);
      if (!embedRes.ok) return [];
      const vector = embedRes.json?.embedding;

      const searchRes = await fetchJsonWithTimeout<{ result: any[] }>(`${qdrantUrl()}/collections/${OKF_COLLECTION}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders(),
        body: JSON.stringify({ vector, limit: 3, with_payload: true, score_threshold: MIN_SCORE }),
      }, this.fetchTimeoutMs);
      if (!searchRes.ok) return [];
      const hits = searchRes.json?.result || [];

      for (const h of hits) {
        results.push({
          source: 'okf_search',
          concept_id: h.payload?.concept_id,
          title: h.payload?.title,
          type: h.payload?.type,
          score: h.score,
          excerpt: h.payload?.content_excerpt || '',
          trust_level: h.payload?.trust_level,
        });

        if (h.payload?.concept_id) {
          const related = this.readOkfConcept(h.payload.concept_id);
          if (related) {
            results.push({
              source: 'okf_related',
              concept_id: h.payload.concept_id,
              title: h.payload.title + ' (related)',
              type: h.payload.type,
              score: (h.score || 0) - 0.05,
              excerpt: related.slice(0, 300),
              trust_level: h.payload?.trust_level,
            });
          }
        }
      }
    } catch {
      // OKF search failed, return empty
    }

    return results;
  }

  private readOkfConcept(conceptId: string): string | null {
    const mdPath = path.join(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), `${conceptId}.md`);
    if (!fs.existsSync(mdPath)) return null;
    const content = fs.readFileSync(mdPath, 'utf-8');
    const bodyStart = content.indexOf('---', 3);
    if (bodyStart < 0) return content.slice(0, 300);
    const body = content.slice(bodyStart + 3).trim();
    return body.slice(0, 300);
  }



  private async searchDjimitKB(query: string): Promise<ContextResult[]> {
    if (!djimitkbMcpUrl()) return [];
    try {
      const res = await fetchJsonWithTimeout<{ results: Array<{
        title: string; path: string; type: string; score: number;
        tags: string[]; date: string; excerpt: string; chunk_index: number;
      }> }>(`${djimitkbMcpUrl()}/search?q=${encodeURIComponent(query)}&limit=3`, {}, this.fetchTimeoutMs);
      if (!res.ok) return [];

      return (res.json?.results || []).map((r: any) => ({
        source: 'djimitkb_search' as const,
        title: r.title,
        type: r.type,
        score: r.score,
        excerpt: r.excerpt || '',
        trust_level: r.type === 'entity' ? 'approved' : r.type === 'report' ? 'validated' : 'agent_generated',
      }));
    } catch {
      return [];
    }
  }

  private rankByTrust(results: ContextResult[]): ContextResult[] {
    return rankContextResults(results);
  }

  private truncateToTokenBudget(results: ContextResult[], maxTokens: number): ContextResult[] {
    const kept: ContextResult[] = [];
    let usedTokens = 0;
    for (const r of results) {
      const tokens = Math.ceil(r.excerpt.length / 4);
      if (usedTokens + tokens > maxTokens) break;
      kept.push(r);
      usedTokens += tokens;
    }
    return kept;
  }
}
