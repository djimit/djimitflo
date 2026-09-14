/**
 * OpenAlex author-works adapter (Tier-1 scholarly evidence, §10). Same paper shape as the arXiv adapter so the
 * enrichment service can use either source. Free API, ~10 req/s allowed; we stay at one request per second.
 * Works carry OpenAlex topics (field / subfield / topic names) instead of arXiv category codes.
 */
import type { ArxivPaper } from './arxiv-adapter';

interface OpenAlexWork {
  id: string; doi?: string | null; title?: string | null; publication_date?: string | null;
  authorships?: Array<{ raw_author_name?: string | null; author?: { display_name?: string | null } | null }>;
  primary_topic?: { display_name?: string; subfield?: { display_name?: string }; field?: { display_name?: string } } | null;
  topics?: Array<{ display_name?: string }>;
  abstract_inverted_index?: Record<string, number[]> | null;
}

/** "Leike, Jan" → "Jan Leike"; other shapes untouched. */
export function authorDisplayName(raw: string): string {
  const [last, first] = raw.split(',').map((part) => part.trim());
  return first ? `${first} ${last}` : raw.trim();
}

export function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words[position] = word;
  return words.filter(Boolean).join(' ');
}

/** Pure mapping so it can be tested on a saved response; duplicates (same title) collapse onto the first hit. */
export function parseOpenAlexWorks(payload: { results?: OpenAlexWork[] }): ArxivPaper[] {
  const seen = new Set<string>();
  const papers: ArxivPaper[] = [];
  for (const work of payload.results ?? []) {
    const title = (work.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const arxiv = work.doi?.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i)?.[1];
    const url = arxiv ? `https://arxiv.org/abs/${arxiv}` : work.doi || work.id;
    const topic = work.primary_topic ?? null;
    const categories = [...new Set([topic?.display_name, topic?.subfield?.display_name, topic?.field?.display_name, ...(work.topics ?? []).map((item) => item.display_name)].filter((item): item is string => Boolean(item)))];
    papers.push({
      arxiv_id: arxiv ?? work.id.replace('https://openalex.org/', 'openalex:'), url, title, summary: abstractFromInvertedIndex(work.abstract_inverted_index).slice(0, 4_000),
      authors: (work.authorships ?? []).map((item) => authorDisplayName(item.raw_author_name || item.author?.display_name || '')).filter(Boolean),
      categories, primary_category: topic?.subfield?.display_name ?? categories[0] ?? null, published: work.publication_date ?? null,
    });
  }
  return papers;
}

export class OpenAlexAdapter {
  name = 'openalex';
  private baseUrl = 'https://api.openalex.org/works';
  private rateLimitMs = 1_000;
  private lastRequest = 0;

  /** OPENALEX_MAILTO joins OpenAlex's polite pool (higher, more predictable limits); an organisational contact, never a person's private address. */
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly mailto: string = process.env.OPENALEX_MAILTO || '') {}

  /** Newest works naming the person as an author; throws OPENALEX_HTTP_<status> so "unavailable" ≠ "no papers" (I10). */
  async searchAuthorPapers(name: string, limit: number = 10): Promise<ArxivPaper[]> {
    const wait = this.lastRequest + this.rateLimitMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequest = Date.now();
    const params = new URLSearchParams({
      filter: `raw_author_name.search:${name.replace(/[",]/g, ' ').trim()}`, 'per-page': String(Math.min(50, limit * 2)), sort: 'publication_date:desc',
      select: 'id,doi,title,publication_date,authorships,primary_topic,topics,abstract_inverted_index',
      ...(this.mailto ? { mailto: this.mailto } : {}),
    });
    const response = await this.fetchImpl(`${this.baseUrl}?${params}`, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'djimitflo-frontier-experts (OpenAlex works lookup)' } });
    if (!response.ok) throw new Error(`OPENALEX_HTTP_${response.status}`);
    return parseOpenAlexWorks(await response.json() as { results?: OpenAlexWork[] }).slice(0, limit);
  }
}
