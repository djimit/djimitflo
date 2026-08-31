/**
 * ExplainerKnowledgeService — FR-021/FR-022/FR-023:
 * chunks published explainer bundles into atomic facts, section summaries,
 * symbols, health findings, and AGENTS.md snippets, embeds them into Qdrant
 * with metadata (repo, section, file path, line range, symbol, bundle
 * version, valid_until) and exposes search with graceful degradation to
 * file-bundle keyword search when Qdrant is unavailable (EC-006).
 */

import type { Database } from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const QDRANT_URL = process.env.QDRANT_URL || "http://192.168.1.28:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || process.env.OPENCODE_QDRANT_API_KEY || process.env.QDRANT_API_KEY_ENV || "";
const COLLECTION = process.env.DJIMITFLO_EXPLAINER_COLLECTION || "djimitflo_explainers";
const VECTOR_SIZE = Number(process.env.DJIMITFLO_EXPLAINER_VECTOR_SIZE) || 384;
const OLLAMA_EMBED_URL = process.env.DJIMITFLO_EMBED_URL || process.env.OLLAMA_CLOUD_URL || "http://100.77.58.72:11434";
const OLLAMA_EMBED_MODEL = process.env.DJIMITFLO_EMBED_MODEL || "snowflake-arctic-embed:s";

function qdrantHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
  return headers;
}
const CHUNK_MAX_CHARS = 900;

export interface ExplainerChunk {
  id: string;
  repo_full_name: string;
  chunk_type: 'fact' | 'section' | 'symbol' | 'health_finding' | 'agents_md';
  section: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  symbol: string | null;
  text: string;
  citation: string | null;
  bundle_version: string;
  valid_until: string | null;
}

export interface SearchResult {
  chunk: ExplainerChunk;
  score: number;
  source: 'qdrant' | 'file_bundle';
}

export class ExplainerKnowledgeService {
  constructor(private db: Database) {}

  /** FR-021: canonical chunking of the latest published bundle per repo. */
  chunkBundle(bundleId: string): ExplainerChunk[] {
    const row = this.db.prepare('SELECT * FROM explainer_bundles WHERE id = ?').get(bundleId) as any;
    if (!row) return [];
    const task = this.db.prepare(
      `SELECT t.id, COALESCE(dr.full_name, REPLACE(REPLACE(t.remote_url, 'https://github.com/', ''), '.git', '')) AS full_name
       FROM explainer_tasks t LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
       WHERE t.id = ?`,
    ).get(row.task_id) as any;
    const repoFullName = task?.full_name ?? row.task_id;
    const bundleVersion = row.id;
    // Freshness anchored to bundle creation (review fix): validity = created_at + 7d.
    // Recomputing from "now" here would resurrect stale bundles on every re-chunk.
    const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
    const validUntil = new Date(createdMs + 7 * 86_400_000).toISOString();
    const chunks: ExplainerChunk[] = [];
    const meta = JSON.parse(row.metadata || '{}') as Record<string, unknown>;

    let content: any = null;
    if (row.facts_path && existsSync(row.facts_path)) {
      try { content = JSON.parse(readFileSync(row.facts_path, 'utf8')); } catch { content = null; }
    }

    // Fact chunks
    if (Array.isArray(content)) {
      for (const fact of content) {
        chunks.push({
          id: `${bundleId}:fact:${fact.id ?? chunks.length}`,
          repo_full_name: repoFullName,
          chunk_type: 'fact',
          section: null,
          file_path: fact.file_path ?? null,
          line_start: fact.line_start ?? null,
          line_end: fact.line_end ?? null,
          symbol: null,
          text: String(fact.claim ?? ''),
          citation: fact.source_ref ?? null,
          bundle_version: bundleVersion,
          valid_until: validUntil,
        });
      }
    }

    // Section chunks (from sections dir or metadata)
    const sectionsPath = row.sections_path;
    if (sectionsPath && existsSync(sectionsPath)) {
      try {
        const { readdirSync } = require('fs') as typeof import('fs');
        for (const file of readdirSync(sectionsPath)) {
          if (!file.endsWith('.md')) continue;
          const sectionType = file.replace(/\.md$/, '');
          const text = readFileSync(join(sectionsPath, file), 'utf8');
          for (const piece of splitChunk(text)) {
            chunks.push({
              id: `${bundleId}:section:${sectionType}:${chunks.length}`,
              repo_full_name: repoFullName,
              chunk_type: 'section',
              section: sectionType,
              file_path: null, line_start: null, line_end: null, symbol: null,
              text: piece,
              citation: null,
              bundle_version: bundleVersion,
              valid_until: validUntil,
            });
          }
        }
      } catch {
        // unreadable sections — skip
      }
    }

    // AGENTS.md snippet chunk
    const markdownPath = row.markdown_path;
    if (markdownPath && existsSync(markdownPath)) {
      try {
        const md = readFileSync(markdownPath, 'utf8');
        if (chunks.length === 0) {
          for (const piece of splitChunk(md).slice(0, 20)) {
            chunks.push({
              id: `${bundleId}:section:explainer:${chunks.length}`,
              repo_full_name: repoFullName,
              chunk_type: 'section',
              section: 'explainer',
              file_path: null, line_start: null, line_end: null, symbol: null,
              text: piece,
              citation: null,
              bundle_version: bundleVersion,
              valid_until: validUntil,
            });
          }
        }
      } catch {
        // ignore
      }
    }
    void meta;
    return chunks;
  }

