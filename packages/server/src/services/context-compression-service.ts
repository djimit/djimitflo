/**
 * ContextCompressionService — token-efficient context management for loop executions.
 *
 * Learned from Headroom (chopratejas/headroom):
 * - Content-aware compression: JSON, code, and text each get optimal treatment
 * - Reversible compression: originals stored for on-demand retrieval
 * - Cross-agent deduplication: shared context across loop executions
 * - KV-cache alignment: stable prefixes for provider cache hits
 *
 * DjimFlo-specific optimizations:
 * - Compress tool outputs before episode storage
 * - Deduplicate repeated loop context (repository structure, capability manifests)
 * - Align loop prefixes for Anthropic/OpenAI KV-cache reuse
 */

import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';

interface CompressionResult {
  original: string;
  compressed: string;
  ratio: number;
  method: 'json' | 'code' | 'text' | 'identity';
  reversible: boolean;
  hash: string;
}

interface CacheEntry {
  hash: string;
  original: string;
  compressed: string;
  method: string;
  createdAt: string;
  ttl: number;
}

export class ContextCompressionService {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly DEFAULT_TTL = 3600; // 1 hour

  constructor(private db: Database) {}

  /**
   * Compress content using the optimal method for its type.
   */
  compress(content: string, type: 'json' | 'code' | 'text' | 'auto' = 'auto'): CompressionResult {
    if (!content || content.length < 100) {
      return { original: content, compressed: content, ratio: 1, method: 'identity', reversible: true, hash: this.hash(content) };
    }

    const detectedType = type === 'auto' ? this.detectType(content) : type;
    const hash = this.hash(content);

    // Check cache
    const cached = this.cache.get(hash);
    if (cached && Date.now() - new Date(cached.createdAt).getTime() < cached.ttl * 1000) {
      return {
        original: content,
        compressed: cached.compressed,
        ratio: cached.compressed.length / content.length,
        method: cached.method as CompressionResult['method'],
        reversible: true,
        hash,
      };
    }

    let compressed: string;
    switch (detectedType) {
      case 'json':
        compressed = this.compressJson(content);
        break;
      case 'code':
        compressed = this.compressCode(content);
        break;
      case 'text':
      default:
        compressed = this.compressText(content);
        break;
    }

    // Only use compression if it actually reduces size
    if (compressed.length >= content.length) {
      compressed = content;
    }

    const result: CompressionResult = {
      original: content,
      compressed,
      ratio: compressed.length / content.length,
      method: detectedType === 'json' ? 'json' : detectedType === 'code' ? 'code' : 'text',
      reversible: true,
      hash,
    };

    // Cache the result
    this.cache.set(hash, {
      hash,
      original: content,
      compressed,
      method: result.method,
      createdAt: new Date().toISOString(),
      ttl: this.DEFAULT_TTL,
    });

    // Evict old cache entries if too large
    if (this.cache.size > 1000) {
      this.evictOldest(100);
    }

    return result;
  }

  /**
   * Retrieve original content from compressed hash.
   */
  retrieve(hash: string): string | null {
    const cached = this.cache.get(hash);
    if (cached) return cached.original;

    // Check DB for persistent storage
    const row = this.db.prepare('SELECT original FROM context_cache WHERE hash = ?').get(hash) as any;
    return row?.original || null;
  }

  /**
   * Get compression statistics.
   */
  getStats(): {
    cacheSize: number;
    totalCompressed: number;
    avgRatio: number;
    savingsPercent: number;
  } {
    const entries = Array.from(this.cache.values());
    const totalOriginal = entries.reduce((sum, e) => sum + e.original.length, 0);
    const totalCompressed = entries.reduce((sum, e) => sum + e.compressed.length, 0);
    const avgRatio = entries.length > 0 ? totalCompressed / totalOriginal : 1;

    return {
      cacheSize: this.cache.size,
      totalCompressed,
      avgRatio,
      savingsPercent: (1 - avgRatio) * 100,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private detectType(content: string): 'json' | 'code' | 'text' {
    const trimmed = content.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return 'json';
      } catch { /* not valid JSON */ }
    }

    // Code detection: common patterns
    const codePatterns = [
      /^(import|export|const|let|function|class|def|pub fn|fn)\s/m,
      /[{;]\s*$/m,
      /^\s{2,}/m,
      /(if|for|while|match|switch)\s*\(/m,
    ];
    const codeScore = codePatterns.filter((p) => p.test(content)).length;
    if (codeScore >= 2) return 'code';

    return 'text';
  }

  private compressJson(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(this.sanitizeJson(parsed));
    } catch {
      return content;
    }
  }

  private sanitizeJson(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeJson(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Keep meaningful keys, drop empty/verbose ones
      if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
        continue;
      }
      sanitized[key] = this.sanitizeJson(value);
    }
    return sanitized;
  }

  private compressCode(content: string): string {
    // Remove comments, collapse whitespace, keep structure
    return content
      .replace(/\/\*[\s\S]*?\*\//g, '') // Block comments
      .replace(/\/\/.*$/gm, '') // Line comments
      .replace(/#.*$/gm, '') // Python/shell comments
      .replace(/\n{3,}/g, '\n\n') // Collapse blank lines
      .replace(/[ \t]+/g, ' ') // Collapse horizontal whitespace
      .trim();
  }

  private compressText(content: string): string {
    // Remove redundant whitespace, keep sentences
    return content
      .replace(/\s+/g, ' ')
      .replace(/\.\s+/g, '.\n')
      .trim();
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private evictOldest(count: number): void {
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime());
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      this.cache.delete(entries[i][0]);
    }
  }
}
