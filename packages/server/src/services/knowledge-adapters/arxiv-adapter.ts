import { randomUUID } from 'crypto';
import type { KnowledgeResult, KnowledgeSourceAdapter } from './types';

// arXiv treats an unquoted multi-term query as an implicit OR (hundreds of thousands of hits,
// ranked loosely); requiring every term with AND is what a scholarly lookup expects.
// ponytail: term-level AND only; add phrase/title boosting if precision is still short.
export function toArxivQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter((term) => term.length > 1);
  return terms.length ? terms.map((term) => `all:${term}`).join(' AND ') : `all:${query.trim()}`;
}

/** Author-centric view of an arXiv entry, used for expert evidence enrichment. */
export interface ArxivPaper {
  arxiv_id: string;
  url: string;
  title: string;
  summary: string;
  authors: string[];
  categories: string[];
  primary_category: string | null;
  published: string | null;
}

/** Pure Atom parser for the author view; exported so enrichment can be tested without the network. */
export function parseArxivPapers(xml: string): ArxivPaper[] {
  const decode = (text: string) => text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const tag = (entry: string, name: string) => { const match = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return match ? decode(match[1].replace(/\s+/g, ' ').trim()) : null; };
  return xml.split('<entry>').slice(1).map((entry) => {
    const id = tag(entry, 'id') || '';
    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((match) => decode(match[1].replace(/\s+/g, ' ').trim()));
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((match) => match[1]);
    const primary = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
    return {
      arxiv_id: id.split('/abs/').pop() || id, url: id, title: tag(entry, 'title') || '', summary: tag(entry, 'summary') || '',
      authors, categories, primary_category: primary ? primary[1] : categories[0] ?? null, published: tag(entry, 'published'),
    };
  }).filter((paper) => paper.title && paper.arxiv_id);
}

export class ArxivAdapter implements KnowledgeSourceAdapter {
  name = 'arxiv';
  // arXiv now answers http with a 301 to https; go straight to https so redirects cannot drop the query.
  private baseUrl = 'https://export.arxiv.org/api/query';
  private rateLimitMs = 6000; // 10 req/min
  private lastRequest = 0;

  /** Papers listing the given person as an author (`au:"First Last"`), newest first. Empty on any failure. */
  async searchAuthorPapers(name: string, limit: number = 10): Promise<ArxivPaper[]> {
    await this.enforceRateLimit();
    try {
      const params = new URLSearchParams({ search_query: `au:"${name.replace(/"/g, '')}"`, max_results: String(limit), start: '0', sortBy: 'submittedDate', sortOrder: 'descending' });
      const response = await fetch(`${this.baseUrl}?${params}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return [];
      return parseArxivPapers(await response.text());
    } catch {
      return [];
    }
  }

  async search(query: string, limit: number = 5): Promise<KnowledgeResult[]> {
    await this.enforceRateLimit();

    try {
      const params = new URLSearchParams({
        search_query: toArxivQuery(query),
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
