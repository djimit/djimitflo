/**
 * DataCite DOI adapter (Tier-1 scholarly evidence, §10). DataCite mints the arXiv DOIs (10.48550/arxiv.*), so a
 * creators.name query returns arXiv-native records with category codes, abstracts and author lists — the data
 * arXiv's own export API serves, without its throttling. Same paper shape as the arXiv adapter.
 */
import type { ArxivPaper } from './arxiv-adapter';
import { authorDisplayName } from './openalex-adapter';

interface DataCiteRecord {
  attributes: {
    doi?: string; titles?: Array<{ title?: string }>; creators?: Array<{ name?: string; givenName?: string; familyName?: string }>;
    subjects?: Array<{ subject?: string }>; descriptions?: Array<{ description?: string; descriptionType?: string }>;
    publicationYear?: number; dates?: Array<{ date?: string; dateType?: string }>; publisher?: string; url?: string;
  };
}

/** "Jan Leike" → "Leike, Jan" (DataCite creator form); already-comma names pass through. */
export function dataCiteName(name: string): string {
  if (name.includes(',')) return name.trim();
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}` : name.trim();
}

/** Pure mapping so it can be tested on a saved response; duplicates (same title) collapse onto the first hit. */
export function parseDataCiteRecords(payload: { data?: DataCiteRecord[] }): ArxivPaper[] {
  const seen = new Set<string>();
  const papers: ArxivPaper[] = [];
  for (const record of payload.data ?? []) {
    const a = record.attributes;
    const title = (a.titles?.[0]?.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const arxiv = a.doi?.match(/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i)?.[1];
    const codes = (a.subjects ?? []).map((item) => item.subject?.match(/\(([a-z-]+\.[A-Za-z-]+)\)\s*$/)?.[1]).filter((code): code is string => Boolean(code));
    const labels = (a.subjects ?? []).map((item) => item.subject ?? '').filter((label) => label && !/^FOS:/.test(label));
    const categories = [...new Set([...codes, ...labels])];
    const issued = a.dates?.find((item) => item.dateType === 'Issued')?.date ?? (a.publicationYear ? String(a.publicationYear) : null);
    papers.push({
      arxiv_id: arxiv ?? (a.doi ? `doi:${a.doi}` : title), url: arxiv ? `https://arxiv.org/abs/${arxiv}` : a.url || (a.doi ? `https://doi.org/${a.doi}` : ''), title,
      summary: (a.descriptions?.find((item) => item.descriptionType === 'Abstract') ?? a.descriptions?.[0])?.description?.replace(/\s+/g, ' ').slice(0, 4_000) ?? '',
      authors: (a.creators ?? []).map((creator) => authorDisplayName(creator.name || [creator.givenName, creator.familyName].filter(Boolean).join(' '))).filter(Boolean),
      categories, primary_category: codes[0] ?? categories[0] ?? null, published: issued,
    });
  }
  return papers;
}

export class DataCiteAdapter {
  name = 'datacite';
  private baseUrl = 'https://api.datacite.org/dois';
  private rateLimitMs = 1_000;
  private lastRequest = 0;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Newest DOIs naming the person as creator; throws DATACITE_HTTP_<status> so "unavailable" ≠ "no papers" (I10). */
  async searchAuthorPapers(name: string, limit: number = 10): Promise<ArxivPaper[]> {
    const wait = this.lastRequest + this.rateLimitMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequest = Date.now();
    const quoted = (value: string) => `"${value.replace(/["\\]/g, ' ').trim()}"`;
    const params = new URLSearchParams({ query: `creators.name:(${quoted(dataCiteName(name))} OR ${quoted(name)})`, 'page[size]': String(Math.min(50, limit * 2)), sort: '-created' });
    const response = await this.fetchImpl(`${this.baseUrl}?${params}`, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/vnd.api+json' } });
    if (!response.ok) throw new Error(`DATACITE_HTTP_${response.status}`);
    return parseDataCiteRecords(await response.json() as { data?: DataCiteRecord[] }).slice(0, limit);
  }
}
