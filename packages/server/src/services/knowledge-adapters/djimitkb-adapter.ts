import { randomUUID } from 'crypto';
import type { KnowledgeResult, KnowledgeSourceAdapter } from './types';

export class DjimitKBAdapter implements KnowledgeSourceAdapter {
  name = 'djimitkb';
  private baseUrl: string;
  private rateLimitMs = 6000;
  private lastRequest = 0;

  constructor() {
    this.baseUrl = process.env.DJIMITKB_URL || 'http://192.168.1.28:8007';
  }

  async search(query: string, limit: number = 5): Promise<KnowledgeResult[]> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(`${this.baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return [];

      const data = await response.json() as {
        results?: Array<{ id?: string; title?: string; content?: string; source?: string; url?: string; score?: number }>;
      };

      if (!data.results) return [];

      return data.results.slice(0, limit).map(r => ({
        id: r.id || randomUUID(),
        title: r.title || 'Untitled',
        content: r.content || '',
        source: this.name,
        url: r.url,
        confidence: (r.score ?? 0.5) * 0.5,
        metadata: {
          original_source: r.source,
          type: 'knowledge-chunk',
        },
      }));
    } catch {
      return [];
    }
  }

  async fetch(id: string): Promise<KnowledgeResult | null> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(`${this.baseUrl}/api/fetch/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return null;

      const data = await response.json() as { id?: string; title?: string; content?: string; url?: string; score?: number };

      return {
        id: data.id || randomUUID(),
        title: data.title || 'Untitled',
        content: data.content || '',
        source: this.name,
        url: data.url,
        confidence: (data.score ?? 0.5) * 0.5,
        metadata: { type: 'knowledge-chunk' },
      };
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.rateLimitMs) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitMs - elapsed));
    }
    this.lastRequest = Date.now();
  }
}
