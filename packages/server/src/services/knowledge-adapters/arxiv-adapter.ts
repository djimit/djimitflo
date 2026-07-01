import { randomUUID } from 'crypto';
import type { KnowledgeResult, KnowledgeSourceAdapter } from './types';

export class ArxivAdapter implements KnowledgeSourceAdapter {
  name = 'arxiv';
  private baseUrl = 'http://export.arxiv.org/api/query';
  private rateLimitMs = 6000; // 10 req/min
  private lastRequest = 0;

  async search(query: string, limit: number = 5): Promise<KnowledgeResult[]> {
    await this.enforceRateLimit();

    try {
      const params = new URLSearchParams({
        search_query: `all:${query}`,
        max_results: String(limit),
        start: '0',
      });

      const response = await fetch(`${this.baseUrl}?${params}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return [];

      const text = await response.text();
      return this.parseArxivResponse(text);
    } catch {
      return [];
    }
  }

  async fetch(id: string): Promise<KnowledgeResult | null> {
    await this.enforceRateLimit();

    try {
      const response = await fetch(`${this.baseUrl}?id_list=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return null;

      const text = await response.text();
      const results = this.parseArxivResponse(text);
      return results[0] ?? null;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}?search_query=all:test&max_results=1`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private parseArxivResponse(xml: string): KnowledgeResult[] {
    const results: KnowledgeResult[] = [];
    const entries = xml.split('<entry>').slice(1);

    for (const entry of entries) {
      const title = this.extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim();
      const summary = this.extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim();
      const id = this.extractTag(entry, 'id');
      const authors = (entry.match(/<name>/g) || []).length;

      if (title && summary) {
        results.push({
          id: randomUUID(),
          title,
          content: summary,
          source: this.name,
          url: id ?? undefined,
          confidence: 0.9,
          metadata: {
            authors,
            type: 'academic-paper',
            arxiv_id: id?.split('/abs/').pop(),
          },
        });
      }
    }

    return results;
  }

  private extractTag(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'));
    return match?.[1]?.trim() ?? null;
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
