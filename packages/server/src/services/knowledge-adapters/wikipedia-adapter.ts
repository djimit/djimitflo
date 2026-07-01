import { randomUUID } from 'crypto';
import type { KnowledgeResult, KnowledgeSourceAdapter } from './types';

export class WikipediaAdapter implements KnowledgeSourceAdapter {
  name = 'wikipedia';
  private baseUrl = 'https://en.wikipedia.org/api/rest_v1';
  private rateLimitMs = 6000; // 10 req/min
  private lastRequest = 0;

  async search(query: string, _limit: number = 5): Promise<KnowledgeResult[]> {
    await this.enforceRateLimit();

    try {
      const title = encodeURIComponent(query);
      const response = await fetch(`${this.baseUrl}/page/summary/${title}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) return [];

      const data = await response.json() as {
        title?: string;
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
        thumbnail?: { source?: string };
      };

      if (!data.title || !data.extract) return [];

      return [{
        id: randomUUID(),
        title: data.title,
        content: data.extract,
        source: this.name,
        url: data.content_urls?.desktop?.page,
        confidence: 0.7,
        metadata: {
          thumbnail: data.thumbnail?.source,
          type: 'summary',
        },
      }];
    } catch {
      return [];
    }
  }

  async fetch(id: string): Promise<KnowledgeResult | null> {
    return this.search(id, 1).then(results => results[0] ?? null);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/page/summary/Earth`, {
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
