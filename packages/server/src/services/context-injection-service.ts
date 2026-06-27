import path from 'path';
import fs from 'fs';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

const QDRANT_URL = process.env.QDRANT_URL || 'http://192.168.1.28:6333';
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const QDRANT_COLLECTION = 'djimitflo_swarm';
const OKF_COLLECTION = 'djimit_okf';
const qdrantApiKey = process.env.QDRANT_API_KEY ?? '';
// Qdrant enforces auth (QDRANT__SERVICE__API_KEY). Without the key, both retrieval
// paths 401 and injectContext silently returns empty. Send the key when configured.
// Bounded fetch: never let a slow/unreachable RAG source (djimitkb-mcp/ollama/qdrant) hang the
// knowledge-injection path and deadlock the proof/bridge tests. Fail fast (<=5s) + skip.
const fetchWithTimeout = async (url: string, init: RequestInit = {}, ms = 5_000): Promise<Response> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
};

const qdrantHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(qdrantApiKey ? { 'api-key': qdrantApiKey } : {}),
  ...extra,
});
const MAX_CONTEXT_TOKENS = 1500;
const MIN_SCORE = 0.5;
const DJIMITKB_MCP_URL = process.env.DJIMITKB_MCP_URL || 'http://192.168.1.28:8008';

export interface ContextResult {
  source: 'qdrant_swarm' | 'okf_search' | 'okf_related' | 'djimitkb_search';
  concept_id?: string;
  title?: string;
  type?: string;
  score?: number;
  excerpt: string;
  trust_level?: string;
  // G2: provenance — the run + evidence that produced this memory (for trust-gated handoff).
  provenance_run?: string;
  evidence_refs?: string[];
}

export class ContextInjectionService {

  async injectContext(taskDescription: string, useSwarmContext: boolean = true): Promise<string> {
    if (!useSwarmContext) return '';

    const results: ContextResult[] = [];

    await Promise.allSettled([
      this.searchQdrantSwarm(taskDescription).then((r) => results.push(...r)),
      this.searchOkfMcp(taskDescription).then((r) => results.push(...r)),
      this.searchDjimitKB(taskDescription).then((r) => results.push(...r)),
    ]);

    const ranked = this.rankByTrust(results);
    const truncated = this.truncateToTokenBudget(ranked, MAX_CONTEXT_TOKENS);

    if (truncated.length === 0) return '';

    const lines = ['## Context (Swarm + Knowledge)', ''];
    for (const r of truncated) {
      const src = r.source === 'qdrant_swarm' ? 'memory' : r.source === 'okf_search' ? 'knowledge' : r.source === 'djimitkb_search' ? 'djimitkb' : 'related';
      const trust = r.trust_level ? ` [${r.trust_level}]` : '';
      lines.push(`### ${r.title || r.concept_id || src}${trust}`);
      lines.push(r.excerpt.slice(0, 300));
      // G2: provenance line — the receiver sees which run + evidence produced this memory
      // (enables trust-gated handoff; a checker can reject low-trust/unprovenanced memory).
      if (r.provenance_run || (r.evidence_refs && r.evidence_refs.length > 0)) {
        lines.push(`_provenance: run=${r.provenance_run || '?'} · evidence=${(r.evidence_refs || []).length}ref(s)_`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private async searchQdrantSwarm(query: string): Promise<ContextResult[]> {
    try {
      const embedRes = await fetchWithTimeout(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: query }),
      });
      if (!embedRes.ok) return [];
      const embedJson = (await embedRes.json()) as { embedding: number[] };
      const vector = embedJson.embedding;

      const searchRes = await fetchWithTimeout(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders(),
        body: JSON.stringify({ vector, limit: 3, with_payload: true, score_threshold: MIN_SCORE }),
      });
      if (!searchRes.ok) return [];
      const searchJson = (await searchRes.json()) as { result: any[] };
      const hits = searchJson.result || [];

      return hits.map((h: any) => ({
        source: 'qdrant_swarm' as const,
        concept_id: h.payload?.task_id,
        title: h.payload?.content_excerpt?.slice(0, 80) || 'Task memory',
        type: h.payload?.agent_type,
        score: h.score,
        excerpt: h.payload?.content_excerpt || '',
        trust_level: h.payload?.trust_level,
        provenance_run: h.payload?.provenance_run,
        evidence_refs: Array.isArray(h.payload?.evidence_refs) ? h.payload.evidence_refs : [],
      }));
    } catch {
      return [];
    }
  }

  private async searchOkfMcp(query: string): Promise<ContextResult[]> {
    const results: ContextResult[] = [];

    try {
      const embedRes = await fetchWithTimeout(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: query }),
      });
      if (!embedRes.ok) return [];
      const embedJson = (await embedRes.json()) as { embedding: number[] };
      const vector = embedJson.embedding;

      const searchRes = await fetchWithTimeout(`${QDRANT_URL}/collections/${OKF_COLLECTION}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders(),
        body: JSON.stringify({ vector, limit: 3, with_payload: true, score_threshold: MIN_SCORE }),
      });
      if (!searchRes.ok) return [];
      const searchJson = (await searchRes.json()) as { result: any[] };
      const hits = searchJson.result || [];

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
    try {
      const res = await fetchWithTimeout(`${DJIMITKB_MCP_URL}/search?q=${encodeURIComponent(query)}&limit=3`);
      if (!res.ok) return [];

      const json = (await res.json()) as { results: Array<{
        title: string; path: string; type: string; score: number;
        tags: string[]; date: string; excerpt: string; chunk_index: number;
      }> };

      return (json.results || []).map((r: any) => ({
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
    const trustOrder: Record<string, number> = { approved: 0, validated: 1, agent_generated: 2 };
    return results.sort((a, b) => {
      const aTrust = trustOrder[a.trust_level || 'agent_generated'] ?? 3;
      const bTrust = trustOrder[b.trust_level || 'agent_generated'] ?? 3;
      if (aTrust !== bTrust) return aTrust - bTrust;
      return (b.score || 0) - (a.score || 0);
    });
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
