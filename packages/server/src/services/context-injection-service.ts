import path from 'path';
import fs from 'fs';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

const QDRANT_URL = process.env.QDRANT_URL || 'http://192.168.1.28:6333';
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const QDRANT_COLLECTION = 'djimitflo_swarm';
const OKF_COLLECTION = 'djimit_okf';
const MAX_CONTEXT_TOKENS = 1500;
const MIN_SCORE = 0.5;

export interface ContextResult {
  source: 'qdrant_swarm' | 'okf_search' | 'okf_related';
  concept_id?: string;
  title?: string;
  type?: string;
  score?: number;
  excerpt: string;
  trust_level?: string;
}

export class ContextInjectionService {

  async injectContext(taskDescription: string, useSwarmContext: boolean = true): Promise<string> {
    if (!useSwarmContext) return '';

    const results: ContextResult[] = [];

    await Promise.allSettled([
      this.searchQdrantSwarm(taskDescription).then((r) => results.push(...r)),
      this.searchOkfMcp(taskDescription).then((r) => results.push(...r)),
    ]);

    const ranked = this.rankByTrust(results);
    const truncated = this.truncateToTokenBudget(ranked, MAX_CONTEXT_TOKENS);

    if (truncated.length === 0) return '';

    const lines = ['## Swarm Context', ''];
    for (const r of truncated) {
      const src = r.source === 'qdrant_swarm' ? 'memory' : r.source === 'okf_search' ? 'knowledge' : 'related';
      const trust = r.trust_level ? ` [${r.trust_level}]` : '';
      lines.push(`### ${r.title || r.concept_id || src}${trust}`);
      lines.push(r.excerpt.slice(0, 300));
      lines.push('');
    }

    return lines.join('\n');
  }

  private async searchQdrantSwarm(query: string): Promise<ContextResult[]> {
    try {
      const embedRes = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: query }),
      });
      if (!embedRes.ok) return [];
      const embedJson = (await embedRes.json()) as { embedding: number[] };
      const vector = embedJson.embedding;

      const searchRes = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        trust_level: undefined,
      }));
    } catch {
      return [];
    }
  }

  private async searchOkfMcp(query: string): Promise<ContextResult[]> {
    const results: ContextResult[] = [];

    try {
      const embedRes = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: query }),
      });
      if (!embedRes.ok) return [];
      const embedJson = (await embedRes.json()) as { embedding: number[] };
      const vector = embedJson.embedding;

      const searchRes = await fetch(`${QDRANT_URL}/collections/${OKF_COLLECTION}/points/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