  /** FR-022: embed chunks into Qdrant. No-ops on failure; returns count. */
  async embedChunks(chunks: ExplainerChunk[]): Promise<{ embedded: number; qdrant_available: boolean; semantic: boolean }> {
    if (chunks.length === 0) return { embedded: 0, qdrant_available: false, semantic: false };
    // Test-guard: never write unit-test chunks to a real Qdrant instance.
    if (process.env.NODE_ENV === "test") {
      return { embedded: 0, qdrant_available: false, semantic: false };
    }
    try {
      const check = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { headers: qdrantHeaders() });
      if (check.status === 404) {
        await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
          method: 'PUT',
          headers: qdrantHeaders(),
          body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
        });
      }
      // Batch-embed all chunk texts via Ollama (single semantic check for the batch)
      const texts = chunks.map((c) => c.text);
      const vectors = await embedBatch(texts);
      // Never mix vector spaces: lexical fallback vectors (semantic: false) must not
      // enter the semantic collection — they would corrupt ranking even after the
      // real model recovers. The file-bundle keyword fallback covers search instead.
      if (!vectors.semantic) {
        console.warn("⚠️  Knowledge embed skipped: embedding model unavailable; file-bundle keyword search remains the fallback (no lexical vectors written).");
        return { embedded: 0, qdrant_available: true, semantic: false };
      }
      const points = chunks.map((chunk, index) => ({
        id: hashId(chunk.id),
        payload: { ...chunk, point_index: index, embedding_model: OLLAMA_EMBED_MODEL },
        vector: vectors.vectors[index],
      }));
      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
        method: 'PUT',
        headers: qdrantHeaders(),
        body: JSON.stringify({ points }),
      });
      return { embedded: res.ok ? chunks.length : 0, qdrant_available: res.ok, semantic: vectors.semantic };
    } catch {
      return { embedded: 0, qdrant_available: false, semantic: false };
    }
  }

  /** FR-023: search with Qdrant and file-bundle fallback (EC-006). */
  async search(query: string, options: { repo?: string; limit?: number } = {}): Promise<{
    results: SearchResult[];
    degraded: boolean;
  }> {
    // Test-isolation: never hit real Qdrant/Ollama from unit tests (EC-006 degraded path).
    if (process.env.NODE_ENV === "test") {
      return { results: [], degraded: true };
    }
    const limit = options.limit ?? 10;
    // Try Qdrant semantic search first (query embedded with the same model as the chunks).
    // When the embedding model is unavailable (semantic: false), do NOT query with a
    // lexical placeholder vector — that would rank real semantic points arbitrarily.
    const queryEmbed = await embedVector(query);
    if (!queryEmbed.semantic) {
      return { results: this.fileBundleSearch(query, options.repo, limit), degraded: true };
    }
    try {
      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
        method: 'POST',
        headers: qdrantHeaders(),
        body: JSON.stringify({
          vector: queryEmbed.vector,
          limit: limit * 2,
          with_payload: true,
          ...(options.repo ? {
            filter: { must: [{ key: 'repo_full_name', match: { value: options.repo } }] },
          } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const results: SearchResult[] = (data?.result ?? [])
          .filter((hit: any) => hit?.payload?.text)
          .slice(0, limit)
          .map((hit: any) => ({
            chunk: hit.payload as ExplainerChunk,
            score: hit.score ?? 0,
            source: 'qdrant' as const,
          }));
        if (results.length > 0) return { results, degraded: false };
      }
    } catch {
      // fall through to file-bundle search
    }

    return { results: this.fileBundleSearch(query, options.repo, limit), degraded: true };
  }

  /**
   * EC-006 graceful degradation: file-bundle keyword search over chunks of
   * published bundles. Zero external calls — always works from disk + SQLite.
   */
  private fileBundleSearch(query: string, repo: string | undefined, limit: number): SearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const results: SearchResult[] = [];
    const bundles = repo
      ? this.db.prepare(
          `SELECT b.id FROM explainer_bundles b JOIN explainer_tasks t ON t.id = b.task_id
           LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
           WHERE b.status = 'published' AND dr.full_name = ? ORDER BY b.created_at DESC LIMIT 3`,
        ).all(repo) as any[]
      : this.db.prepare(
          `SELECT id FROM explainer_bundles WHERE status = 'published' ORDER BY created_at DESC LIMIT 10`,
        ).all() as any[];
    for (const bundle of bundles) {
      for (const chunk of this.chunkBundle(bundle.id)) {
        const text = chunk.text.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (text.includes(term)) score += 1;
        }
        if (score > 0) results.push({ chunk, score: score / terms.length, source: 'file_bundle' });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * EC-005 hardening: remove a bundle's points from Qdrant so unpublishing
   * genuinely pulls the content from knowledge search and grounded Q&A.
   * Best-effort; returns true when the purge succeeded.
   */
  async deleteBundleChunks(bundleId: string): Promise<boolean> {
    try {
      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete?wait=true`, {
        method: "POST",
        headers: qdrantHeaders(),
        body: JSON.stringify({ filter: { must: [{ key: "bundle_version", match: { value: bundleId } }] } }),
      });
      if (!res.ok) return false;
      // points/delete gives no count — confirm via scroll (0 remaining = purged)
      const countRes = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
        method: "POST",
        headers: qdrantHeaders(),
        body: JSON.stringify({ filter: { must: [{ key: "bundle_version", match: { value: bundleId } }] }, limit: 1, with_payload: false }),
      });
      if (!countRes.ok) return false;
      const data = (await countRes.json()) as { result?: { points?: unknown[] } };
      return (data.result?.points?.length ?? 0) === 0;
    } catch {
      return false;
    }
  }

  /** Get one fact by id across published bundles. */
  getFact(factId: string): { chunk: ExplainerChunk } | null {
    const bundles = this.db.prepare(
      `SELECT id FROM explainer_bundles WHERE status = 'published' ORDER BY created_at DESC LIMIT 20`,
    ).all() as any[];
    for (const bundle of bundles) {
      for (const chunk of this.chunkBundle(bundle.id)) {
        if (chunk.id.endsWith(`:fact:${factId}`) || chunk.id === factId) {
          return { chunk };
        }
      }
    }
    return null;
  }

  /** List repos that have published bundles (for cross-repo layer / FT-024 manifest). */
  listKnowledgeRepos(): string[] {
    const rows = this.db.prepare(
      `SELECT COALESCE(dr.full_name, t.remote_url) AS full_name
       FROM explainer_bundles b JOIN explainer_tasks t ON t.id = b.task_id
       LEFT JOIN discovered_repositories dr ON dr.id = t.discovered_repository_id
       WHERE b.status = 'published' AND full_name IS NOT NULL
       GROUP BY full_name ORDER BY full_name`,
    ).all() as any[];
    return rows.map((r: any) => r.full_name);
  }
}

function splitChunk(text: string): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > CHUNK_MAX_CHARS && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Deterministic numeric id for a chunk key (Qdrant wants u64). */
function hashId(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/**
 * Batch-embed multiple texts in one /api/embed call. Falls back to per-text
 * lexical placeholders if the endpoint or model is unavailable.
 */
async function embedBatch(texts: string[]): Promise<{ vectors: number[][]; semantic: boolean }> {
  try {
    const res = await fetch(`${OLLAMA_EMBED_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts.map((t) => t.slice(0, 2000)) }),
    });
    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] };
      if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
        return { vectors: data.embeddings.map(normalize), semantic: true };
      }
    }
  } catch {
    // fall through
  }
  return { vectors: texts.map((t) => zeroVector(t)), semantic: false };
}

/**
 * ponytail superseeded: zeroVector retained only as fallback. Real semantic
 * embeddings flow through embedBatch/embedVector via Ollama /api/embed with
 * model snowflake-arctic-embed:s (384d). Fallback keeps the system alive
 * when the embedding endpoint (or model) is unavailable.
 */
function zeroVector(text: string): number[] {
  const vector = new Array(VECTOR_SIZE).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const index = hashId(words[i]) % VECTOR_SIZE;
    vector[index] += 1 / Math.sqrt(words.length + 1);
  }
  return vector;
}

/**
 * Embed text via Ollama /api/embed; falls back to the lexical placeholder on
 * any failure (model missing, server down). Non-throwing by design.
 */
async function embedVector(text: string): Promise<{ vector: number[]; semantic: boolean }> {
  try {
    const res = await fetch(`${OLLAMA_EMBED_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text.slice(0, 2000) }),
    });
    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] };
      const vector = data.embeddings?.[0];
      if (Array.isArray(vector) && vector.length > 0) {
        return { vector: normalize(vector), semantic: true };
      }
    }
  } catch {
    // fall through to lexical placeholder
  }
  return { vector: zeroVector(text), semantic: false };
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vector.map((v) => v / norm) : vector;
}